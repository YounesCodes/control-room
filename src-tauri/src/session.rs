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
    ssh::{connection_arguments, detect_ssh_path},
};

struct ManagedSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output_flow: OutputFlow,
    stop_requested: AtomicBool,
    failure: Mutex<Option<String>>,
    mode: SessionMode,
}

/// What a remote and a local Terminal Session do differently. The pty
/// lifecycle is shared; everything SSH-specific lives in `RemoteSessionState`,
/// so a local shell has no connected marker, no failure classification, and no
/// Saved Connection to update.
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

    /// A remote start failure names ssh, because the user can act on it. A local
    /// one names the shell and stops there: the pty error behind it says nothing
    /// the user can use.
    fn spawn_error(&self, error: impl std::fmt::Display) -> String {
        match self {
            Self::Ssh(_) => format!("SSH process could not start: {error}"),
            Self::Local { label } => format!("{label} could not be started."),
        }
    }
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
        let mut command = CommandBuilder::new(ssh_path);
        command.env("TERM", TERMINAL_TYPE);
        command.args(connection_arguments(connection, true));
        command.arg(interactive_shell_command(connection.history_enabled));
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

    /// Starts a local Windows shell through the same pty lifecycle as an SSH
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
            shell_id: shell.kind.id().into(),
        })
    }

    /// The shared pty lifecycle: one pty, one reader thread with flow control,
    /// one wait thread, and one registration in this manager. Both session kinds
    /// go through here so input, resize, acknowledgement, and cleanup have a
    /// single implementation.
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
            failure: Mutex::new(None),
            mode,
        });
        self.sessions
            .lock()
            .insert(session_id.clone(), managed.clone());

        let output_session_id = session_id.clone();
        let output_app = app.clone();
        let output_managed = managed.clone();
        thread::spawn(move || {
            let mut buffer = vec![0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        // Reading the stream for a connected marker, and marking
                        // the Saved Connection, is remote-only work. A local
                        // shell is running the moment its process starts.
                        if let SessionMode::Ssh(remote) = &output_managed.mode {
                            let (startup_failure, connected) = {
                                let mut detector = remote.failure_detector.lock();
                                detector.observe(&buffer[..count]);
                                (detector.hint.is_some(), detector.connected)
                            };
                            if connected
                                && !startup_failure
                                && !remote.connected_emitted.swap(true, Ordering::AcqRel)
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
            wait_managed.output_flow.close();
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

/// The terminal type requested for the remote pty. ssh forwards whatever `TERM`
/// its own environment carries, so leaving it unset makes the remote depend on
/// how the app was launched and on which ssh build `detect_ssh_path` picked.
/// Microsoft's client happens to default to this value, but an OpenSSH found on
/// PATH sends an empty string instead, and a remote with no `TERM` drops colour
/// and misdraws full-screen tools. The frontend is a 256-colour xterm, so it
/// says so rather than relying on either default.
const TERMINAL_TYPE: &str = "xterm-256color";

fn interactive_shell_command(history_enabled: bool) -> &'static str {
    if history_enabled {
        "printf '\\033]633;ControlRoom;connected\\007'; CONTROL_ROOM_SHELL_INTEGRATION=1 exec bash -i"
    } else {
        "printf '\\033]633;ControlRoom;connected\\007'; exec \"${SHELL:-/bin/bash}\" -l"
    }
}

/// `portable-pty`'s Windows child killer inverts its own result: a successful
/// `TerminateProcess` is reported as `Err(GetLastError())`, which is whatever
/// stale error the calling thread happened to carry, and a real failure is
/// reported as `Ok(())`. So the value carries no information on Windows, and
/// showing it would put a bogus error under a terminal that did stop. The
/// session's exit event is what actually reports whether it ended.
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
) -> (&'static str, Option<String>, Option<String>) {
    if stop_requested {
        return ("disconnected", Some("user-disconnect".into()), None);
    }
    if let Some(reason) = process_failure {
        return ("error", Some("process".into()), Some(reason));
    }
    if success {
        return ("disconnected", Some("remote-exit".into()), None);
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

/// A local shell that exits is a shell that exited, not a failure: `exit 1`
/// from a prompt is as ordinary as `exit`. Only Control Room's own pty or
/// channel breaking is an error, so the Workspace stays open with a notice and
/// a Restart either way.
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
    use std::{
        io::{Read, Write},
        sync::{Arc, mpsc},
        time::{Duration, Instant},
    };

    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

    use super::{
        MAX_UNACKNOWLEDGED_OUTPUT_BYTES, OutputFlow, SessionMode, TERMINAL_TYPE,
        TerminalFailureDetector, TerminalFailureHint, classify_local_exit, classify_session_exit,
        interactive_shell_command, map_pty_kill_result,
    };

    // ssh forwards its own TERM, so an unset one leaves the remote depending on
    // the launch environment and the ssh build. Setting it must not disturb the
    // rest of the inherited environment.
    #[test]
    fn the_terminal_type_is_requested_explicitly_without_clearing_the_environment() {
        // SAFETY: single-threaded test process, restored before returning.
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
        // A stale error from an unrelated earlier call is just as much a
        // success: `TerminateProcess` reports success by returning the last
        // error, whatever it currently is.
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
            ),
            ("disconnected", Some("user-disconnect".into()), None)
        );
    }

    #[test]
    fn authentication_failure_has_a_distinct_error_category() {
        let (state, category, reason) = classify_session_exit(
            false,
            None,
            false,
            255,
            Some(TerminalFailureHint::Authentication),
        );
        assert_eq!(state, "error");
        assert_eq!(category.as_deref(), Some("authentication"));
        assert!(reason.unwrap().starts_with("SSH authentication failed"));
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
    #[cfg(windows)]
    fn a_resolved_local_shell_runs_and_stops_under_conpty() {
        // The command processor is the one shell present on every supported
        // Windows install, so the local launch path can be exercised for real.
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

        // An interactive shell prints its prompt and then waits, which is the
        // proof that it is running rather than exiting immediately.
        let first_output = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!first_output.is_empty());

        // The shell is interactive: typed input reaches it and its output comes
        // back on the same pty. ConPTY asks the terminal where the cursor is and
        // waits for the answer, which xterm sends on its own; this stands in for
        // it.
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
