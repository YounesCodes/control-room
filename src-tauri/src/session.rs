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

/// One pty read's buffer, and the largest amount `reserve` is ever asked for.
///
/// It has to stay below `MAX_UNACKNOWLEDGED_OUTPUT_BYTES`. `reserve` waits
/// until the outstanding total plus the new count fits under the cap, and the
/// only thing that lowers the outstanding total is the frontend acknowledging
/// bytes it already received. A single read larger than the whole cap could
/// never fit however much is acknowledged, so the reader thread would wait for
/// an acknowledgement that cannot arrive and the session would go silent with
/// its child still running.
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

    /// Whether the frontend should be told this session connected.
    ///
    /// The marker settles this on its own. Only the remote command can print
    /// it, so reaching it proves ssh authenticated, opened its channel, and
    /// started the shell, and no phrase found alongside it can unsay that.
    ///
    /// This used to also require `hint` to be empty, which a pty read makes
    /// unsafe: reads carry no message boundary, so one chunk routinely holds
    /// the marker together with the login banner and the shell's first output.
    /// An MOTD script failing with "Permission denied" lands in the same
    /// `observe` call as the marker and matches the same phrase ssh uses for a
    /// rejected key. Because `hint` is sticky, that left the session
    /// unestablished for its whole life: never reported connected, and its
    /// ordinary exit classified through the SSH startup categories.
    ///
    /// Establishment is not health. A hint still decides how the session ends,
    /// and `classify_session_exit` is where a startup-only hint stops counting
    /// once this returns true.
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
            shell_id: shell.id().into(),
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
            let mut buffer = vec![0_u8; OUTPUT_READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        // Reading the stream for a connected marker, and marking
                        // the Saved Connection, is remote-only work. A local
                        // shell is running the moment its process starts.
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
                            // What the frontend was actually told, so the exit
                            // is classified the same way the session was
                            // presented while it ran.
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

/// `connected` is whether this session was reported to the frontend as
/// connected, which happens only once the remote shell emits the marker.
///
/// Past that point the exit status belongs to that shell rather than to ssh:
/// `exec bash -l` ends on Ctrl-D with the status of the last command, so a
/// session where `grep` found nothing exits non-zero for an entirely ordinary
/// reason. The startup hints cannot apply either. They are detected from
/// whatever passes through the pty and are sticky, so an ordinary
/// "Permission denied" from `ls` used to survive to here and label a normal
/// exit as an authentication failure. Only losing an established connection is
/// still a hint worth acting on after the marker.
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
        return ("disconnected", Some("remote-exit".into()), None);
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
        CONNECTED_MARKER, MAX_UNACKNOWLEDGED_OUTPUT_BYTES, OUTPUT_READ_BUFFER_BYTES, OutputFlow,
        SessionManager, SessionMode, TERMINAL_TYPE, TerminalFailureDetector, TerminalFailureHint,
        classify_local_exit, classify_session_exit, interactive_shell_command, map_pty_kill_result,
    };

    /// What the detector concluded about one logical stream: the failure hint
    /// and whether the session counts as established.
    type Classification = (Option<TerminalFailureHint>, bool);

    /// Feeds one logical byte stream to a fresh detector, cut at the given
    /// offsets, and reports what it concluded.
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

    /// A pty read is however many bytes happened to be available, so the same
    /// logical stream arrives cut in a different place every run. Classification
    /// has to depend on the byte stream and not on where those cuts land.
    ///
    /// Checks the stream whole, cut at every single offset, and one byte at a
    /// time, and returns the classification they all agree on.
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
            // Disconnecting a session that had connected: the user's own action
            // outranks every hint and every exit status.
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

    /// A pty read carries no message boundary, so one chunk routinely holds the
    /// marker together with the login banner and the shell's first output. On a
    /// Debian host an MOTD script that cannot read something fails with
    /// "Permission denied" right there, in the same `observe` call that sees the
    /// marker.
    ///
    /// Gating the transition on `hint` therefore lost the whole session: the
    /// hint is sticky, so `established` stayed false for its entire life, the
    /// frontend was never told it connected, and its ordinary exit went back
    /// through the SSH startup categories. That is the case CR-AUDIT-002 exists
    /// to prevent.
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

    /// The marker settles establishment, not health. A connection lost in that
    /// same chunk still has to reach the user as a failure.
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

    /// A shell that exits cleanly says so whether or not it was established,
    /// because success short-circuits ahead of every hint.
    #[test]
    fn a_clean_remote_shell_exit_is_a_plain_disconnect() {
        for connected in [true, false] {
            assert_eq!(
                classify_session_exit(false, None, true, 0, None, connected),
                ("disconnected", Some("remote-exit".into()), None),
                "connected: {connected}"
            );
        }
    }

    /// A session that never reaches the marker is never established, whatever
    /// else the stream contains.
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

    /// A shell that reached the connected marker authenticated and started.
    /// Its exit status is the remote shell's, and bash exits on Ctrl-D with the
    /// status of the last command, so an ordinary session that ended after a
    /// failing command must not be reported as an SSH-layer failure.
    #[test]
    fn a_connected_session_that_exits_nonzero_reports_the_shell_exit() {
        let mut detector = TerminalFailureDetector::default();
        detector.observe(CONNECTED_MARKER.as_bytes());
        // Ordinary session output. `detect_terminal_failure` matches this the
        // same way it matches ssh's own startup diagnostics, and the hint is
        // sticky, so before the fix it survived to classification.
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

    /// The startup categories still have to work. A session that never reported
    /// connected is exactly the case they were written for.
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

    /// Losing an established connection is still a failure. It is the one hint
    /// that can legitimately arrive after the marker.
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

    /// The campaign this table exists for: CR-AUDIT-002 was a real bug caused
    /// by treating one pty read as one logical message. Every stream here is
    /// checked whole, at every single cut point, and one byte at a time, so a
    /// detector that only looks at the chunk it was handed, or that keeps too
    /// small a tail to bridge a cut, fails here rather than on a user's host.
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
                // The same-buffer case from #63, now pinned under every cut
                // rather than only the one the fix was written against.
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
                // The hint is sticky and the marker is authoritative, so an
                // established session that keeps printing the phrase stays
                // established and keeps the first hint it saw.
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

    /// A pty read can cut a multi-byte character in half, and each half decodes
    /// lossily on its own. The marker and the diagnostics are ASCII, so a
    /// replacement character next to them must not hide either. This is what
    /// stops the lossy decode from being "tightened" into a strict one that
    /// drops the whole chunk a split character lands in.
    #[test]
    fn a_split_multibyte_character_hides_neither_the_marker_nor_a_diagnostic() {
        // "Bienvenue à l'hôte" carries two-byte characters on both sides of the
        // marker; the box-drawing arrow is three bytes.
        let stream = format!("Bienvenue à l'hôte →{CONNECTED_MARKER}ls: Permission denied\r\n");
        let bytes = stream.as_bytes();

        for split in 1..bytes.len() {
            assert_eq!(
                observe_chunked(bytes, &[split]),
                (Some(TerminalFailureHint::Authentication), true),
                "a cut after byte {split} changed the classification"
            );
        }

        // Bytes that are not valid UTF-8 in any arrangement, which is what a
        // binary file catted into the terminal looks like.
        let mut hostile = vec![0xff, 0xfe, 0x80];
        hostile.extend_from_slice(CONNECTED_MARKER.as_bytes());
        hostile.extend_from_slice(&[0x80, 0xff]);
        assert_eq!(
            classification_independent_of_chunking("invalid utf-8 around the marker", &hostile),
            (None, true)
        );
    }

    /// The marker proves the remote command ran. Nothing printed before it can
    /// stand in for it, including a shell that echoes the marker's own text
    /// without the control bytes that make it a marker.
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

    /// Closing a session tears down the pty, and the reader thread sees that as
    /// a broken channel. `close` records the user's intent before it kills
    /// anything, so the wreckage of a deliberate disconnect must not outrank
    /// the intent and reach the user as an error.
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

    /// Once the frontend has been told a session connected, ssh's startup
    /// diagnostics are behind it and the stream belongs to the remote shell.
    /// Every startup hint therefore stops counting, and only losing the
    /// connection survives. Before #63 each of these ended an ordinary session
    /// with an SSH-layer error the user could not act on.
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

            // The same hint on a session that never connected is exactly what
            // the startup categories are for, so it must still be reported.
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

    /// ssh can fail before printing anything the detector recognises. The user
    /// still gets an error with the exit status rather than a silent disconnect.
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

    /// Every classified failure names the exit status, because "it failed" with
    /// no number is the report the user cannot do anything with.
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

    /// A local shell never runs the SSH classifier, so its exit can never be
    /// reported as an authentication or host-key failure however its output
    /// read. The two paths stay separate.
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

    /// The frontend can name a session that has already gone. Writing, resizing
    /// and closing it have to say so rather than panic or report success, and
    /// acknowledging output for it is a no-op.
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

    /// The cap is a ceiling on outstanding bytes, not on the reader's progress.
    /// Filling it exactly still succeeds; one byte past it is what has to wait.
    #[test]
    fn the_output_cap_admits_exactly_its_limit() {
        let flow = OutputFlow::new();
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES - 1));
        flow.acknowledge(MAX_UNACKNOWLEDGED_OUTPUT_BYTES - 1);
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));

        // At the cap, a further byte would exceed it, so it waits. Proven by
        // the blocking tests; here the point is that the cap itself was
        // admitted rather than rejected or blocked.
        flow.acknowledge(1);
        assert!(flow.reserve(1));
    }

    /// The reader never asks for more than one buffer, and one buffer has to
    /// fit under the cap. A read larger than the whole cap could never fit
    /// however much the frontend acknowledges, so `reserve` would wait forever
    /// and the session would go silent with its child still running.
    #[test]
    fn one_pty_read_always_fits_under_the_output_cap() {
        // Both are constants, so raising the buffer past the cap is a build
        // failure rather than a session that goes quiet on a user's machine.
        const {
            assert!(OUTPUT_READ_BUFFER_BYTES < MAX_UNACKNOWLEDGED_OUTPUT_BYTES);
        }

        // And the flow agrees at run time: a full buffer on an empty flow is
        // admitted rather than parked.
        let flow = Arc::new(OutputFlow::new());
        let reader = flow.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(reader.reserve(OUTPUT_READ_BUFFER_BYTES));
        });
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok(true));
    }

    /// Acknowledgements come from the frontend, so the count is not trusted.
    /// Acknowledging more than is outstanding must clamp at zero rather than
    /// wrap a `usize` around to a total that never drains again.
    #[test]
    fn over_acknowledgement_cannot_underflow_the_outstanding_total() {
        let flow = Arc::new(OutputFlow::new());
        assert!(flow.reserve(1_024));
        flow.acknowledge(usize::MAX);
        flow.acknowledge(4_096);

        // A wrapped total sits astronomically over the cap and nothing can
        // bring it back down, so the reader would wait here forever. Run it off
        // the test thread so that shows up as a failure rather than a hang.
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

    /// Closing happens on the reader's error path, on the channel's error path,
    /// on `close`, on `close_all`, and again when the child is reaped. Every one
    /// of those can run for the same session, so closing has to stay a no-op
    /// after the first time.
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

    /// A producer already blocked at the cap is woken by the close, and one
    /// that arrives afterwards must not start waiting on a flow nothing will
    /// ever drain.
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

    /// Acknowledgements arrive per chunk, so a producer waiting on a large
    /// reservation is woken repeatedly before enough has drained. Each wake
    /// re-checks the total instead of assuming a notification means room.
    #[test]
    fn a_blocked_producer_resumes_only_once_enough_has_drained() {
        let flow = Arc::new(OutputFlow::new());
        assert!(flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT_BYTES));

        let blocked = flow.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(blocked.reserve(4_096));
        });

        // Not enough room yet, however many times the producer is woken.
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
