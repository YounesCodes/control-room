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
    models::{
        LocalSessionStarted, SavedConnection, SessionEndCategory, SessionStarted, SessionState,
        SessionStateEvent,
    },
    ssh::{connection_arguments, detect_ssh_path, ssh_not_found_message},
};

#[cfg(target_os = "linux")]
#[path = "session_linux.rs"]
mod linux;
#[cfg(windows)]
#[path = "session_windows.rs"]
mod windows;

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
        #[cfg(windows)]
        let killer: Box<dyn ChildKiller + Send + Sync> = match windows::Killer::new(child.as_ref())
        {
            Ok(killer) => Box::new(killer),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("PTY process could not be tracked: {error}"));
            }
        };
        #[cfg(not(any(target_os = "linux", windows)))]
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
                                    SessionState::Connected,
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
                    SessionState::Error,
                    Some(SessionEndCategory::Process),
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

fn map_pty_kill_result(result: std::io::Result<()>) -> Result<(), String> {
    result.map_err(|error| format!("Could not close the terminal process: {error}"))
}

fn emit_state(
    app: &AppHandle,
    session_id: &str,
    state: SessionState,
    category: Option<SessionEndCategory>,
    reason: Option<String>,
) {
    let _ = app.emit(
        "session-state-changed",
        SessionStateEvent {
            session_id: session_id.into(),
            state,
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
) -> (SessionState, Option<SessionEndCategory>, Option<String>) {
    if stop_requested {
        return (
            SessionState::Disconnected,
            Some(SessionEndCategory::UserDisconnect),
            None,
        );
    }
    if let Some(reason) = process_failure {
        return (
            SessionState::Error,
            Some(SessionEndCategory::Process),
            Some(reason),
        );
    }
    if success {
        return (
            SessionState::Disconnected,
            Some(SessionEndCategory::RemoteExit),
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
            SessionState::Disconnected,
            Some(SessionEndCategory::RemoteExit),
            Some(format!("The remote shell exited with code {exit_code}.")),
        );
    }
    let (category, reason) = match hint {
        Some(TerminalFailureHint::Authentication) => (
            SessionEndCategory::Authentication,
            "SSH authentication failed",
        ),
        Some(TerminalFailureHint::HostResolution) => (
            SessionEndCategory::HostResolution,
            "SSH host could not be resolved",
        ),
        Some(TerminalFailureHint::ConnectionRefused) => (
            SessionEndCategory::ConnectionRefused,
            "SSH connection was refused",
        ),
        Some(TerminalFailureHint::ConnectionTimeout) => (
            SessionEndCategory::ConnectionTimeout,
            "SSH connection timed out",
        ),
        Some(TerminalFailureHint::HostKey) => (
            SessionEndCategory::HostKey,
            "SSH host-key verification failed",
        ),
        Some(TerminalFailureHint::ConnectionLost) => (
            SessionEndCategory::ConnectionLost,
            "SSH connection was lost",
        ),
        None => (
            SessionEndCategory::RemoteExit,
            "SSH session ended unexpectedly",
        ),
    };
    (
        SessionState::Error,
        Some(category),
        Some(format!("{reason} (exit code {exit_code})")),
    )
}

fn classify_local_exit(
    stop_requested: bool,
    process_failure: Option<String>,
    success: bool,
    exit_code: u32,
    label: &str,
) -> (SessionState, Option<SessionEndCategory>, Option<String>) {
    if stop_requested {
        return (
            SessionState::Disconnected,
            Some(SessionEndCategory::UserStop),
            None,
        );
    }
    if let Some(reason) = process_failure {
        return (
            SessionState::Error,
            Some(SessionEndCategory::Process),
            Some(reason),
        );
    }
    let reason = if success {
        format!("{label} exited.")
    } else {
        format!("{label} exited with code {exit_code}.")
    };
    (
        SessionState::Disconnected,
        Some(SessionEndCategory::LocalExit),
        Some(reason),
    )
}

#[cfg(test)]
mod tests;
