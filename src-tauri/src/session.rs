use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Arc,
    thread,
};

use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{AppHandle, Emitter, ipc::Channel, ipc::Response};
use uuid::Uuid;

use crate::{
    models::{SavedConnection, SessionStarted, SessionStateEvent},
    ssh::{connection_arguments, detect_ssh_path},
};

struct ManagedSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
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
        });
        self.sessions
            .lock()
            .insert(session_id.clone(), managed.clone());

        emit_state(&app, &session_id, "connected", None);

        let output_session_id = session_id.clone();
        let output_app = app.clone();
        thread::spawn(move || {
            let mut buffer = vec![0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if output
                            .send(Response::new(buffer[..count].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        emit_state(
                            &output_app,
                            &output_session_id,
                            "error",
                            Some(format!("Terminal output failed: {error}")),
                        );
                        break;
                    }
                }
            }
        });

        let wait_session_id = session_id.clone();
        let wait_app = app;
        let sessions = self.sessions.clone();
        thread::spawn(move || {
            let result = child.wait();
            sessions.lock().remove(&wait_session_id);
            match result {
                Ok(status) if status.success() => {
                    emit_state(&wait_app, &wait_session_id, "disconnected", None)
                }
                Ok(status) => emit_state(
                    &wait_app,
                    &wait_session_id,
                    "disconnected",
                    Some(format!("SSH exited with code {}", status.exit_code())),
                ),
                Err(error) => emit_state(
                    &wait_app,
                    &wait_session_id,
                    "error",
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

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self.get(session_id)?;
        session
            .killer
            .lock()
            .kill()
            .map_err(|error| format!("Could not close SSH process: {error}"))
    }

    pub fn close_all(&self) {
        for session in self.sessions.lock().values() {
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

fn emit_state(app: &AppHandle, session_id: &str, state: &str, reason: Option<String>) {
    let _ = app.emit(
        "session-state-changed",
        SessionStateEvent {
            session_id: session_id.into(),
            state: state.into(),
            reason,
        },
    );
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        sync::mpsc,
        time::{Duration, Instant},
    };

    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

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
