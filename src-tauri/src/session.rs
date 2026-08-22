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
    models::{SavedConnection, SessionStarted, SessionStateEvent},
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
}

impl TerminalFailureDetector {
    fn observe(&mut self, bytes: &[u8]) {
        let chunk = String::from_utf8_lossy(bytes).to_ascii_lowercase();
        let combined = format!("{}{chunk}", self.tail);
        self.hint = detect_terminal_failure(&combined).or(self.hint);
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
        if connection.history_enabled {
            command.arg("CONTROL_ROOM_SHELL_INTEGRATION=1 exec bash -i");
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("SSH process could not start: {error}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("PTY output could not be opened: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("PTY input could not be opened: {error}"))?;
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
                        let startup_failure = {
                            let mut detector = output_managed.failure_detector.lock();
                            detector.observe(&buffer[..count]);
                            detector.hint.is_some()
                        };
                        if !startup_failure
                            && !output_managed
                                .connected_emitted
                                .swap(true, Ordering::AcqRel)
                        {
                            let _ = output_app
                                .state::<Database>()
                                .mark_connected(&output_connection_id);
                            emit_state(&output_app, &output_session_id, "connected", None, None);
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
                    let hint = wait_managed.failure_detector.lock().hint;
                    let (state, category, reason) = classify_session_exit(
                        wait_managed.stop_requested.load(Ordering::Acquire),
                        failure,
                        status.success(),
                        status.exit_code(),
                        hint,
                    );
                    emit_state(&wait_app, &wait_session_id, state, category, reason);
                }
                Err(error) => emit_state(
                    &wait_app,
                    &wait_session_id,
                    "error",
                    Some("process".into()),
                    Some(format!("SSH process wait failed: {error}")),
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
        classify_session_exit, map_pty_kill_result,
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
