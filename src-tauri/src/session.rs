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
    local_shell::{self, ResolvedLocalShell},
    models::{LocalSessionStarted, SavedConnection, SessionStarted, SessionStateEvent},
    ssh::{connection_arguments, detect_ssh_path, ssh_not_found_message},
};

#[cfg(target_os = "linux")]
#[path = "session_linux.rs"]
mod linux;

struct ManagedSession {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output_flow: OutputFlow,
    stop_requested: AtomicBool,
    failure: Mutex<Option<String>>,
    mode: SessionMode,
}

enum SessionMode {
    Ssh(RemoteSessionState),
    Local { label: &'static str },
}

struct RemoteSessionState {
    connection_id: String,
    connected_emitted: AtomicBool,
    failure_detector: Mutex<TerminalFailureDetector>,
}

impl SessionMode {
    fn ssh(connection_id: &str) -> Self {
        Self::Ssh(RemoteSessionState {
            connection_id: connection_id.to_string(),
            connected_emitted: AtomicBool::new(false),
            failure_detector: Mutex::new(TerminalFailureDetector::default()),
        })
    }

    fn spawn_error(&self, error: impl std::fmt::Display) -> String {
        match self {
            Self::Ssh(_) => format!("SSH process could not start: {error}"),
            Self::Local { label } => format!("{label} could not be started."),
        }
    }
}

const MAX_UNACKNOWLEDGED_OUTPUT_BYTES: usize = 512 * 1024;

const OUTPUT_READ_BUFFER_BYTES: usize = 16 * 1024;

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
    Authentication,
    HostResolution,
    ConnectionRefused,
    ConnectionTimeout,
    HostKey,
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

    fn established(&self) -> bool {
        self.connected
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
    #[cfg(feature = "desktop-e2e")]
    pub fn e2e_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self.sessions.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn start(
        &self,
        app: AppHandle,
        connection: &SavedConnection,
        remote_command: Option<String>,
        cols: u16,
        rows: u16,
        output: Channel<Response>,
    ) -> Result<SessionStarted, String> {
        let ssh_path = detect_ssh_path().ok_or_else(ssh_not_found_message)?;
        let mut command = CommandBuilder::new(ssh_path);
        #[cfg(target_os = "linux")]
        crate::appimage::configure_pty(&mut command);
        command.env("TERM", TERMINAL_TYPE);
        command.args(connection_arguments(connection, true));
        command.arg(
            remote_command
                .unwrap_or_else(|| interactive_shell_command(connection.history_enabled).into()),
        );
        let session_id = self.spawn(
            app,
            command,
            cols,
            rows,
            output,
            SessionMode::ssh(&connection.id),
        )?;

        Ok(SessionStarted {
            session_id,
            connection_id: connection.id.clone(),
        })
    }

    /// Starts a local shell through the same pty lifecycle as an SSH
    /// session. The profile was validated and resolved by `local_shell`, so
    /// nothing here picks an executable or an argument.
    pub fn start_local(
        &self,
        app: AppHandle,
        shell: &ResolvedLocalShell,
        cols: u16,
        rows: u16,
        output: Channel<Response>,
    ) -> Result<LocalSessionStarted, String> {
        let session_id = self.spawn(
            app,
            local_shell::command_for(shell),
            cols,
            rows,
            output,
            SessionMode::Local {
                label: shell.label(),
            },
        )?;

        Ok(LocalSessionStarted {
            session_id,
            shell_id: shell.id().into(),
        })
    }

    fn spawn(
        &self,
        app: AppHandle,
        command: CommandBuilder,
        cols: u16,
        rows: u16,
        output: Channel<Response>,
        mode: SessionMode,
    ) -> Result<String, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.clamp(2, 500),
                cols: cols.clamp(2, 1_000),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("PTY initialization failed: {error}"))?;

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| mode.spawn_error(error))?;
        drop(pair.slave);

        #[cfg(target_os = "linux")]
        let (mut reader, writer, exit_signal, killer) = match linux::open_io(pair.master.as_ref())
            .and_then(|(reader, writer, signal)| {
                let killer = linux::Killer::new(child.as_ref())?;
                Ok((
                    reader,
                    Box::new(writer),
                    signal,
                    Box::new(killer) as Box<dyn ChildKiller + Send + Sync>,
                ))
            }) {
            Ok(io) => io,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("PTY could not be attached: {error}"));
            }
        };
        #[cfg(not(target_os = "linux"))]
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("PTY output could not be opened: {error}"));
            }
        };
        #[cfg(not(target_os = "linux"))]
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("PTY input could not be opened: {error}"));
            }
        };
        #[cfg(not(target_os = "linux"))]
        let killer = child.clone_killer();
        let session_id = Uuid::new_v4().to_string();
        let managed = Arc::new(ManagedSession {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            output_flow: OutputFlow::new(),
            stop_requested: AtomicBool::new(false),
            failure: Mutex::new(None),
            mode,
        });
        self.sessions
            .lock()
            .insert(session_id.clone(), managed.clone());

        let output_session_id = session_id.clone();
        let output_app = app.clone();
        let output_managed = managed.clone();
        let output_reader = thread::spawn(move || {
            let mut buffer = vec![0_u8; OUTPUT_READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if let SessionMode::Ssh(remote) = &output_managed.mode {
                            let established = {
                                let mut detector = remote.failure_detector.lock();
                                detector.observe(&buffer[..count]);
                                detector.established()
                            };
                            if established && !remote.connected_emitted.swap(true, Ordering::AcqRel)
                            {
                                let _ = output_app
                                    .state::<Database>()
                                    .mark_connected(&remote.connection_id);
                                emit_state(
                                    &output_app,
                                    &output_session_id,
                                    "connected",
                                    None,
                                    None,
                                );
                            }
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
            if result.is_err() {
                let _ = wait_managed.killer.lock().kill();
            }
            #[cfg(target_os = "linux")]
            drop(exit_signal);
            // ConPTY keeps the output pipe open until its master is dropped.
            if let Err(error) = drain_pty_output(
                &wait_managed.master,
                output_reader,
                &wait_managed.output_flow,
            ) {
                *wait_managed.failure.lock() = Some(error);
            }
            sessions.lock().remove(&wait_session_id);
            match result {
                Ok(status) => {
                    let stop_requested = wait_managed.stop_requested.load(Ordering::Acquire);
                    let failure = wait_managed.failure.lock().clone();
                    let (state, category, reason) = match &wait_managed.mode {
                        SessionMode::Ssh(remote) => classify_session_exit(
                            stop_requested,
                            failure,
                            status.success(),
                            status.exit_code(),
                            remote.failure_detector.lock().hint,
                            remote.connected_emitted.load(Ordering::Acquire),
                        ),
                        SessionMode::Local { label } => classify_local_exit(
                            stop_requested,
                            failure,
                            status.success(),
                            status.exit_code(),
                            label,
                        ),
                    };
                    emit_state(&wait_app, &wait_session_id, state, category, reason);
                }
                Err(error) => emit_state(
                    &wait_app,
                    &wait_session_id,
                    "error",
                    Some("process".into()),
                    Some(format!("Terminal process wait failed: {error}")),
                ),
            }
        });

        Ok(session_id)
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
            .as_ref()
            .ok_or_else(|| "Terminal Session is no longer active".to_string())?
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

fn drain_pty_output<T>(
    master: &Mutex<Option<Box<dyn MasterPty + Send>>>,
    reader: thread::JoinHandle<T>,
    flow: &OutputFlow,
) -> Result<T, String> {
    let master = master.lock().take();
    drop(master);
    let result = reader
        .join()
        .map_err(|_| "Terminal output reader panicked".into());
    flow.close();
    result
}

// ssh forwards its own TERM, and an OpenSSH found on PATH sends an empty one.
const TERMINAL_TYPE: &str = "xterm-256color";

fn interactive_shell_command(history_enabled: bool) -> &'static str {
    if history_enabled {
        "printf '\\033]633;ControlRoom;connected\\007'; CONTROL_ROOM_SHELL_INTEGRATION=1 exec bash -i"
    } else {
        "printf '\\033]633;ControlRoom;connected\\007'; exec \"${SHELL:-/bin/bash}\" -l"
    }
}

// portable-pty's Windows child killer inverts its result: success comes back as Err(GetLastError()).
fn map_pty_kill_result(result: std::io::Result<()>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = result;
        Ok(())
    }
    #[cfg(not(windows))]
    result.map_err(|error| format!("Could not close the terminal process: {error}"))
}

fn emit_state(
    app: &AppHandle,
    session_id: &str,
    state: &str,
    category: Option<String>,
    reason: Option<String>,
) {
    let _ = app.emit(
        "session-state-changed",
        SessionStateEvent {
            session_id: session_id.into(),
            state: state.into(),
            category,
            reason,
        },
    );
}

fn detect_terminal_failure(output: &str) -> Option<TerminalFailureHint> {
    if output.contains("permission denied") || output.contains("authentication failed") {
        Some(TerminalFailureHint::Authentication)
    } else if output.contains("could not resolve hostname") {
        Some(TerminalFailureHint::HostResolution)
    } else if output.contains("connection refused") {
        Some(TerminalFailureHint::ConnectionRefused)
    } else if output.contains("connection timed out") || output.contains("operation timed out") {
        Some(TerminalFailureHint::ConnectionTimeout)
    } else if output.contains("host key verification failed") {
        Some(TerminalFailureHint::HostKey)
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
) -> (&'static str, Option<String>, Option<String>) {
    if stop_requested {
        return ("disconnected", Some("user-disconnect".into()), None);
    }
    if let Some(reason) = process_failure {
        return ("error", Some("process".into()), Some(reason));
    }
    if success {
        return (
            "disconnected",
            Some("remote-exit".into()),
            Some("SSH session ended.".into()),
        );
    }
    let hint = if connected {
        hint.filter(|hint| *hint == TerminalFailureHint::ConnectionLost)
    } else {
        hint
    };
    if connected && hint.is_none() {
        return (
            "disconnected",
            Some("remote-exit".into()),
            Some(format!("The remote shell exited with code {exit_code}.")),
        );
    }
    let (category, reason) = match hint {
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
        Some(TerminalFailureHint::ConnectionLost) => ("connection-lost", "SSH connection was lost"),
        None => ("remote-exit", "SSH session ended unexpectedly"),
    };
    (
        "error",
        Some(category.into()),
        Some(format!("{reason} (exit code {exit_code})")),
    )
}

fn classify_local_exit(
    stop_requested: bool,
    process_failure: Option<String>,
    success: bool,
    exit_code: u32,
    label: &str,
) -> (&'static str, Option<String>, Option<String>) {
    if stop_requested {
        return ("disconnected", Some("user-stop".into()), None);
    }
    if let Some(reason) = process_failure {
        return ("error", Some("process".into()), Some(reason));
    }
    let reason = if success {
        format!("{label} exited.")
    } else {
        format!("{label} exited with code {exit_code}.")
    };
    ("disconnected", Some("local-exit".into()), Some(reason))
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::{
        io::{Read, Write},
        time::Instant,
    };
    use std::{
        sync::{Arc, mpsc},
        time::Duration,
    };

    use portable_pty::CommandBuilder;
    #[cfg(any(windows, target_os = "macos"))]
    use portable_pty::{PtySize, native_pty_system};

    use super::{
        CONNECTED_MARKER, MAX_UNACKNOWLEDGED_OUTPUT_BYTES, OUTPUT_READ_BUFFER_BYTES, OutputFlow,
        SessionManager, SessionMode, TERMINAL_TYPE, TerminalFailureDetector, TerminalFailureHint,
        classify_local_exit, classify_session_exit, interactive_shell_command,
    };

    #[cfg(any(windows, target_os = "macos"))]
    use super::map_pty_kill_result;

    type Classification = (Option<TerminalFailureHint>, bool);

    fn observe_chunked(stream: &[u8], boundaries: &[usize]) -> Classification {
        let mut detector = TerminalFailureDetector::default();
        let mut start = 0;
        for &end in boundaries {
            detector.observe(&stream[start..end]);
            start = end;
        }
        detector.observe(&stream[start..]);
        (detector.hint, detector.established())
    }

    fn classification_independent_of_chunking(name: &str, stream: &[u8]) -> Classification {
        let whole = observe_chunked(stream, &[]);
        for split in 1..stream.len() {
            assert_eq!(
                observe_chunked(stream, &[split]),
                whole,
                "{name}: a cut after byte {split} changed the classification"
            );
        }
        let every_byte = (1..stream.len()).collect::<Vec<_>>();
        assert_eq!(
            observe_chunked(stream, &every_byte),
            whole,
            "{name}: reading one byte at a time changed the classification"
        );
        whole
    }

    #[test]
    fn the_terminal_type_is_requested_explicitly_without_clearing_the_environment() {
        unsafe { std::env::set_var("CONTROL_ROOM_ENV_PROBE", "kept") };
        let mut command = CommandBuilder::new("ssh.exe");
        command.env("TERM", TERMINAL_TYPE);

        assert_eq!(command.get_env("TERM").unwrap(), TERMINAL_TYPE);
        assert_eq!(
            command.get_env("CONTROL_ROOM_ENV_PROBE"),
            Some(std::ffi::OsStr::new("kept")),
            "setting TERM must merge into the inherited environment, not replace it"
        );
        unsafe { std::env::remove_var("CONTROL_ROOM_ENV_PROBE") };
    }

    #[test]
    #[cfg(windows)]
    fn conpty_success_with_stale_last_error_is_not_shown_as_a_failure() {
        assert!(map_pty_kill_result(Err(std::io::Error::from_raw_os_error(0))).is_ok());
        assert!(map_pty_kill_result(Err(std::io::Error::from_raw_os_error(6))).is_ok());
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
                true,
            ),
            ("disconnected", Some("user-disconnect".into()), None)
        );
    }

    #[test]
    fn a_startup_phrase_in_the_marker_chunk_does_not_block_establishment() {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(
            format!(
                "{CONNECTED_MARKER}Welcome to Debian\r\n\
                 run-parts: /etc/update-motd.d/50-motd-news: Permission denied\r\n"
            )
            .as_bytes(),
        );

        assert!(detector.connected, "the marker is in this chunk");
        assert_eq!(
            detector.hint,
            Some(TerminalFailureHint::Authentication),
            "the phrase still matches, which is exactly why the marker has to win"
        );
        assert!(
            detector.established(),
            "reaching the marker proves ssh authenticated and ran the remote command"
        );

        let (state, category, _) =
            classify_session_exit(false, None, false, 1, detector.hint, detector.established());
        assert_eq!(state, "disconnected");
        assert_eq!(category.as_deref(), Some("remote-exit"));
    }

    #[test]
    fn losing_the_connection_in_the_marker_chunk_is_still_an_error() {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(
            format!("{CONNECTED_MARKER}client_loop: send disconnect: Connection reset\r\n")
                .as_bytes(),
        );

        assert!(detector.established());
        assert_eq!(detector.hint, Some(TerminalFailureHint::ConnectionLost));

        let (state, category, _) = classify_session_exit(
            false,
            None,
            false,
            255,
            detector.hint,
            detector.established(),
        );
        assert_eq!(state, "error");
        assert_eq!(category.as_deref(), Some("connection-lost"));
    }

    #[test]
    fn a_clean_remote_shell_exit_is_a_plain_disconnect() {
        for connected in [true, false] {
            assert_eq!(
                classify_session_exit(false, None, true, 0, None, connected),
                (
                    "disconnected",
                    Some("remote-exit".into()),
                    Some("SSH session ended.".into())
                ),
                "connected: {connected}"
            );
        }
    }

    #[test]
    fn a_failed_startup_is_never_established() {
        for diagnostic in [
            "user@host: Permission denied (publickey).",
            "ssh: Could not resolve hostname host: Name or service not known",
            "ssh: connect to host port 22: Connection refused",
            "ssh: connect to host port 22: Connection timed out",
            "Host key verification failed.",
        ] {
            let mut detector = TerminalFailureDetector::default();
            detector.observe(diagnostic.as_bytes());
            assert!(!detector.established(), "{diagnostic}");
            assert!(detector.hint.is_some(), "{diagnostic}");
        }
    }

    #[test]
    fn a_connected_session_that_exits_nonzero_reports_the_shell_exit() {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(CONNECTED_MARKER.as_bytes());
        detector.observe(b"ls: cannot open directory '/root': Permission denied\r\n");
        assert!(detector.connected);
        assert_eq!(detector.hint, Some(TerminalFailureHint::Authentication));

        let (state, category, reason) =
            classify_session_exit(false, None, false, 1, detector.hint, true);

        assert_eq!(state, "disconnected");
        assert_eq!(category.as_deref(), Some("remote-exit"));
        assert!(
            reason.as_deref().is_some_and(|reason| reason.contains("1")),
            "the shell's exit status is still worth reporting: {reason:?}"
        );
    }

    #[test]
    fn a_session_that_never_connected_keeps_its_startup_category() {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(b"user@host: Permission denied (publickey).\r\n");
        assert!(!detector.connected);

        let (state, category, _) =
            classify_session_exit(false, None, false, 255, detector.hint, false);

        assert_eq!(state, "error");
        assert_eq!(category.as_deref(), Some("authentication"));
    }

    #[test]
    fn a_connected_session_that_loses_its_connection_is_still_an_error() {
        let (state, category, _) = classify_session_exit(
            false,
            None,
            false,
            255,
            Some(TerminalFailureHint::ConnectionLost),
            true,
        );

        assert_eq!(state, "error");
        assert_eq!(category.as_deref(), Some("connection-lost"));
    }

    #[test]
    fn authentication_failure_has_a_distinct_error_category() {
        let (state, category, reason) = classify_session_exit(
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
    }

    #[test]
    fn classification_does_not_depend_on_where_pty_reads_are_cut() {
        let long_banner = "motd line\r\n".repeat(60);
        assert!(
            long_banner.len() > 512,
            "this case exists to cross the detector's tail window"
        );

        let cases: [(&str, String, Classification); 8] = [
            ("marker alone", CONNECTED_MARKER.into(), (None, true)),
            (
                "marker beside a failing motd script",
                format!(
                    "{CONNECTED_MARKER}Welcome to Debian\r\n\
                     run-parts: /etc/update-motd.d/50-motd-news: Permission denied\r\n"
                ),
                (Some(TerminalFailureHint::Authentication), true),
            ),
            (
                "marker after a banner longer than the tail window",
                format!("{long_banner}{CONNECTED_MARKER}"),
                (None, true),
            ),
            (
                "connection lost in the marker's own chunk",
                format!("{CONNECTED_MARKER}client_loop: send disconnect: Connection reset\r\n"),
                (Some(TerminalFailureHint::ConnectionLost), true),
            ),
            (
                "refused before any marker",
                "ssh: connect to host laptop port 22: Connection refused\r\n".into(),
                (Some(TerminalFailureHint::ConnectionRefused), false),
            ),
            (
                "host key rejected before any marker",
                "@@@@@@@@@@\r\nHost key verification failed.\r\n".into(),
                (Some(TerminalFailureHint::HostKey), false),
            ),
            (
                "name resolution failed before any marker",
                "ssh: Could not resolve hostname laptop: Name or service not known\r\n".into(),
                (Some(TerminalFailureHint::HostResolution), false),
            ),
            (
                "repeated misleading output after the marker",
                format!(
                    "{CONNECTED_MARKER}$ ls /root\r\n\
                     ls: cannot open directory '/root': Permission denied\r\n\
                     $ ls /root\r\n\
                     ls: cannot open directory '/root': Permission denied\r\n"
                ),
                (Some(TerminalFailureHint::Authentication), true),
            ),
        ];

        for (name, stream, expected) in cases {
            assert_eq!(
                classification_independent_of_chunking(name, stream.as_bytes()),
                expected,
                "{name}"
            );
        }
    }

    #[test]
    fn a_split_multibyte_character_hides_neither_the_marker_nor_a_diagnostic() {
        let stream = format!("Bienvenue à l'hôte →{CONNECTED_MARKER}ls: Permission denied\r\n");
        let bytes = stream.as_bytes();

        for split in 1..bytes.len() {
            assert_eq!(
                observe_chunked(bytes, &[split]),
                (Some(TerminalFailureHint::Authentication), true),
                "a cut after byte {split} changed the classification"
            );
        }

        let mut hostile = vec![0xff, 0xfe, 0x80];
        hostile.extend_from_slice(CONNECTED_MARKER.as_bytes());
        hostile.extend_from_slice(&[0x80, 0xff]);
        assert_eq!(
            classification_independent_of_chunking("invalid utf-8 around the marker", &hostile),
            (None, true)
        );
    }

    #[test]
    fn only_the_full_marker_establishes_a_session() {
        for near_miss in [
            "633;ControlRoom;connected",
            "\u{1b}]633;ControlRoom;connected",
            "]633;ControlRoom;connected\u{7}",
            "\u{1b}]633;ControlRoom;connecting\u{7}",
            "\u{1b}]633;ControlRoom;connected\u{8}",
        ] {
            let mut detector = TerminalFailureDetector::default();
            detector.observe(near_miss.as_bytes());
            assert!(
                !detector.established(),
                "{near_miss:?} is not the connected marker"
            );
        }
    }

    #[test]
    fn a_user_disconnect_outranks_the_failure_its_own_teardown_causes() {
        assert_eq!(
            classify_session_exit(
                true,
                Some("Terminal output channel closed".into()),
                false,
                255,
                Some(TerminalFailureHint::ConnectionLost),
                true,
            ),
            ("disconnected", Some("user-disconnect".into()), None)
        );
        assert_eq!(
            classify_local_exit(
                true,
                Some("Terminal output channel closed".into()),
                false,
                255,
                "Git Bash",
            ),
            ("disconnected", Some("user-stop".into()), None)
        );
    }

    #[test]
    fn startup_hints_stop_counting_once_a_session_is_established() {
        let startup_only = [
            TerminalFailureHint::Authentication,
            TerminalFailureHint::HostResolution,
            TerminalFailureHint::ConnectionRefused,
            TerminalFailureHint::ConnectionTimeout,
            TerminalFailureHint::HostKey,
        ];

        for hint in startup_only {
            let (state, category, reason) =
                classify_session_exit(false, None, false, 42, Some(hint), true);
            assert_eq!(state, "disconnected", "{hint:?}");
            assert_eq!(category.as_deref(), Some("remote-exit"), "{hint:?}");
            assert_eq!(
                reason.as_deref(),
                Some("The remote shell exited with code 42."),
                "{hint:?}"
            );

            let (state, category, _) =
                classify_session_exit(false, None, false, 42, Some(hint), false);
            assert_eq!(state, "error", "{hint:?}");
            assert_ne!(category.as_deref(), Some("remote-exit"), "{hint:?}");
        }

        let (state, category, _) = classify_session_exit(
            false,
            None,
            false,
            42,
            Some(TerminalFailureHint::ConnectionLost),
            true,
        );
        assert_eq!(
            (state, category.as_deref()),
            ("error", Some("connection-lost"))
        );
    }

    #[test]
    fn a_failed_startup_with_no_recognised_diagnostic_is_still_an_error() {
        let (state, category, reason) = classify_session_exit(false, None, false, 255, None, false);
        assert_eq!(state, "error");
        assert_eq!(category.as_deref(), Some("remote-exit"));
        assert_eq!(
            reason.as_deref(),
            Some("SSH session ended unexpectedly (exit code 255)")
        );
    }

    #[test]
    fn every_ssh_failure_category_reports_the_exit_status() {
        for hint in [
            None,
            Some(TerminalFailureHint::Authentication),
            Some(TerminalFailureHint::HostResolution),
            Some(TerminalFailureHint::ConnectionRefused),
            Some(TerminalFailureHint::ConnectionTimeout),
            Some(TerminalFailureHint::HostKey),
            Some(TerminalFailureHint::ConnectionLost),
        ] {
            let (state, category, reason) =
                classify_session_exit(false, None, false, 77, hint, false);
            assert_eq!(state, "error", "{hint:?}");
            assert!(category.is_some(), "{hint:?}");
            assert!(
                reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("77")),
                "{hint:?}: {reason:?}"
            );
        }
    }

    #[test]
    fn a_local_shell_exit_is_never_classified_as_an_ssh_failure() {
        for success in [true, false] {
            let (state, category, _) =
                classify_local_exit(false, None, success, 1, "Windows PowerShell");
            assert_eq!(state, "disconnected", "success: {success}");
            assert_eq!(
                category.as_deref(),
                Some("local-exit"),
                "success: {success}"
            );
        }
    }

    #[test]
    fn operations_on_a_session_that_is_gone_report_it_rather_than_panicking() {
        let sessions = SessionManager::default();
        let missing = "11111111-1111-4111-8111-111111111111";

        for result in [
            sessions.write(missing, b"whoami\r"),
            sessions.resize(missing, 80, 24),
            sessions.close(missing),
        ] {
            assert_eq!(
                result.unwrap_err(),
                "Terminal Session is no longer active",
                "a stale session id has to be reported, not silently accepted"
            );
        }

        sessions.acknowledge_output(missing, 4096);
        sessions.close_all();
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
    fn the_output_cap_admits_exactly_its_limit() {
        let flow = OutputFlow::new();
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES - 1));
        flow.acknowledge(MAX_UNACKNOWLEDGED_OUTPUT_BYTES - 1);
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));

        flow.acknowledge(1);
        assert!(flow.reserve(1));
    }

    #[test]
    fn one_pty_read_always_fits_under_the_output_cap() {
        const {
            assert!(OUTPUT_READ_BUFFER_BYTES < MAX_UNACKNOWLEDGED_OUTPUT_BYTES);
        }

        let flow = Arc::new(OutputFlow::new());
        let reader = flow.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(reader.reserve(OUTPUT_READ_BUFFER_BYTES));
        });
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok(true));
    }

    #[test]
    fn over_acknowledgement_cannot_underflow_the_outstanding_total() {
        let flow = Arc::new(OutputFlow::new());
        assert!(flow.reserve(1_024));
        flow.acknowledge(usize::MAX);
        flow.acknowledge(4_096);

        let drained = flow.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(drained.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));
        });
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(5)),
            Ok(true),
            "the flow has to be empty again after being over-acknowledged"
        );
    }

    #[test]
    fn closing_the_output_flow_repeatedly_is_harmless() {
        let flow = OutputFlow::new();
        flow.close();
        flow.close();
        flow.acknowledge(4_096);
        assert!(
            !flow.reserve(1),
            "a closed flow refuses new bytes rather than blocking the reader"
        );
        flow.close();
        assert!(!flow.reserve(1));
    }

    #[test]
    fn a_producer_arriving_after_close_does_not_block() {
        let flow = Arc::new(OutputFlow::new());
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));
        flow.close();

        let late = flow.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(late.reserve(1));
        });
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(5)),
            Ok(false),
            "reserve after close has to return, not wait"
        );
    }

    #[test]
    fn a_blocked_producer_resumes_only_once_enough_has_drained() {
        let flow = Arc::new(OutputFlow::new());
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));

        let blocked = flow.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(blocked.reserve(4_096));
        });

        for _ in 0..8 {
            flow.acknowledge(256);
            assert!(
                receiver.recv_timeout(Duration::from_millis(20)).is_err(),
                "2048 acknowledged bytes cannot admit a 4096-byte reservation"
            );
        }

        flow.acknowledge(4_096);
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok(true));
    }

    #[cfg(windows)]
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
        #[cfg(not(target_os = "linux"))]
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
    #[cfg(windows)]
    fn process_exit_drains_conpty_output_before_closing_flow_control() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        command.args([
            "/Q",
            "/D",
            "/C",
            "for /L %i in (1,1,2000) do @echo CONTROL_ROOM_DRAIN_%i",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let flow = Arc::new(OutputFlow::new());
        let reading_flow = flow.clone();
        let reading = std::thread::spawn(move || {
            let mut output = Vec::new();
            let mut buffer = [0; OUTPUT_READ_BUFFER_BYTES];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if buffer[..count].windows(4).any(|bytes| bytes == b"\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
                if !reading_flow.reserve(count) {
                    break;
                }
                output.extend_from_slice(&buffer[..count]);
                reading_flow.acknowledge(count);
                std::thread::sleep(Duration::from_millis(1));
            }
            output
        });
        let (sender, receiver) = mpsc::channel();
        let mut killer = child.clone_killer();
        std::thread::spawn(move || {
            let status = child.wait().unwrap();
            assert!(status.success());
            let master = parking_lot::Mutex::new(Some(pair.master));
            let output = super::drain_pty_output(&master, reading, &flow).unwrap();
            let _ = sender.send(output);
        });
        let output = receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| {
                let _ = killer.kill();
                panic!("ConPTY output did not drain: {error}");
            });
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("CONTROL_ROOM_DRAIN_2000"));
        assert_eq!(output.matches("CONTROL_ROOM_DRAIN_").count(), 2000);
    }

    #[test]
    fn a_local_shell_that_exits_keeps_the_workspace_and_reports_the_exit() {
        assert_eq!(
            classify_local_exit(false, None, true, 0, "PowerShell 7"),
            (
                "disconnected",
                Some("local-exit".into()),
                Some("PowerShell 7 exited.".into())
            )
        );
        assert_eq!(
            classify_local_exit(false, None, false, 1, "Git Bash"),
            (
                "disconnected",
                Some("local-exit".into()),
                Some("Git Bash exited with code 1.".into())
            )
        );
    }

    #[test]
    fn stopping_a_local_shell_is_not_reported_as_a_failure() {
        assert_eq!(
            classify_local_exit(true, None, false, 1, "Command Prompt"),
            ("disconnected", Some("user-stop".into()), None)
        );
    }

    #[test]
    fn a_broken_local_pty_is_the_only_local_error_state() {
        let (state, category, reason) = classify_local_exit(
            false,
            Some("Terminal output failed: pipe closed".into()),
            false,
            1,
            "Git Bash",
        );
        assert_eq!(state, "error");
        assert_eq!(category.as_deref(), Some("process"));
        assert_eq!(
            reason.as_deref(),
            Some("Terminal output failed: pipe closed")
        );
    }

    #[test]
    fn a_local_start_failure_names_the_shell_without_pty_internals() {
        let local = SessionMode::Local {
            label: "PowerShell 7",
        };
        let remote = SessionMode::ssh("11111111-1111-4111-8111-111111111111");

        assert_eq!(
            local.spawn_error("os error 267: the directory name is invalid"),
            "PowerShell 7 could not be started."
        );
        assert!(
            remote
                .spawn_error("os error 2")
                .starts_with("SSH process could not start")
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_login_shell_accepts_input_resizes_and_stops() {
        let shell = crate::local_shell::resolve_installed("zsh").unwrap();
        assert_eq!(shell.program(), std::path::Path::new("/bin/zsh"));
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut child = pair
            .slave
            .spawn_command(crate::local_shell::command_for(&shell))
            .unwrap();
        drop(pair.slave);
        pair.master
            .resize(PtySize {
                rows: 31,
                cols: 91,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut output = Vec::new();
            let mut buffer = [0; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                output.extend_from_slice(&buffer[..count]);
                if output
                    .windows(b"MAC_PTY_READY".len())
                    .any(|s| s == b"MAC_PTY_READY")
                {
                    let _ = sender.send(output.clone());
                }
            }
        });
        writer
            .write_all(b"stty size; printf 'MAC_PTY_%s\\n' READY\n")
            .unwrap();
        writer.flush().unwrap();
        let mut killer = child.clone_killer();
        let output = receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|e| {
                let _ = killer.kill();
                panic!("macOS PTY did not answer typed input: {e}");
            });
        assert!(String::from_utf8_lossy(&output).contains("31 91"));
        assert!(map_pty_kill_result(killer.kill()).is_ok());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(child.wait());
        });
        assert!(
            receiver
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .is_ok()
        );
    }

    #[test]
    #[cfg(windows)]
    fn a_resolved_local_shell_runs_and_stops_under_conpty() {
        let shell = crate::local_shell::resolve_installed("command-prompt").unwrap();
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut child = pair
            .slave
            .spawn_command(crate::local_shell::command_for(&shell))
            .unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
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

        let first_output = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!first_output.is_empty());

        let mut writer = pair.master.take_writer().unwrap();
        let mut output = first_output.clone();
        let mut answered_queries = 0;
        let mut sent_command = false;
        let deadline = Instant::now() + Duration::from_secs(15);
        while !String::from_utf8_lossy(&output).contains("CONTROL_ROOM_LOCAL_OK")
            && Instant::now() < deadline
        {
            let query_count = output
                .windows(4)
                .filter(|window| *window == b"\x1b[6n")
                .count();
            while answered_queries < query_count {
                writer.write_all(b"\x1b[1;1R").unwrap();
                writer.flush().unwrap();
                answered_queries += 1;
            }
            if answered_queries > 0 && !sent_command {
                writer.write_all(b"echo CONTROL_ROOM_LOCAL_OK\r\n").unwrap();
                writer.flush().unwrap();
                sent_command = true;
            }
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => output.extend(chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(
            String::from_utf8_lossy(&output).contains("CONTROL_ROOM_LOCAL_OK"),
            "local shell did not answer typed input: {}",
            String::from_utf8_lossy(&output)
        );

        let mut killer = child.clone_killer();
        assert!(map_pty_kill_result(killer.kill()).is_ok());
        let (status_sender, status_receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = status_sender.send(child.wait());
        });
        let status = status_receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        let (state, category, _) = classify_local_exit(
            true,
            None,
            status.success(),
            status.exit_code(),
            shell.label(),
        );
        assert_eq!(
            (state, category.as_deref()),
            ("disconnected", Some("user-stop"))
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires an explicitly configured Linux SSH fixture"]
    fn native_pty_hosts_ssh_against_live_fixture() {
        let ssh_path = crate::ssh::detect_ssh_path().unwrap();
        let host = std::env::var("CONTROL_ROOM_TEST_HOST").unwrap();
        let user = std::env::var("CONTROL_ROOM_TEST_USER").unwrap();
        let port = std::env::var("CONTROL_ROOM_TEST_PORT").unwrap_or_else(|_| "22".into());
        let target = format!("{user}@{host}");
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command = CommandBuilder::new(ssh_path);
        command.args([
            "-tt",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-p",
            &port,
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
                    "Native PTY SSH fixture timed out: {}",
                    String::from_utf8_lossy(&output)
                );
            }
        };
        assert!(status.success());
        assert!(String::from_utf8_lossy(&output).contains("CONTROL_ROOM_SSH_OK"));
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "requires Git Bash and CONTROL_ROOM_TEST_OPENCODE_EXE"]
    fn git_bash_survives_opencode_ctrl_c_exit() {
        assert_git_bash_survives_opencode_exit(true);
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "requires Git Bash and CONTROL_ROOM_TEST_OPENCODE_EXE"]
    fn git_bash_survives_opencode_slash_exit() {
        assert_git_bash_survives_opencode_exit(false);
    }

    #[cfg(windows)]
    fn assert_git_bash_survives_opencode_exit(ctrl_c: bool) {
        let executable = std::env::var("CONTROL_ROOM_TEST_OPENCODE_EXE")
            .expect("Set CONTROL_ROOM_TEST_OPENCODE_EXE to the installed OpenCode executable");
        assert!(std::path::Path::new(&executable).is_file());
        let executable = executable.replace('\\', "/").replace('\'', "'\\''");
        let shell = crate::local_shell::resolve_installed("git-bash").unwrap();
        let directory = tempfile::tempdir().unwrap();
        let mut command = crate::local_shell::command_for(&shell);
        command.cwd(directory.path());
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                ..PtySize::default()
            })
            .unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            loop {
                let result = reader
                    .read(&mut buffer)
                    .map(|count| buffer[..count].to_vec());
                let done = result.as_ref().map_or(true, Vec::is_empty);
                if sender.send(result).is_err() || done {
                    break;
                }
            }
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let collect = |writer: &mut dyn Write, duration: Duration| {
                let deadline = Instant::now() + duration;
                let mut bytes = Vec::new();
                let mut answered_queries = 0;
                while Instant::now() < deadline {
                    if let Ok(chunk) = receiver.recv_timeout(Duration::from_millis(50)) {
                        let chunk = chunk.expect("PTY output read failed");
                        assert!(!chunk.is_empty(), "PTY output closed");
                        bytes.extend(chunk);
                        let queries = bytes.windows(4).filter(|part| *part == b"\x1b[6n").count();
                        while answered_queries < queries {
                            writer.write_all(b"\x1b[1;1R").unwrap();
                            answered_queries += 1;
                        }
                    }
                }
                bytes
            };
            collect(&mut *writer, Duration::from_secs(2));
            writer
                .write_all(b"PS1='CONTROL_ROOM_PROMPT> '; PROMPT_COMMAND=; printf 'BEFORE_%s\\n' OPENCODE\r")
                .unwrap();
            let before = collect(&mut *writer, Duration::from_secs(5));
            assert!(
                String::from_utf8_lossy(&before).contains("BEFORE_OPENCODE"),
                "Git Bash did not answer the initial input"
            );
            let launch = format!("'{executable}'\r");
            writer.write_all(launch.as_bytes()).unwrap();
            let opened = collect(&mut *writer, Duration::from_secs(8));
            assert!(
                opened.windows(6).any(|part| part == b"\x1b[?25l"),
                "OpenCode did not render its interface"
            );
            assert!(
                !String::from_utf8_lossy(&opened).contains("CONTROL_ROOM_PROMPT> "),
                "OpenCode exited before the quit command"
            );
            if ctrl_c {
                writer.write_all(b"\x03").unwrap();
                collect(&mut *writer, Duration::from_millis(500));
                writer.write_all(b"\x03").unwrap();
            } else {
                writer.write_all(b"/exit").unwrap();
                collect(&mut *writer, Duration::from_millis(500));
                writer.write_all(b"\r").unwrap();
            }
            let exited = collect(&mut *writer, Duration::from_secs(5));
            assert!(
                String::from_utf8_lossy(&exited).contains("CONTROL_ROOM_PROMPT> "),
                "OpenCode did not return to the Bash prompt"
            );
            assert!(
                child.try_wait().unwrap().is_none(),
                "Git Bash exited with OpenCode"
            );
            writer
                .write_all(b"printf 'AFTER_%s\\n' OPENCODE\r")
                .expect("input pipe broke after OpenCode exit");
            let after = collect(&mut *writer, Duration::from_secs(2));
            assert!(
                String::from_utf8_lossy(&after).contains("AFTER_OPENCODE"),
                "Git Bash did not accept input after OpenCode exit"
            );
        }));
        let _ = killer.kill();
        let _ = child.wait();
        drop(pair.master);
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
}
