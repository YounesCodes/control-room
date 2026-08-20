use std::{
    collections::HashMap,
    io::{Read, Write},
    process::{Child, Stdio},
    sync::Arc,
    thread,
    time::Duration,
};

use chrono::Utc;
use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, ipc::Channel, ipc::Response};
use uuid::Uuid;
use wait_timeout::ChildExt;
use zeroize::Zeroizing;

use crate::{
    models::{
        DockerContainer, HostCapabilities, SavedConnection, StreamStarted, StreamStateEvent,
        SystemdService,
    },
    ssh::{
        background_command, connection_arguments, detect_ssh_path, validate_container_id,
        validate_service_name,
    },
};

const OUTPUT_LIMIT: u64 = 5 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

impl CommandOutput {
    fn success_text(self) -> Result<String, String> {
        if self.exit_code != 0 {
            return Err(classify_failure(self.exit_code, &self.stderr));
        }
        String::from_utf8(self.stdout).map_err(|_| "Remote output was not valid UTF-8".into())
    }
}

pub struct RemoteCommandExecutor;

impl RemoteCommandExecutor {
    pub fn execute(
        connection: &SavedConnection,
        remote_command: &str,
    ) -> Result<CommandOutput, String> {
        run_ssh(connection, remote_command, None)
    }

    pub fn execute_with_sudo(
        connection: &SavedConnection,
        remote_command: &str,
        password: String,
    ) -> Result<CommandOutput, String> {
        let password = Zeroizing::new(password);
        let elevated = format!("sudo -S -p '[control-room-sudo]' -- {remote_command}");
        run_ssh(connection, &elevated, Some(password.as_bytes()))
    }

    pub fn execute_with_input(
        connection: &SavedConnection,
        remote_command: &str,
        input: &[u8],
    ) -> Result<CommandOutput, String> {
        run_ssh(connection, remote_command, Some(input))
    }
}

pub fn discover_capabilities(connection: &SavedConnection) -> Result<HostCapabilities, String> {
    let command = r#"LC_ALL=C; printf 'hostname=%s\n' "$(hostname 2>/dev/null)"; if test -r /etc/os-release; then . /etc/os-release; printf 'os_id=%s\n' "$ID"; printf 'os_name=%s\n' "$NAME"; printf 'os_version=%s\n' "$VERSION_ID"; fi; printf 'kernel=%s\n' "$(uname -r 2>/dev/null)"; printf 'architecture=%s\n' "$(uname -m 2>/dev/null)"; printf 'uptime=%s\n' "$(uptime -p 2>/dev/null || true)"; printf 'default_shell=%s\n' "$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; command -v systemctl >/dev/null 2>&1 && printf 'systemd_available=true\n' || printf 'systemd_available=false\n'; command -v journalctl >/dev/null 2>&1 && printf 'journald_available=true\n' || printf 'journald_available=false\n'; if command -v docker >/dev/null 2>&1; then printf 'docker_available=true\n'; printf 'docker_version=%s\n' "$(docker version --format '{{.Server.Version}}' 2>/dev/null || docker --version 2>/dev/null)"; if docker info >/dev/null 2>&1; then printf 'docker_accessible=true\n'; printf 'running_container_count=%s\n' "$(docker ps -q | wc -l)"; printf 'total_container_count=%s\n' "$(docker ps -aq | wc -l)"; else printf 'docker_accessible=false\n'; fi; else printf 'docker_available=false\n'; printf 'docker_accessible=false\n'; fi; if command -v systemctl >/dev/null 2>&1; then printf 'running_service_count=%s\n' "$(systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | wc -l)"; fi"#;
    let text = RemoteCommandExecutor::execute(connection, command)?.success_text()?;
    let values = parse_key_values(&text);
    Ok(HostCapabilities {
        connection_id: connection.id.clone(),
        hostname: values.get("hostname").cloned(),
        os_id: values.get("os_id").cloned(),
        os_name: values.get("os_name").cloned(),
        os_version: values.get("os_version").cloned(),
        kernel: values.get("kernel").cloned(),
        architecture: values.get("architecture").cloned(),
        uptime: values.get("uptime").cloned(),
        default_shell: values.get("default_shell").cloned(),
        systemd_available: is_true(&values, "systemd_available"),
        journald_available: is_true(&values, "journald_available"),
        docker_available: is_true(&values, "docker_available"),
        docker_accessible: is_true(&values, "docker_accessible"),
        docker_version: values
            .get("docker_version")
            .filter(|value| !value.is_empty())
            .cloned(),
        running_service_count: parse_count(&values, "running_service_count"),
        running_container_count: parse_count(&values, "running_container_count"),
        total_container_count: parse_count(&values, "total_container_count"),
        detected_at: Utc::now().to_rfc3339(),
    })
}

pub fn list_services(connection: &SavedConnection) -> Result<Vec<SystemdService>, String> {
    let command = "LC_ALL=C systemctl show --type=service --all --no-pager --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState";
    let text = RemoteCommandExecutor::execute(connection, command)?.success_text()?;
    Ok(parse_services(&text))
}

pub fn get_service(
    connection: &SavedConnection,
    service_name: &str,
) -> Result<SystemdService, String> {
    let name = validate_service_name(service_name)?;
    let command = format!(
        "LC_ALL=C systemctl show '{name}' --no-pager --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState"
    );
    let text = RemoteCommandExecutor::execute(connection, &command)?.success_text()?;
    parse_services(&text)
        .into_iter()
        .next()
        .ok_or_else(|| "Service was not found".into())
}

pub fn list_containers(
    connection: &SavedConnection,
    sudo_password: Option<String>,
) -> Result<Vec<DockerContainer>, String> {
    let command = "docker ps -a --no-trunc --format '{{json .}}'";
    let output = if let Some(password) = sudo_password {
        RemoteCommandExecutor::execute_with_sudo(connection, command, password)?
    } else {
        RemoteCommandExecutor::execute(connection, command)?
    };
    let text = output.success_text()?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_container)
        .collect()
}

fn run_ssh(
    connection: &SavedConnection,
    remote_command: &str,
    stdin: Option<&[u8]>,
) -> Result<CommandOutput, String> {
    let ssh_path =
        detect_ssh_path().ok_or_else(|| "Windows OpenSSH client was not found".to_string())?;
    let mut arguments = connection_arguments(connection, false);
    arguments.push(remote_command.into());
    let mut child = background_command(ssh_path)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("SSH process could not start: {error}"))?;

    if let Some(bytes) = stdin {
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin
                .write_all(bytes)
                .and_then(|_| child_stdin.write_all(b"\n"))
                .map_err(|error| format!("Could not send sudo credential: {error}"))?;
        }
    } else {
        drop(child.stdin.take());
    }

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout_reader = thread::spawn(move || read_limited(stdout));
    let stderr_reader = thread::spawn(move || read_limited(stderr));
    let status = match child
        .wait_timeout(COMMAND_TIMEOUT)
        .map_err(|error| error.to_string())?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Remote command timed out after 20 seconds".into());
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Remote output reader panicked".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Remote error reader panicked".to_string())??;
    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(255),
    })
}

fn read_limited(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("Remote command output exceeded 5 MiB".into());
    }
    Ok(bytes)
}

fn classify_failure(code: i32, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let lower = stderr.to_ascii_lowercase();
    let category = if lower.contains("permission denied") || lower.contains("access denied") {
        "Permission denied"
    } else if lower.contains("could not resolve hostname") {
        "Host could not be resolved"
    } else if lower.contains("connection refused") {
        "Connection refused"
    } else if lower.contains("timed out") {
        "Connection timed out"
    } else if lower.contains("host key verification failed") {
        "Host-key verification failed"
    } else {
        "Remote command failed"
    };
    if stderr.is_empty() {
        format!("{category} with exit code {code}")
    } else {
        format!("{category}: {stderr}")
    }
}

fn parse_key_values(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().into(), value.trim().into()))
        .collect()
}

fn is_true(values: &HashMap<String, String>, key: &str) -> bool {
    values.get(key).is_some_and(|value| value == "true")
}

fn parse_count(values: &HashMap<String, String>, key: &str) -> Option<u32> {
    values.get(key).and_then(|value| value.parse().ok())
}

fn parse_services(text: &str) -> Vec<SystemdService> {
    text.split("\n\n")
        .filter_map(|block| {
            let values = parse_key_values(block);
            let id = values.get("Id")?.clone();
            Some(SystemdService {
                id,
                description: values.get("Description").cloned().unwrap_or_default(),
                load_state: values.get("LoadState").cloned().unwrap_or_default(),
                active_state: values.get("ActiveState").cloned().unwrap_or_default(),
                sub_state: values.get("SubState").cloned().unwrap_or_default(),
                unit_file_state: values
                    .get("UnitFileState")
                    .filter(|value| !value.is_empty())
                    .cloned(),
            })
        })
        .collect()
}

fn parse_container(line: &str) -> Result<DockerContainer, String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("Docker returned invalid JSON: {error}"))?;
    let string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Ok(DockerContainer {
        id: string("ID"),
        name: string("Names"),
        image: string("Image"),
        state: string("State"),
        status: string("Status"),
        ports: string("Ports"),
        created_at: string("CreatedAt"),
    })
}

struct ManagedStream {
    child: Mutex<Child>,
}

pub struct LogStreamOptions {
    pub lines: u16,
    pub follow: bool,
    pub sudo_password: Option<String>,
    pub output: Channel<Response>,
}

#[derive(Clone, Default)]
pub struct StreamManager {
    streams: Arc<Mutex<HashMap<String, Arc<ManagedStream>>>>,
}

impl StreamManager {
    pub fn start_journal(
        &self,
        app: AppHandle,
        connection: &SavedConnection,
        service: &str,
        options: LogStreamOptions,
    ) -> Result<StreamStarted, String> {
        let LogStreamOptions {
            lines,
            follow,
            sudo_password,
            output,
        } = options;
        let service = validate_service_name(service)?;
        validate_tail(lines)?;
        let command = format!(
            "journalctl -u '{service}' -n {lines} --no-pager -o short-iso-precise{}",
            if follow { " -f" } else { "" }
        );
        self.start(app, connection, command, sudo_password, output)
    }

    pub fn start_docker_logs(
        &self,
        app: AppHandle,
        connection: &SavedConnection,
        container: &str,
        options: LogStreamOptions,
    ) -> Result<StreamStarted, String> {
        let LogStreamOptions {
            lines,
            follow,
            sudo_password,
            output,
        } = options;
        let container = validate_container_id(container)?;
        validate_tail(lines)?;
        let command = format!(
            "docker logs --tail {lines}{} '{container}'",
            if follow { " --follow" } else { "" }
        );
        self.start(app, connection, command, sudo_password, output)
    }

    fn start(
        &self,
        app: AppHandle,
        connection: &SavedConnection,
        command: String,
        sudo_password: Option<String>,
        output: Channel<Response>,
    ) -> Result<StreamStarted, String> {
        let ssh_path =
            detect_ssh_path().ok_or_else(|| "Windows OpenSSH client was not found".to_string())?;
        let mut arguments = connection_arguments(connection, false);
        let remote_command = if sudo_password.is_some() {
            format!("sudo -S -p '[control-room-sudo]' -- {command}")
        } else {
            command
        };
        arguments.push(remote_command);
        let mut child = background_command(ssh_path)
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Log stream could not start: {error}"))?;
        if let Some(password) = sudo_password {
            let password = Zeroizing::new(password);
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(password.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .map_err(|error| error.to_string())?;
            }
        } else {
            drop(child.stdin.take());
        }
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let stream_id = Uuid::new_v4().to_string();
        let managed = Arc::new(ManagedStream {
            child: Mutex::new(child),
        });
        self.streams
            .lock()
            .insert(stream_id.clone(), managed.clone());

        let output_id = stream_id.clone();
        let output_app = app.clone();
        thread::spawn(move || {
            let mut buffer = vec![0_u8; 16 * 1024];
            loop {
                match stdout.read(&mut buffer) {
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
                        emit_stream_state(
                            &output_app,
                            &output_id,
                            "error",
                            Some(error.to_string()),
                        );
                        break;
                    }
                }
            }
        });

        let wait_id = stream_id.clone();
        let wait_app = app;
        let streams = self.streams.clone();
        thread::spawn(move || {
            let mut error_bytes = Vec::new();
            let _ = stderr.take(64 * 1024).read_to_end(&mut error_bytes);
            loop {
                let status = managed.child.lock().try_wait();
                match status {
                    Ok(Some(status)) => {
                        streams.lock().remove(&wait_id);
                        if status.success() {
                            emit_stream_state(&wait_app, &wait_id, "stopped", None);
                        } else {
                            emit_stream_state(
                                &wait_app,
                                &wait_id,
                                "error",
                                Some(classify_failure(status.code().unwrap_or(255), &error_bytes)),
                            );
                        }
                        break;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                    Err(error) => {
                        emit_stream_state(&wait_app, &wait_id, "error", Some(error.to_string()));
                        break;
                    }
                }
            }
        });

        Ok(StreamStarted { stream_id })
    }

    pub fn stop(&self, stream_id: &str) -> Result<(), String> {
        let stream = self
            .streams
            .lock()
            .get(stream_id)
            .cloned()
            .ok_or_else(|| "Log Stream is no longer active".to_string())?;
        stream
            .child
            .lock()
            .kill()
            .map_err(|error| error.to_string())
    }

    pub fn stop_all(&self) {
        for stream in self.streams.lock().values() {
            let _ = stream.child.lock().kill();
        }
    }
}

fn emit_stream_state(app: &AppHandle, stream_id: &str, state: &str, reason: Option<String>) {
    let _ = app.emit(
        "stream-state-changed",
        StreamStateEvent {
            stream_id: stream_id.into(),
            state: state.into(),
            reason,
        },
    );
}

fn validate_tail(lines: u16) -> Result<(), String> {
    if [50, 100, 200, 500, 1000].contains(&lines) {
        Ok(())
    } else {
        Err("Unsupported log tail count".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_connection() -> SavedConnection {
        SavedConnection {
            id: "live-fixture".into(),
            display_name: "Debian laptop".into(),
            destination: std::env::var("CONTROL_ROOM_TEST_HOST")
                .expect("CONTROL_ROOM_TEST_HOST is required"),
            username: std::env::var("CONTROL_ROOM_TEST_USER").ok(),
            port: std::env::var("CONTROL_ROOM_TEST_PORT")
                .ok()
                .and_then(|value| value.parse().ok()),
            identity_file: None,
            history_enabled: false,
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        }
    }

    #[test]
    fn parses_systemd_show_blocks() {
        let services = parse_services(
            "Id=nginx.service\nDescription=nginx\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n\nId=old.service\nDescription=Old\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n",
        );
        assert_eq!(services.len(), 2);
        assert_eq!(services[0].id, "nginx.service");
        assert_eq!(services[1].active_state, "inactive");
    }

    #[test]
    fn parses_docker_json_lines() {
        let container = parse_container(
            r#"{"ID":"abc","Names":"npmplus","Image":"docker.io/npmplus","State":"running","Status":"Up","Ports":"80/tcp","CreatedAt":"today"}"#,
        )
        .unwrap();
        assert_eq!(container.name, "npmplus");
        assert_eq!(container.state, "running");
    }

    #[test]
    fn classifies_useful_ssh_errors() {
        assert!(classify_failure(255, b"Permission denied (publickey)").starts_with("Permission"));
        assert!(classify_failure(255, b"Connection refused").starts_with("Connection refused"));
    }

    #[test]
    #[ignore = "requires the explicitly configured Debian SSH fixture"]
    fn live_fixture_supports_structured_features() {
        let connection = live_connection();
        let capabilities = discover_capabilities(&connection).unwrap();
        assert_eq!(capabilities.os_id.as_deref(), Some("debian"));
        assert!(capabilities.systemd_available);
        assert!(capabilities.journald_available);
        assert!(capabilities.docker_available);
        let services = list_services(&connection).unwrap();
        assert!(!services.is_empty());
        let _containers = list_containers(&connection, None).unwrap();
    }
}
