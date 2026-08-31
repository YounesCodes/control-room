use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use parking_lot::{Condvar, Mutex};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{AppHandle, Emitter, Manager, ipc::Channel, ipc::Response};
use uuid::Uuid;

use crate::{
    database::Database,
    models::{
        ConnectionDiagnostic, ConnectionDiagnosticStage, SavedConnection, SessionStarted,
        SessionStateEvent,
    },
    ssh::{connection_arguments, detect_ssh_path},
};

struct ManagedSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output_flow: OutputFlow,
    stop_requested: AtomicBool,
    connected_emitted: AtomicBool,
    failure: Mutex<Option<String>>,
    failure_detector: Mutex<TerminalFailureDetector>,
}

const MAX_UNACKNOWLEDGED_OUTPUT_BYTES: usize = 512 * 1024;

struct OutputFlow {
    state: Mutex<OutputFlowState>,
    available: Condvar,
}

struct OutputFlowState {
    unacknowledged_bytes: usize,
    closed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalFailureHint {
    Configuration,
    Authentication,
    HostResolution,
    ConnectionRefused,
    ConnectionTimeout,
    HostKey,
    Negotiation,
    Route,
    ConnectionLost,
}

#[derive(Default)]
struct TerminalFailureDetector {
    tail: String,
    hint: Option<TerminalFailureHint>,
    connected: bool,
}

const CONNECTED_MARKER: &str = "\u{1b}]633;ControlRoom;connected\u{7}";

impl TerminalFailureDetector {
    fn observe(&mut self, bytes: &[u8]) {
        let chunk = String::from_utf8_lossy(bytes).to_ascii_lowercase();
        let combined = format!("{}{chunk}", self.tail);
        self.hint = detect_terminal_failure(&combined).or(self.hint);
        self.connected |= combined.contains(&CONNECTED_MARKER.to_ascii_lowercase());
        self.tail = combined
            .chars()
            .rev()
            .take(512)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
}

impl OutputFlow {
    fn new() -> Self {
        Self {
            state: Mutex::new(OutputFlowState {
                unacknowledged_bytes: 0,
                closed: false,
            }),
            available: Condvar::new(),
        }
    }

    fn reserve(&self, bytes: usize) -> bool {
        let mut state = self.state.lock();
        while !state.closed
            && state.unacknowledged_bytes.saturating_add(bytes) > MAX_UNACKNOWLEDGED_OUTPUT_BYTES
        {
            self.available.wait(&mut state);
        }
        if state.closed {
            return false;
        }
        state.unacknowledged_bytes += bytes;
        true
    }

    fn acknowledge(&self, bytes: usize) {
        let mut state = self.state.lock();
        state.unacknowledged_bytes = state.unacknowledged_bytes.saturating_sub(bytes);
        self.available.notify_all();
    }

    fn close(&self) {
        let mut state = self.state.lock();
        state.closed = true;
        self.available.notify_all();
    }
}

#[derive(Clone, Default)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
}

impl SessionManager {
    pub fn start(
        &self,
        app: AppHandle,
        connection: &SavedConnection,
        cols: u16,
        rows: u16,
        output: Channel<Response>,
    ) -> Result<SessionStarted, String> {
        let ssh_path = detect_ssh_path().ok_or_else(|| {
            "Windows OpenSSH client was not found. Install the OpenSSH Client optional feature."
                .to_string()
        })?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.clamp(2, 500),
                cols: cols.clamp(2, 1_000),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("PTY initialization failed: {error}"))?;

        let mut command = CommandBuilder::new(ssh_path);
        command.args(connection_arguments(connection, true));
        command.arg(interactive_shell_command(connection.history_enabled));
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("SSH process could not start: {error}"))?;
        drop(pair.slave);

        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("PTY output could not be opened: {error}"));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("PTY input could not be opened: {error}"));
            }
        };
        let killer = child.clone_killer();
        let session_id = Uuid::new_v4().to_string();
        let managed = Arc::new(ManagedSession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            output_flow: OutputFlow::new(),
            stop_requested: AtomicBool::new(false),
            connected_emitted: AtomicBool::new(false),
            failure: Mutex::new(None),
            failure_detector: Mutex::new(TerminalFailureDetector::default()),
        });
        self.sessions
            .lock()
            .insert(session_id.clone(), managed.clone());

        let output_session_id = session_id.clone();
        let output_connection_id = connection.id.clone();
        let output_app = app.clone();
        let output_managed = managed.clone();
        thread::spawn(move || {
            let mut buffer = vec![0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let (startup_failure, connected) = {
                            let mut detector = output_managed.failure_detector.lock();
                            detector.observe(&buffer[..count]);
                            (detector.hint.is_some(), detector.connected)
                        };
                        if connected
                            && !startup_failure
                            && !output_managed
                                .connected_emitted
                                .swap(true, Ordering::AcqRel)
                        {
                            let _ = output_app
                                .state::<Database>()
                                .mark_connected(&output_connection_id);
                            emit_state(
                                &output_app,
                                &output_session_id,
                                "connected",
                                None,
                                None,
                                None,
                            );
                        }
                        if !output_managed.output_flow.reserve(count) {
                            break;
                        }
                        if output
                            .send(Response::new(buffer[..count].to_vec()))
                            .is_err()
                        {
                            if !output_managed.stop_requested.load(Ordering::Acquire) {
                                *output_managed.failure.lock() =
                                    Some("Terminal output channel closed".into());
                            }
                            output_managed.output_flow.close();
                            let _ = output_managed.killer.lock().kill();
                            break;
                        }
                    }
                    Err(error) => {
                        *output_managed.failure.lock() =
                            Some(format!("Terminal output failed: {error}"));
                        output_managed.output_flow.close();
                        let _ = output_managed.killer.lock().kill();
                        break;
                    }
                }
            }
        });

        let wait_session_id = session_id.clone();
        let wait_app = app;
        let sessions = self.sessions.clone();
        let wait_managed = managed;
        thread::spawn(move || {
            let result = child.wait();
            wait_managed.output_flow.close();
            sessions.lock().remove(&wait_session_id);
            match result {
                Ok(status) => {
                    let failure = wait_managed.failure.lock().clone();
                    let detector = wait_managed.failure_detector.lock();
                    let hint = detector.hint;
                    let connected = detector.connected;
                    drop(detector);
                    let (state, category, reason, diagnostic) = classify_session_exit(
                        wait_managed.stop_requested.load(Ordering::Acquire),
                        failure,
                        status.success(),
                        status.exit_code(),
                        hint,
                        connected,
                    );
                    emit_state(
                        &wait_app,
                        &wait_session_id,
                        state,
                        category,
                        reason,
                        diagnostic,
                    );
                }
                Err(error) => emit_state(
                    &wait_app,
                    &wait_session_id,
                    "error",
                    Some("process".into()),
                    Some(format!("SSH process wait failed: {error}")),
                    Some(connection_diagnostic(None, false)),
                ),
            }
        });

        Ok(SessionStarted {
            session_id,
            connection_id: connection.id.clone(),
        })
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self.get(session_id)?;
        let mut writer = session.writer.lock();
        writer.write_all(data).map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.get(session_id)?;
        session
            .master
            .lock()
            .resize(PtySize {
                rows: rows.clamp(2, 500),
                cols: cols.clamp(2, 1_000),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    pub fn acknowledge_output(&self, session_id: &str, bytes: usize) {
        if let Some(session) = self.sessions.lock().get(session_id).cloned() {
            session.output_flow.acknowledge(bytes);
        }
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self.get(session_id)?;
        session.stop_requested.store(true, Ordering::Release);
        session.output_flow.close();
        map_pty_kill_result(session.killer.lock().kill())
    }

    pub fn close_all(&self) {
        for session in self.sessions.lock().values() {
            session.stop_requested.store(true, Ordering::Release);
            session.output_flow.close();
            let _ = session.killer.lock().kill();
        }
    }

    fn get(&self, session_id: &str) -> Result<Arc<ManagedSession>, String> {
        self.sessions
            .lock()
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Terminal Session is no longer active".into())
    }
}

fn interactive_shell_command(history_enabled: bool) -> &'static str {
    if history_enabled {
        "printf '\\033]633;ControlRoom;connected\\007'; CONTROL_ROOM_SHELL_INTEGRATION=1 exec bash -i"
    } else {
        "printf '\\033]633;ControlRoom;connected\\007'; exec \"${SHELL:-/bin/bash}\" -l"
    }
}

fn map_pty_kill_result(result: std::io::Result<()>) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(error) if error.raw_os_error() == Some(0) => Ok(()),
        Err(error) => Err(format!("Could not close SSH process: {error}")),
    }
}

fn emit_state(
    app: &AppHandle,
    session_id: &str,
    state: &str,
    category: Option<String>,
    reason: Option<String>,
    diagnostic: Option<ConnectionDiagnostic>,
) {
    let _ = app.emit(
        "session-state-changed",
        SessionStateEvent {
            session_id: session_id.into(),
            state: state.into(),
            category,
            reason,
            diagnostic,
        },
    );
}

fn detect_terminal_failure(output: &str) -> Option<TerminalFailureHint> {
    if output.contains("bad configuration option")
        || output.contains("terminating, 1 bad configuration options")
    {
        Some(TerminalFailureHint::Configuration)
    } else if output.contains("permission denied") || output.contains("authentication failed") {
        Some(TerminalFailureHint::Authentication)
    } else if output.contains("could not resolve hostname") {
        Some(TerminalFailureHint::HostResolution)
    } else if output.contains("connection refused") {
        Some(TerminalFailureHint::ConnectionRefused)
    } else if output.contains("connection timed out") || output.contains("operation timed out") {
        Some(TerminalFailureHint::ConnectionTimeout)
    } else if output.contains("host key verification failed") {
        Some(TerminalFailureHint::HostKey)
    } else if output.contains("no matching host key type found")
        || output.contains("no matching key exchange method found")
        || output.contains("no matching cipher found")
        || output.contains("kex_exchange_identification")
    {
        Some(TerminalFailureHint::Negotiation)
    } else if output.contains("stdio forwarding failed")
        || output.contains("proxycommand") && output.contains("failed")
        || output.contains("connection closed by unknown port 65535")
    {
        Some(TerminalFailureHint::Route)
    } else if output.contains("connection reset")
        || output.contains("broken pipe")
        || output.contains("connection closed")
        || output.contains("remote host has closed")
    {
        Some(TerminalFailureHint::ConnectionLost)
    } else {
        None
    }
}

fn classify_session_exit(
    stop_requested: bool,
    process_failure: Option<String>,
    success: bool,
    exit_code: u32,
    hint: Option<TerminalFailureHint>,
    connected: bool,
) -> (
    &'static str,
    Option<String>,
    Option<String>,
    Option<ConnectionDiagnostic>,
) {
    if stop_requested {
        return ("disconnected", Some("user-disconnect".into()), None, None);
    }
    if let Some(reason) = process_failure {
        return (
            "error",
            Some("process".into()),
            Some(reason),
            Some(connection_diagnostic(None, connected)),
        );
    }
    if success {
        return ("disconnected", Some("remote-exit".into()), None, None);
    }
    if connected && hint != Some(TerminalFailureHint::ConnectionLost) {
        return (
            "error",
            Some("remote-exit".into()),
            Some(format!(
                "SSH session ended unexpectedly (exit code {exit_code})"
            )),
            None,
        );
    }
    let (category, reason) = match hint {
        Some(TerminalFailureHint::Configuration) => {
            ("configuration", "OpenSSH client configuration failed")
        }
        Some(TerminalFailureHint::Authentication) => {
            ("authentication", "SSH authentication failed")
        }
        Some(TerminalFailureHint::HostResolution) => {
            ("host-resolution", "SSH host could not be resolved")
        }
        Some(TerminalFailureHint::ConnectionRefused) => {
            ("connection-refused", "SSH connection was refused")
        }
        Some(TerminalFailureHint::ConnectionTimeout) => {
            ("connection-timeout", "SSH connection timed out")
        }
        Some(TerminalFailureHint::HostKey) => ("host-key", "SSH host-key verification failed"),
        Some(TerminalFailureHint::Negotiation) => ("negotiation", "SSH negotiation failed"),
        Some(TerminalFailureHint::Route) => ("route", "SSH route or jump host failed"),
        Some(TerminalFailureHint::ConnectionLost) => ("connection-lost", "SSH connection was lost"),
        None => ("remote-exit", "SSH session ended unexpectedly"),
    };
    let diagnostic = connection_diagnostic(hint, connected);
    (
        "error",
        Some(category.into()),
        Some(format!("{reason} (exit code {exit_code})")),
        Some(diagnostic),
    )
}

fn connection_diagnostic(
    hint: Option<TerminalFailureHint>,
    connected: bool,
) -> ConnectionDiagnostic {
    use TerminalFailureHint as Hint;

    let (category, summary, detail, statuses) = if connected {
        (
            "connection-lost",
            "The SSH session ended after connecting.",
            "OpenSSH: connection closed after the remote shell started.",
            ["established"; 6],
        )
    } else {
        match hint {
            Some(Hint::Configuration) => (
                "configuration",
                "OpenSSH rejected the local client configuration.",
                "OpenSSH: client configuration could not be used.",
                [
                    "failed",
                    "not-established",
                    "not-established",
                    "not-established",
                    "not-established",
                    "not-established",
                ],
            ),
            Some(Hint::HostResolution) => (
                "host-resolution",
                "The configured SSH destination could not be resolved.",
                "OpenSSH: could not resolve the configured hostname.",
                [
                    "established",
                    "failed",
                    "not-established",
                    "not-established",
                    "not-established",
                    "not-established",
                ],
            ),
            Some(Hint::ConnectionRefused) => (
                "connection-refused",
                "The destination refused the SSH transport connection.",
                "OpenSSH: connection refused.",
                [
                    "established",
                    "established",
                    "failed",
                    "not-established",
                    "not-established",
                    "not-established",
                ],
            ),
            Some(Hint::ConnectionTimeout) => (
                "connection-timeout",
                "The SSH transport connection timed out.",
                "OpenSSH: connection timed out.",
                [
                    "established",
                    "established",
                    "failed",
                    "not-established",
                    "not-established",
                    "not-established",
                ],
            ),
            Some(Hint::HostKey) => (
                "host-key",
                "The server host key was not accepted.",
                "OpenSSH: host key verification failed.",
                [
                    "established",
                    "established",
                    "established",
                    "failed",
                    "not-established",
                    "not-established",
                ],
            ),
            Some(Hint::Negotiation) => (
                "negotiation",
                "The client and server could not complete SSH negotiation.",
                "OpenSSH: no compatible or valid negotiation could be completed.",
                [
                    "established",
                    "established",
                    "established",
                    "unknown",
                    "failed",
                    "not-established",
                ],
            ),
            Some(Hint::Authentication) => (
                "authentication",
                "The SSH server rejected authentication.",
                "OpenSSH: permission denied for the offered authentication methods.",
                [
                    "established",
                    "established",
                    "established",
                    "established",
                    "established",
                    "failed",
                ],
            ),
            Some(Hint::Route) => (
                "route",
                "The configured SSH route or jump host failed.",
                "OpenSSH: proxy or jump-host forwarding failed.",
                [
                    "established",
                    "unknown",
                    "unknown",
                    "unknown",
                    "unknown",
                    "not-established",
                ],
            ),
            Some(Hint::ConnectionLost) => (
                "connection-lost",
                "The connection closed before the remote shell started.",
                "OpenSSH: connection closed unexpectedly.",
                [
                    "established",
                    "unknown",
                    "unknown",
                    "unknown",
                    "unknown",
                    "not-established",
                ],
            ),
            None => (
                "unknown",
                "OpenSSH exited without enough recognized evidence to identify a stage.",
                "OpenSSH: unrecognized connection failure.",
                [
                    "unknown", "unknown", "unknown", "unknown", "unknown", "unknown",
                ],
            ),
        }
    };
    let labels = [
        ("configuration", "Client configuration"),
        ("name-resolution", "Name resolution"),
        ("transport", "TCP transport"),
        ("host-key", "Host key"),
        ("negotiation", "SSH negotiation"),
        ("authentication", "Authentication"),
    ];
    ConnectionDiagnostic {
        schema_version: 1,
        category: category.into(),
        summary: summary.into(),
        detail: detail.into(),
        stages: labels
            .into_iter()
            .zip(statuses)
            .map(|((id, label), status)| ConnectionDiagnosticStage {
                id: id.into(),
                label: label.into(),
                status: status.into(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        sync::{Arc, mpsc},
        time::{Duration, Instant},
    };

    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

    use super::{
        MAX_UNACKNOWLEDGED_OUTPUT_BYTES, OutputFlow, TerminalFailureDetector, TerminalFailureHint,
        classify_session_exit, connection_diagnostic, interactive_shell_command,
        map_pty_kill_result,
    };

    #[test]
    #[cfg(windows)]
    fn conpty_success_with_stale_last_error_is_not_shown_as_a_failure() {
        let portable_pty_result = Err(std::io::Error::from_raw_os_error(0));
        assert!(map_pty_kill_result(portable_pty_result).is_ok());
    }

    #[test]
    fn terminal_failure_detection_handles_split_ssh_diagnostics() {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(b"ssh: connect to host laptop port 22: Connection ref");
        detector.observe(b"used\r\n");
        assert_eq!(detector.hint, Some(TerminalFailureHint::ConnectionRefused));
    }

    #[test]
    fn authentication_prompts_do_not_mark_a_terminal_connected() {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(b"user@host's password: ");
        assert!(!detector.connected);
        detector.observe(b"\x1b]633;ControlRoom;con");
        assert!(!detector.connected);
        detector.observe(b"nected\x07");
        assert!(detector.connected);
    }

    #[test]
    fn interactive_shells_emit_the_connection_marker_before_startup() {
        assert!(interactive_shell_command(false).contains("ControlRoom;connected"));
        assert!(interactive_shell_command(false).contains("${SHELL:-/bin/bash}"));
        assert!(interactive_shell_command(true).contains("CONTROL_ROOM_SHELL_INTEGRATION=1"));
    }

    #[test]
    fn user_disconnect_is_not_reported_as_a_failure() {
        assert_eq!(
            classify_session_exit(
                true,
                None,
                false,
                1,
                Some(TerminalFailureHint::ConnectionLost),
                false,
            ),
            ("disconnected", Some("user-disconnect".into()), None, None)
        );
    }

    #[test]
    fn authentication_failure_has_a_distinct_error_category() {
        let (state, category, reason, diagnostic) = classify_session_exit(
            false,
            None,
            false,
            255,
            Some(TerminalFailureHint::Authentication),
            false,
        );
        assert_eq!(state, "error");
        assert_eq!(category.as_deref(), Some("authentication"));
        assert!(reason.unwrap().starts_with("SSH authentication failed"));
        assert_eq!(diagnostic.unwrap().category, "authentication");
    }

    #[test]
    fn remote_shell_text_is_not_reclassified_as_a_connection_failure() {
        let (state, category, reason, diagnostic) = classify_session_exit(
            false,
            None,
            false,
            1,
            Some(TerminalFailureHint::Authentication),
            true,
        );
        assert_eq!(state, "error");
        assert_eq!(category.as_deref(), Some("remote-exit"));
        assert!(reason.unwrap().contains("exit code 1"));
        assert!(diagnostic.is_none());
    }

    #[test]
    fn version_one_openssh_fixtures_only_establish_supported_stages() {
        let fixtures = [
            (
                "C:/Users/alice/.ssh/config line 3: Bad configuration option: IncludeSecrets",
                TerminalFailureHint::Configuration,
                "configuration",
                [
                    "failed",
                    "not-established",
                    "not-established",
                    "not-established",
                    "not-established",
                    "not-established",
                ],
            ),
            (
                "ssh: Could not resolve hostname private.example: No such host is known.",
                TerminalFailureHint::HostResolution,
                "host-resolution",
                [
                    "established",
                    "failed",
                    "not-established",
                    "not-established",
                    "not-established",
                    "not-established",
                ],
            ),
            (
                "ssh: connect to host 192.0.2.8 port 22: Connection refused",
                TerminalFailureHint::ConnectionRefused,
                "connection-refused",
                [
                    "established",
                    "established",
                    "failed",
                    "not-established",
                    "not-established",
                    "not-established",
                ],
            ),
            (
                "Host key verification failed.",
                TerminalFailureHint::HostKey,
                "host-key",
                [
                    "established",
                    "established",
                    "established",
                    "failed",
                    "not-established",
                    "not-established",
                ],
            ),
            (
                "Unable to negotiate with 192.0.2.8: no matching host key type found.",
                TerminalFailureHint::Negotiation,
                "negotiation",
                [
                    "established",
                    "established",
                    "established",
                    "unknown",
                    "failed",
                    "not-established",
                ],
            ),
            (
                "alice@private.example: Permission denied (publickey,password).",
                TerminalFailureHint::Authentication,
                "authentication",
                [
                    "established",
                    "established",
                    "established",
                    "established",
                    "established",
                    "failed",
                ],
            ),
            (
                "channel 0: open failed: connect failed: stdio forwarding failed",
                TerminalFailureHint::Route,
                "route",
                [
                    "established",
                    "unknown",
                    "unknown",
                    "unknown",
                    "unknown",
                    "not-established",
                ],
            ),
        ];

        for (fixture, expected_hint, expected_category, expected_statuses) in fixtures {
            let mut detector = TerminalFailureDetector::default();
            detector.observe(fixture.as_bytes());
            assert_eq!(detector.hint, Some(expected_hint), "fixture: {fixture}");
            let diagnostic = connection_diagnostic(detector.hint, detector.connected);
            assert_eq!(diagnostic.schema_version, 1);
            assert_eq!(diagnostic.category, expected_category);
            assert_eq!(
                diagnostic
                    .stages
                    .iter()
                    .map(|stage| stage.status.as_str())
                    .collect::<Vec<_>>(),
                expected_statuses,
            );
            assert!(!diagnostic.detail.contains("alice"));
            assert!(!diagnostic.detail.contains("private.example"));
            assert!(!diagnostic.detail.contains("C:/Users"));
        }

        let unknown = connection_diagnostic(None, false);
        assert_eq!(unknown.category, "unknown");
        assert!(unknown.stages.iter().all(|stage| stage.status == "unknown"));
    }

    #[test]
    fn terminal_output_waits_for_frontend_acknowledgement() {
        let flow = Arc::new(OutputFlow::new());
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));
        let blocked_flow = flow.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(blocked_flow.reserve(1));
        });

        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        flow.acknowledge(1);
        assert!(receiver.recv_timeout(Duration::from_secs(1)).unwrap());
    }

    #[test]
    fn closing_terminal_output_unblocks_a_waiting_reader() {
        let flow = Arc::new(OutputFlow::new());
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));
        let blocked_flow = flow.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(blocked_flow.reserve(1));
        });

        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        flow.close();
        assert!(!receiver.recv_timeout(Duration::from_secs(1)).unwrap());
    }

    #[test]
    fn conpty_runs_a_console_process() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/Q", "/D", "/C", "echo CONTROL_ROOM_CONPTY_OK"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                let _ = sender.send(buffer[..count].to_vec());
            }
        });
        let first_output = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        if first_output.windows(4).any(|window| window == b"\x1b[6n") {
            writer.write_all(b"\x1b[1;1R").unwrap();
            writer.flush().unwrap();
        }
        let killer = child.clone_killer();
        let (status_sender, status_receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = status_sender.send(child.wait());
        });
        let status = match status_receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(result) => result.unwrap(),
            Err(error) => {
                let mut killer = killer;
                let _ = killer.kill();
                std::thread::sleep(Duration::from_millis(100));
                let output = first_output
                    .iter()
                    .copied()
                    .chain(receiver.try_iter().flatten())
                    .collect::<Vec<_>>();
                panic!(
                    "ConPTY child did not exit: {error}; output={}",
                    String::from_utf8_lossy(&output)
                );
            }
        };
        assert!(status.success());
        let mut output = first_output;
        let output_deadline = Instant::now() + Duration::from_secs(1);
        while !output
            .windows("CONTROL_ROOM_CONPTY_OK".len())
            .any(|window| window == b"CONTROL_ROOM_CONPTY_OK")
            && Instant::now() < output_deadline
        {
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(chunk) => output.extend(chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("CONTROL_ROOM_CONPTY_OK"));
    }

    #[test]
    #[ignore = "requires the explicitly configured Debian SSH fixture"]
    fn conpty_hosts_windows_ssh_against_live_fixture() {
        let ssh_path = crate::ssh::detect_ssh_path().unwrap();
        let host = std::env::var("CONTROL_ROOM_TEST_HOST").unwrap();
        let user = std::env::var("CONTROL_ROOM_TEST_USER").unwrap();
        let target = format!("{user}@{host}");
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command = CommandBuilder::new(ssh_path);
        command.args([
            "-tt",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            &target,
            "printf CONTROL_ROOM_SSH_OK; exit",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (output_sender, output_receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                let _ = output_sender.send(buffer[..count].to_vec());
            }
        });
        let mut killer = child.clone_killer();
        let (status_sender, status_receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = status_sender.send(child.wait());
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut output = Vec::new();
        let mut answered_queries = 0;
        let status = loop {
            if let Ok(chunk) = output_receiver.recv_timeout(Duration::from_millis(100)) {
                output.extend(chunk);
                let query_count = output
                    .windows(4)
                    .filter(|window| *window == b"\x1b[6n")
                    .count();
                while answered_queries < query_count {
                    writer.write_all(b"\x1b[1;1R").unwrap();
                    writer.flush().unwrap();
                    answered_queries += 1;
                }
            }
            if let Ok(result) = status_receiver.try_recv() {
                break result.unwrap();
            }
            if Instant::now() >= deadline {
                let _ = killer.kill();
                panic!(
                    "ConPTY SSH fixture timed out: {}",
                    String::from_utf8_lossy(&output)
                );
            }
        };
        assert!(status.success());
        assert!(String::from_utf8_lossy(&output).contains("CONTROL_ROOM_SSH_OK"));
    }
}
