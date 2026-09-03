use std::{
    collections::HashMap,
    io::{Read, Write},
    process::{Child, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use parking_lot::{Condvar, Mutex};
use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, ipc::Channel, ipc::Response};
use uuid::Uuid;
use wait_timeout::ChildExt;
use zeroize::Zeroizing;

use crate::{
    models::{
        ConnectionRemote, ConnectionSummary, DockerContainer, DockerContainerDetails, DockerMount,
        DockerNetworkAttachment, DockerPublishedPort, EstablishedConnections, FirewallRule,
        FirewallStatus, HostCapabilities, LOG_TAIL_OPTIONS, ListeningSocket, SavedConnection,
        StreamStarted, StreamStateEvent, SystemdUnit,
    },
    ssh::{
        background_command, connection_arguments, detect_ssh_path, validate_container_id,
        validate_systemd_unit_id,
    },
};

const OUTPUT_LIMIT: u64 = 5 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_STRUCTURED_OPERATIONS_PER_CONNECTION: usize = 2;
const MAX_STRUCTURED_QUEUE_WAIT: Duration = Duration::from_secs(4);
const STREAM_DIAGNOSTIC_LIMIT: usize = 64 * 1024;
const MAX_FIREWALL_RULES: usize = 200;
const MAX_CONNECTION_ROWS: usize = 4000;
const MAX_CONNECTION_GROUPS: usize = 200;
const MAX_CONNECTION_REMOTES: usize = 20;

#[derive(Default)]
pub struct RemoteOperationLimiter {
    hosts: Arc<Mutex<HashMap<String, Arc<HostOperationLimit>>>>,
}

#[derive(Default)]
struct HostOperationLimit {
    active: Mutex<usize>,
    available: Condvar,
}

pub struct RemoteOperationPermit {
    connection_id: String,
    host: Arc<HostOperationLimit>,
    hosts: Arc<Mutex<HashMap<String, Arc<HostOperationLimit>>>>,
}

impl RemoteOperationLimiter {
    pub fn acquire(&self, connection_id: &str) -> Result<RemoteOperationPermit, String> {
        self.acquire_for(connection_id, MAX_STRUCTURED_QUEUE_WAIT)
    }

    fn acquire_for(
        &self,
        connection_id: &str,
        maximum_wait: Duration,
    ) -> Result<RemoteOperationPermit, String> {
        let connection_id = connection_id.to_owned();
        let host = self
            .hosts
            .lock()
            .entry(connection_id.clone())
            .or_default()
            .clone();
        let mut active = host.active.lock();
        while *active >= MAX_STRUCTURED_OPERATIONS_PER_CONNECTION {
            if host
                .available
                .wait_for(&mut active, maximum_wait)
                .timed_out()
                && *active >= MAX_STRUCTURED_OPERATIONS_PER_CONNECTION
            {
                drop(active);
                let mut hosts = self.hosts.lock();
                let remove = hosts.get(&connection_id).is_some_and(|tracked| {
                    Arc::ptr_eq(tracked, &host) && *tracked.active.lock() == 0
                });
                if remove {
                    hosts.remove(&connection_id);
                }
                return Err("Remote operation queue was busy for 4 seconds".into());
            }
        }
        *active += 1;
        drop(active);
        Ok(RemoteOperationPermit {
            connection_id,
            host,
            hosts: self.hosts.clone(),
        })
    }

    #[cfg(test)]
    fn tracked_connections(&self) -> usize {
        self.hosts.lock().len()
    }
}

impl Drop for RemoteOperationPermit {
    fn drop(&mut self) {
        let mut active = self.host.active.lock();
        *active = active.saturating_sub(1);
        let idle = *active == 0;
        self.host.available.notify_one();
        drop(active);

        if idle {
            let mut hosts = self.hosts.lock();
            let remove = hosts
                .get(&self.connection_id)
                .is_some_and(|host| Arc::ptr_eq(host, &self.host) && *host.active.lock() == 0);
            if remove {
                hosts.remove(&self.connection_id);
            }
        }
    }
}

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
        operation: &'static str,
        remote_command: &str,
    ) -> Result<CommandOutput, String> {
        run_ssh(connection, operation, remote_command, None)
    }

    pub fn execute_with_sudo(
        connection: &SavedConnection,
        operation: &'static str,
        remote_command: &str,
        password: String,
    ) -> Result<CommandOutput, String> {
        let password = Zeroizing::new(password);
        let elevated = format!("sudo -S -p '[control-room-sudo]' -- {remote_command}");
        run_ssh(connection, operation, &elevated, Some(password.as_bytes()))
    }

    pub fn execute_with_input(
        connection: &SavedConnection,
        operation: &'static str,
        remote_command: &str,
        input: &[u8],
    ) -> Result<CommandOutput, String> {
        run_ssh(connection, operation, remote_command, Some(input))
    }
}

pub fn discover_capabilities(connection: &SavedConnection) -> Result<HostCapabilities, String> {
    let command = r#"LC_ALL=C; printf 'hostname=%s\n' "$(hostname 2>/dev/null)"; if test -r /etc/os-release; then . /etc/os-release; printf 'os_id=%s\n' "$ID"; printf 'os_name=%s\n' "$NAME"; printf 'os_version=%s\n' "$VERSION_ID"; fi; printf 'kernel=%s\n' "$(uname -r 2>/dev/null)"; printf 'architecture=%s\n' "$(uname -m 2>/dev/null)"; printf 'uptime=%s\n' "$(uptime -p 2>/dev/null || true)"; printf 'default_shell=%s\n' "$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; command -v systemctl >/dev/null 2>&1 && printf 'systemd_available=true\n' || printf 'systemd_available=false\n'; command -v journalctl >/dev/null 2>&1 && printf 'journald_available=true\n' || printf 'journald_available=false\n'; if command -v docker >/dev/null 2>&1; then printf 'docker_available=true\n'; printf 'docker_version=%s\n' "$(docker version --format '{{.Server.Version}}' 2>/dev/null || docker --version 2>/dev/null)"; if docker info >/dev/null 2>&1; then printf 'docker_accessible=true\n'; printf 'running_container_count=%s\n' "$(docker ps -q | wc -l)"; printf 'total_container_count=%s\n' "$(docker ps -aq | wc -l)"; else printf 'docker_accessible=false\n'; fi; else printf 'docker_available=false\n'; printf 'docker_accessible=false\n'; fi; if command -v systemctl >/dev/null 2>&1; then printf 'running_service_count=%s\n' "$(systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | wc -l)"; fi"#;
    let text = RemoteCommandExecutor::execute(connection, "discover_capabilities", command)?
        .success_text()?;
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

pub fn list_services(connection: &SavedConnection) -> Result<Vec<SystemdUnit>, String> {
    let command = systemd_unit_list_command();
    let text =
        RemoteCommandExecutor::execute(connection, "list_services", command)?.success_text()?;
    Ok(parse_systemd_units(&text))
}

pub fn list_containers(
    connection: &SavedConnection,
    sudo_password: Option<String>,
) -> Result<Vec<DockerContainer>, String> {
    let command = docker_container_list_command();
    let output = if let Some(password) = sudo_password {
        RemoteCommandExecutor::execute_with_sudo(connection, "list_containers", command, password)?
    } else {
        RemoteCommandExecutor::execute(connection, "list_containers", command)?
    };
    let text = output.success_text()?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_container)
        .collect()
}

pub fn list_ports(
    connection: &SavedConnection,
    sudo_password: Option<String>,
) -> Result<Vec<ListeningSocket>, String> {
    let command = port_list_command();
    let output = if let Some(password) = sudo_password {
        RemoteCommandExecutor::execute_with_sudo(connection, "list_ports", command, password)?
    } else {
        RemoteCommandExecutor::execute(connection, "list_ports", command)?
    };
    parse_listening_sockets(&output.success_text()?)
}

pub fn inspect_container(
    connection: &SavedConnection,
    container_id: &str,
    sudo_password: Option<String>,
) -> Result<DockerContainerDetails, String> {
    let container_id = validate_stable_container_id(container_id)?;
    let command = docker_container_inspect_command(container_id);
    let output = if let Some(password) = sudo_password {
        RemoteCommandExecutor::execute_with_sudo(
            connection,
            "inspect_container",
            &command,
            password,
        )?
    } else {
        RemoteCommandExecutor::execute(connection, "inspect_container", &command)?
    };
    if output.exit_code != 0 && is_missing_container(&output.stderr) {
        return Err("Container no longer exists. Refresh the container list.".into());
    }
    let text = output.success_text()?;
    let details = parse_container_details(&text)?;
    if details.id != container_id {
        return Err("Docker returned details for an unexpected container".into());
    }
    Ok(details)
}

fn is_missing_container(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr)
        .to_ascii_lowercase()
        .contains("no such object")
}

fn run_ssh(
    connection: &SavedConnection,
    operation: &'static str,
    remote_command: &str,
    stdin: Option<&[u8]>,
) -> Result<CommandOutput, String> {
    let started_at = Instant::now();
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
    let spawned_at = Instant::now();

    if let Some(bytes) = stdin {
        let Some(mut child_stdin) = child.stdin.take() else {
            terminate_child(&mut child);
            return Err("SSH process stdin was unavailable".into());
        };
        if let Err(error) = child_stdin
            .write_all(bytes)
            .and_then(|_| child_stdin.write_all(b"\n"))
        {
            terminate_child(&mut child);
            return Err(format!("Could not send process input: {error}"));
        }
    } else {
        drop(child.stdin.take());
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        terminate_child(&mut child);
        "SSH process stdout was unavailable".to_string()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        terminate_child(&mut child);
        "SSH process stderr was unavailable".to_string()
    })?;
    let (first_byte_tx, first_byte_rx) = mpsc::channel();
    let stdout_first_byte = first_byte_tx.clone();
    let stdout_reader = thread::spawn(move || read_limited(stdout, stdout_first_byte));
    let stderr_reader = thread::spawn(move || read_limited(stderr, first_byte_tx));
    let status = match child.wait_timeout(COMMAND_TIMEOUT) {
        Ok(Some(status)) => status,
        Ok(None) => {
            terminate_child(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            log_operation_timing(operation, started_at, spawned_at, None, "timeout");
            return Err("Remote command timed out after 20 seconds".into());
        }
        Err(error) => {
            terminate_child(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!("Could not wait for SSH process: {error}"));
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Remote output reader panicked".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Remote error reader panicked".to_string())??;
    let first_byte_at = first_byte_rx.try_iter().min();
    log_operation_timing(
        operation,
        started_at,
        spawned_at,
        first_byte_at,
        if status.success() { "ok" } else { "failed" },
    );
    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(255),
    })
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn read_limited(
    mut reader: impl Read,
    first_byte: mpsc::Sender<Instant>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        if bytes.is_empty() {
            let _ = first_byte.send(Instant::now());
        }
        if bytes.len() + count > OUTPUT_LIMIT as usize {
            return Err("Remote command output exceeded 5 MiB".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(bytes)
}

fn log_operation_timing(
    operation: &str,
    started_at: Instant,
    spawned_at: Instant,
    first_byte_at: Option<Instant>,
    outcome: &str,
) {
    let first_byte_ms = first_byte_at
        .map(|value| value.duration_since(started_at).as_millis().to_string())
        .unwrap_or_else(|| "none".into());
    eprintln!(
        "[control-room] remote_operation={operation} spawn_ms={} first_byte_ms={first_byte_ms} total_ms={} outcome={outcome}",
        spawned_at.duration_since(started_at).as_millis(),
        started_at.elapsed().as_millis(),
    );
}

fn classify_failure(code: i32, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let lower = stderr.to_ascii_lowercase();
    let category = if lower.contains("permission denied")
        || lower.contains("access denied")
        || lower.contains("you need to be root")
        || lower.contains("operation not permitted")
    {
        "Permission denied"
    } else if lower.contains("could not resolve hostname") {
        "Host could not be resolved"
    } else if lower.contains("connection refused") {
        "Connection refused"
    } else if lower.contains("timed out") {
        "Connection timed out"
    } else if lower.contains("host key verification failed") {
        "Host-key verification failed"
    } else if lower.contains("command not found")
        || lower.contains("docker: not found")
        || lower.contains("journalctl: not found")
        || lower.contains("systemctl: not found")
        || (lower.contains("no such file or directory")
            && (lower.contains("docker")
                || lower.contains("journalctl")
                || lower.contains("systemctl")))
    {
        "Feature is not installed on this host"
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

fn parse_systemd_units(text: &str) -> Vec<SystemdUnit> {
    let mut units: Vec<_> = text
        .split("\n\n")
        .filter_map(|block| {
            let values = parse_key_values(block);
            let id = values.get("Id")?.clone();
            let unit_type = id.rsplit_once('.')?.1.to_string();
            if !["service", "timer", "mount", "socket"].contains(&unit_type.as_str()) {
                return None;
            }
            Some(SystemdUnit {
                id,
                unit_type,
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
        .collect();
    units.sort_by(|left, right| {
        let left_failed = left.active_state == "failed";
        let right_failed = right.active_state == "failed";
        right_failed
            .cmp(&left_failed)
            .then_with(|| left.unit_type.cmp(&right.unit_type))
            .then_with(|| left.id.cmp(&right.id))
    });
    units
}

fn systemd_unit_list_command() -> &'static str {
    "LC_ALL=C systemctl show --type=service,timer,mount,socket --all --no-pager --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState"
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
    let compose_project = valid_compose_project(&string("ComposeProject"));
    let compose_service = valid_compose_service(&string("ComposeService"));
    let (compose_project, compose_service, compose_container_number, compose_oneoff) =
        match (compose_project, compose_service) {
            (Some(project), Some(service)) => (
                Some(project),
                Some(service),
                string("ComposeContainerNumber")
                    .parse::<u32>()
                    .ok()
                    .filter(|number| *number > 0),
                match string("ComposeOneoff").to_ascii_lowercase().as_str() {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => None,
                },
            ),
            _ => (None, None, None, None),
        };
    Ok(DockerContainer {
        id: string("ID"),
        name: string("Names"),
        image: string("Image"),
        state: string("State"),
        status: string("Status"),
        ports: string("Ports"),
        created_at: string("CreatedAt"),
        compose_project,
        compose_service,
        compose_container_number,
        compose_oneoff,
    })
}

fn docker_container_list_command() -> &'static str {
    r#"docker ps -a --no-trunc --format '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}},"Ports":{{json .Ports}},"CreatedAt":{{json .CreatedAt}},"ComposeProject":{{json (.Label "com.docker.compose.project")}},"ComposeService":{{json (.Label "com.docker.compose.service")}},"ComposeContainerNumber":{{json (.Label "com.docker.compose.container-number")}},"ComposeOneoff":{{json (.Label "com.docker.compose.oneoff")}}}'"#
}

const PROCESS_UNIT_MARKER: &str = "__CONTROL_ROOM_PROCESS_UNITS__";

fn port_list_command() -> &'static str {
    r#"env LC_ALL=C sh -c 'ss -H -lntupO; status=$?; test $status -eq 0 || exit $status; printf "\n__CONTROL_ROOM_PROCESS_UNITS__\n"; ps -eo pid=,unit=,comm= 2>/dev/null || true'"#
}

fn parse_listening_sockets(text: &str) -> Result<Vec<ListeningSocket>, String> {
    let (socket_text, process_text) = text
        .split_once(PROCESS_UNIT_MARKER)
        .ok_or_else(|| "Socket inspection returned an incomplete result".to_string())?;
    let process_units = parse_process_units(process_text);
    let mut sockets = Vec::new();

    for (index, line) in socket_text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        let protocol = match fields[0].trim_end_matches(|character| ['4', '6'].contains(&character))
        {
            "tcp" => "tcp",
            "udp" => "udp",
            _ => continue,
        };
        let Some((local_address, port)) = parse_local_endpoint(fields[4]) else {
            continue;
        };
        let process_evidence =
            without_activation_supervisor(parse_process_evidence(&fields[6..].join(" ")));
        let (process_name, process_id, ownership) = match process_evidence.as_slice() {
            [] => (None, None, "unavailable"),
            [(pid, name)] => (Some(name.clone()), Some(*pid), "known"),
            entries => {
                // Several PIDs hold the same listening socket — the common
                // prefork/worker pattern (nginx, apache-prefork, php-fpm,
                // postgres). The process name stays an unambiguous kernel fact
                // when every holder shares it, so keep it for display and
                // filtering; the owning PID (and any systemd correlation) is
                // genuinely ambiguous and is withheld.
                let first_name = &entries[0].1;
                if entries.iter().all(|(_, name)| name == first_name) {
                    (Some(first_name.clone()), None, "ambiguous")
                } else {
                    (None, None, "ambiguous")
                }
            }
        };
        let systemd_unit = process_id.and_then(|pid| process_units.get(&pid)).cloned();
        let address_family = if local_address.contains(':') {
            "ipv6"
        } else {
            "ipv4"
        };
        sockets.push(ListeningSocket {
            id: format!("{protocol}:{local_address}:{port}:{index}"),
            protocol: protocol.into(),
            address_family: address_family.into(),
            local_address,
            port,
            process_name,
            process_id,
            systemd_unit,
            ownership: ownership.into(),
        });
    }

    sockets.sort_by(|left, right| {
        left.port
            .cmp(&right.port)
            .then_with(|| left.protocol.cmp(&right.protocol))
            .then_with(|| left.local_address.cmp(&right.local_address))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(sockets)
}

fn parse_local_endpoint(value: &str) -> Option<(String, u16)> {
    let (address, port) = value.rsplit_once(':')?;
    let port = port.parse::<u16>().ok()?;
    let address = address
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    (!address.is_empty()).then_some((address, port))
}

fn parse_process_evidence(value: &str) -> Vec<(u32, String)> {
    let pattern =
        Regex::new(r#"\(\"([^\"]+)\",pid=(\d+)"#).expect("the socket process pattern is valid");
    let mut evidence = pattern
        .captures_iter(value)
        .filter_map(|capture| {
            Some((
                capture.get(2)?.as_str().parse::<u32>().ok()?,
                capture.get(1)?.as_str().to_string(),
            ))
        })
        .collect::<Vec<_>>();
    evidence.sort();
    evidence.dedup();
    evidence
}

/// Drops systemd's own claim on a socket-activated listener.
///
/// systemd holds the listening file descriptor for every socket unit it
/// activates, so `ss` reports both pid 1 and the real service on one socket.
/// That second claim describes how the service was started, not who is serving,
/// and treating it as a rival owner hides the answer on exactly the listeners
/// that matter most: ssh, docker, and anything else started from a `.socket`.
///
/// Only pid 1 named `systemd` is dropped, and only when another holder remains,
/// so a socket waiting on activation with no service behind it yet still reports
/// systemd as its owner.
fn without_activation_supervisor(evidence: Vec<(u32, String)>) -> Vec<(u32, String)> {
    if evidence.len() < 2 {
        return evidence;
    }
    let remaining: Vec<(u32, String)> = evidence
        .iter()
        .filter(|(pid, name)| !(*pid == 1 && name == "systemd"))
        .cloned()
        .collect();
    if remaining.is_empty() {
        evidence
    } else {
        remaining
    }
}

fn parse_process_units(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let unit = validate_systemd_unit_id(fields.next()?).ok()?.to_string();
            Some((pid, unit))
        })
        .collect()
}

fn bounded_text(value: &str, maximum_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(maximum_chars)
        .collect()
}

const FIREWALL_UNAVAILABLE_MARKER: &str = "__CR_FW_UNAVAILABLE__";

pub fn list_firewall(
    connection: &SavedConnection,
    sudo_password: Option<String>,
) -> Result<FirewallStatus, String> {
    let command = firewall_status_command();
    let output = if let Some(password) = sudo_password {
        RemoteCommandExecutor::execute_with_sudo(connection, "list_firewall", command, password)?
    } else {
        RemoteCommandExecutor::execute(connection, "list_firewall", command)?
    };
    Ok(parse_firewall_status(&output.success_text()?))
}

fn firewall_status_command() -> &'static str {
    // `ufw status` requires root; when run without privilege it exits non-zero
    // with a "you need to be root" message, which classify_failure maps to a
    // permission error so the UI can offer the existing sudo retry.
    r#"env LC_ALL=C sh -c 'if ! command -v ufw >/dev/null 2>&1; then printf "__CR_FW_UNAVAILABLE__\n"; exit 0; fi; ufw status verbose'"#
}

fn parse_firewall_status(text: &str) -> FirewallStatus {
    let collected_at = Utc::now().to_rfc3339();
    if text.contains(FIREWALL_UNAVAILABLE_MARKER) {
        return FirewallStatus {
            available: false,
            active: None,
            default_incoming: None,
            rules: Vec::new(),
            collected_at,
        };
    }

    let mut active = None;
    let mut default_incoming = None;
    let mut rules = Vec::new();
    let mut in_rules = false;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(status) = trimmed.strip_prefix("Status:") {
            active = Some(status.trim().eq_ignore_ascii_case("active"));
            continue;
        }
        if let Some(defaults) = trimmed.strip_prefix("Default:") {
            default_incoming = defaults
                .split(',')
                .find(|segment| segment.contains("(incoming)"))
                .and_then(|segment| segment.split_whitespace().next())
                .map(str::to_string);
            continue;
        }
        if trimmed.starts_with("To") && trimmed.contains("Action") {
            in_rules = true;
            continue;
        }
        if trimmed.starts_with("--") {
            continue;
        }
        if in_rules
            && rules.len() < MAX_FIREWALL_RULES
            && let Some(rule) = parse_firewall_rule(trimmed)
        {
            rules.push(rule);
        }
    }

    FirewallStatus {
        available: true,
        active,
        default_incoming,
        rules,
        collected_at,
    }
}

fn parse_firewall_rule(line: &str) -> Option<FirewallRule> {
    const ACTIONS: [&str; 4] = ["ALLOW", "DENY", "LIMIT", "REJECT"];
    const DIRECTIONS: [&str; 3] = ["IN", "OUT", "FWD"];
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let action_index = tokens.iter().position(|token| ACTIONS.contains(token))?;
    let to = tokens[..action_index].join(" ");
    if to.is_empty() {
        return None;
    }
    let action = tokens[action_index].to_string();
    let mut from_start = action_index + 1;
    if tokens
        .get(from_start)
        .is_some_and(|token| DIRECTIONS.contains(token))
    {
        from_start += 1;
    }
    let from = tokens
        .get(from_start..)
        .map(|rest| rest.join(" "))
        .unwrap_or_default();
    let ipv6 = to.contains("(v6)") || from.contains("(v6)");
    let (port, protocol) = parse_firewall_target(&to);
    Some(FirewallRule {
        to: bounded_text(&to, 120),
        action,
        from: bounded_text(if from.is_empty() { "Anywhere" } else { &from }, 120),
        port,
        protocol,
        ipv6,
    })
}

fn parse_firewall_target(to: &str) -> (Option<u16>, Option<String>) {
    let cleaned = to.replace("(v6)", "");
    let first = cleaned.split_whitespace().next().unwrap_or("");
    let (port_str, protocol) = match first.split_once('/') {
        Some((port, protocol)) => (port, Some(protocol.to_ascii_lowercase())),
        None => (first, None),
    };
    let port = port_str.parse::<u16>().ok();
    let protocol = protocol.filter(|value| value == "tcp" || value == "udp");
    (port, protocol)
}

pub fn list_connections(connection: &SavedConnection) -> Result<EstablishedConnections, String> {
    let text =
        RemoteCommandExecutor::execute(connection, "list_connections", connections_command())?
            .success_text()?;
    Ok(parse_established_connections(&text))
}

fn connections_command() -> &'static str {
    // One bounded, read-only snapshot of currently established TCP connections.
    // Process ownership is only visible for the caller's own processes without
    // privilege; peers without ownership still contribute to the counts.
    r#"env LC_ALL=C sh -c 'ss -H -tnp state established 2>/dev/null | head -n 4000; printf "\n__CONTROL_ROOM_PROCESS_UNITS__\n"; ps -eo pid=,unit=,comm= 2>/dev/null || true'"#
}

#[derive(Default)]
struct ConnectionAccumulator {
    protocol: String,
    local_port: u16,
    process_name: Option<String>,
    process_ids: std::collections::BTreeSet<u32>,
    systemd_unit: Option<String>,
    established: u32,
    remotes: HashMap<String, u32>,
}

fn parse_established_connections(text: &str) -> EstablishedConnections {
    let collected_at = Utc::now().to_rfc3339();
    let (connection_text, process_text) = match text.split_once(PROCESS_UNIT_MARKER) {
        Some(parts) => parts,
        None => (text, ""),
    };
    let process_units = parse_process_units(process_text);

    let mut groups: HashMap<String, ConnectionAccumulator> = HashMap::new();
    let mut rows = 0usize;
    let mut total_established = 0u32;

    for line in connection_text
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let mut endpoints = fields
            .iter()
            .enumerate()
            .filter_map(|(index, field)| parse_local_endpoint(field).map(|parsed| (index, parsed)));
        let Some((_, (_, local_port))) = endpoints.next() else {
            continue;
        };
        let Some((peer_index, (peer_address, _))) = endpoints.next() else {
            continue;
        };

        rows += 1;
        total_established = total_established.saturating_add(1);

        let evidence = parse_process_evidence(&fields[peer_index + 1..].join(" "));
        let (process_name, process_id) = match evidence.as_slice() {
            [] => (None, None),
            [(pid, name)] => (Some(name.clone()), Some(*pid)),
            entries => {
                let first_name = &entries[0].1;
                if entries.iter().all(|(_, name)| name == first_name) {
                    (Some(first_name.clone()), None)
                } else {
                    (None, None)
                }
            }
        };
        let systemd_unit = process_id.and_then(|pid| process_units.get(&pid)).cloned();

        let owner_key = systemd_unit
            .clone()
            .or_else(|| process_name.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let key = format!("tcp:{local_port}:{owner_key}");
        let entry = groups
            .entry(key.clone())
            .or_insert_with(|| ConnectionAccumulator {
                protocol: "tcp".to_string(),
                local_port,
                process_name: process_name.clone(),
                systemd_unit: systemd_unit.clone(),
                ..ConnectionAccumulator::default()
            });
        entry.established = entry.established.saturating_add(1);
        if let Some(pid) = process_id {
            entry.process_ids.insert(pid);
        }
        *entry
            .remotes
            .entry(bounded_text(&peer_address, 80))
            .or_insert(0) += 1;
    }

    let mut summaries: Vec<ConnectionSummary> = groups
        .into_iter()
        .map(|(key, accumulator)| {
            let remote_address_count = accumulator.remotes.len() as u32;
            let mut remotes: Vec<ConnectionRemote> = accumulator
                .remotes
                .into_iter()
                .map(|(address, count)| ConnectionRemote { address, count })
                .collect();
            remotes.sort_by(|left, right| {
                right
                    .count
                    .cmp(&left.count)
                    .then_with(|| left.address.cmp(&right.address))
            });
            remotes.truncate(MAX_CONNECTION_REMOTES);
            let process_id = if accumulator.process_ids.len() == 1 {
                accumulator.process_ids.iter().next().copied()
            } else {
                None
            };
            ConnectionSummary {
                key,
                protocol: accumulator.protocol,
                local_port: accumulator.local_port,
                process_name: accumulator.process_name,
                process_id,
                systemd_unit: accumulator.systemd_unit,
                established: accumulator.established,
                remote_address_count,
                remotes,
            }
        })
        .collect();

    summaries.sort_by(|left, right| {
        right
            .established
            .cmp(&left.established)
            .then_with(|| left.local_port.cmp(&right.local_port))
            .then_with(|| left.key.cmp(&right.key))
    });
    summaries.truncate(MAX_CONNECTION_GROUPS);

    EstablishedConnections {
        groups: summaries,
        total_established,
        truncated: rows >= MAX_CONNECTION_ROWS,
        collected_at,
    }
}

fn validate_stable_container_id(value: &str) -> Result<&str, String> {
    let value = validate_container_id(value)?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Container inspection requires a full Docker ID".into());
    }
    Ok(value)
}

fn docker_container_inspect_command(container_id: &str) -> String {
    // Emit the raw container JSON and parse it in Rust. A `docker inspect
    // --format` template cannot read optional nested fields such as
    // `.State.Health` safely: on a container with no healthcheck the field is
    // absent, and Docker's raw-JSON fallback runs the template with
    // `missingkey=error`, so even an `{{if .State.Health}}` guard fails with
    // "map has no entry for key". The container id is validated to 64 hex
    // characters before it reaches this command, so it carries no shell syntax.
    format!("docker inspect --type container -- '{container_id}'")
}

fn parse_container_details(text: &str) -> Result<DockerContainerDetails, String> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|error| format!("Docker inspect returned invalid JSON: {error}"))?;
    let elements = parsed
        .as_array()
        .ok_or_else(|| "Docker inspect returned an unexpected payload".to_string())?;
    if elements.len() != 1 {
        return Err("Docker inspect returned an unexpected number of containers".into());
    }
    let root = &elements[0];

    let mut details = parse_container_detail_header(root)?;

    let mut mounts = Vec::new();
    if let Some(entries) = root.get("Mounts").and_then(Value::as_array) {
        for entry in entries {
            if mounts.len() >= 2048 {
                return Err("Docker inspect returned too many mount records".into());
            }
            mounts.push(parse_container_mount(entry)?);
        }
    }

    let mut networks = Vec::new();
    if let Some(entries) = root
        .get("NetworkSettings")
        .and_then(|settings| settings.get("Networks"))
        .and_then(Value::as_object)
    {
        for (name, network) in entries {
            if networks.len() >= 2048 {
                return Err("Docker inspect returned too many network records".into());
            }
            networks.push(parse_container_network(name, network)?);
        }
    }

    let mut published_ports = Vec::new();
    if let Some(entries) = root
        .get("NetworkSettings")
        .and_then(|settings| settings.get("Ports"))
        .and_then(Value::as_object)
    {
        for (container_port, bindings) in entries {
            // An exposed-but-unpublished port maps to a null binding list.
            let Some(bindings) = bindings.as_array() else {
                continue;
            };
            for binding in bindings {
                if published_ports.len() >= 2048 {
                    return Err("Docker inspect returned too many published ports".into());
                }
                published_ports.push(parse_container_port(container_port, binding)?);
            }
        }
    }

    mounts.sort_by(|left, right| left.destination.cmp(&right.destination));
    networks.sort_by(|left, right| left.name.cmp(&right.name));
    published_ports.sort_by(|left, right| {
        left.host_port
            .cmp(&right.host_port)
            .then_with(|| left.host_address.cmp(&right.host_address))
            .then_with(|| left.container_port.cmp(&right.container_port))
    });
    details.mounts = mounts;
    details.networks = networks;
    details.published_ports = published_ports;
    Ok(details)
}

fn parse_container_detail_header(root: &Value) -> Result<DockerContainerDetails, String> {
    let state = root.get("State");
    let state_string = |key: &str| {
        state
            .and_then(|state| state.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let state_bool = |key: &str| {
        state
            .and_then(|state| state.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let state_timestamp = |key: &str| {
        state
            .and_then(|state| state.get(key))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && *value != "0001-01-01T00:00:00Z")
            .map(str::to_string)
    };
    let health = state.and_then(|state| state.get("Health"));

    let label = |key: &str| {
        root.get("Config")
            .and_then(|config| config.get("Labels"))
            .and_then(Value::as_object)
            .and_then(|labels| labels.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let compose_project = valid_compose_project(&label("com.docker.compose.project"));
    let compose_service = valid_compose_service(&label("com.docker.compose.service"));
    let (compose_project, compose_service, compose_container_number, compose_oneoff) =
        match (compose_project, compose_service) {
            (Some(project), Some(service)) => (
                Some(project),
                Some(service),
                label("com.docker.compose.container-number")
                    .parse::<u32>()
                    .ok()
                    .filter(|number| *number > 0),
                match label("com.docker.compose.oneoff")
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => None,
                },
            ),
            _ => (None, None, None, None),
        };

    let restart_policy = root
        .get("HostConfig")
        .and_then(|config| config.get("RestartPolicy"));

    Ok(DockerContainerDetails {
        id: root
            .get("Id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        name: root
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim_start_matches('/')
            .to_string(),
        image_reference: redact_registry_reference(
            root.get("Config")
                .and_then(|config| config.get("Image"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        image_content_id: root
            .get("Image")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        state: state_string("Status"),
        running: state_bool("Running"),
        paused: state_bool("Paused"),
        restarting: state_bool("Restarting"),
        oom_killed: state_bool("OOMKilled"),
        dead: state_bool("Dead"),
        exit_code: state
            .and_then(|state| state.get("ExitCode"))
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32,
        started_at: state_timestamp("StartedAt"),
        finished_at: state_timestamp("FinishedAt"),
        health_status: health
            .and_then(|health| health.get("Status"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        failing_streak: health
            .and_then(|health| health.get("FailingStreak"))
            .and_then(Value::as_u64)
            .and_then(|number| u32::try_from(number).ok()),
        restart_policy: restart_policy
            .and_then(|policy| policy.get("Name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        restart_maximum_retry_count: restart_policy
            .and_then(|policy| policy.get("MaximumRetryCount"))
            .and_then(Value::as_u64)
            .and_then(|number| u32::try_from(number).ok())
            .unwrap_or(0),
        published_ports: Vec::new(),
        networks: Vec::new(),
        mounts: Vec::new(),
        compose_project,
        compose_service,
        compose_container_number,
        compose_oneoff,
    })
}

fn parse_container_mount(value: &Value) -> Result<DockerMount, String> {
    let mount_type = required_json_string(value, "Type", "mount type")?;
    let destination = required_json_string(value, "Destination", "mount destination")?;
    Ok(DockerMount {
        mount_type,
        name: value
            .get("Name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        destination,
        writable: value.get("RW").and_then(Value::as_bool).unwrap_or(false),
        propagation: value
            .get("Propagation")
            .and_then(Value::as_str)
            .filter(|propagation| !propagation.is_empty())
            .map(str::to_string),
    })
}

fn parse_container_network(name: &str, value: &Value) -> Result<DockerNetworkAttachment, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 4096 || name.chars().any(char::is_control) {
        return Err("Docker inspect returned an invalid network name".into());
    }
    Ok(DockerNetworkAttachment {
        name: name.to_string(),
        ipv4_address: optional_json_string(value, "IPAddress"),
        ipv4_gateway: optional_json_string(value, "Gateway"),
        ipv6_address: optional_json_string(value, "GlobalIPv6Address"),
        ipv6_gateway: optional_json_string(value, "IPv6Gateway"),
    })
}

fn parse_container_port(
    container_port: &str,
    binding: &Value,
) -> Result<DockerPublishedPort, String> {
    let container_port = container_port.trim();
    if container_port.is_empty()
        || container_port.len() > 4096
        || container_port.chars().any(char::is_control)
    {
        return Err("Docker inspect returned an invalid container port".into());
    }
    let host_port = required_json_string(binding, "HostPort", "published host port")?
        .parse::<u16>()
        .map_err(|_| "Docker inspect returned an invalid published host port".to_string())?;
    if host_port == 0 {
        return Err("Docker inspect returned an invalid published host port".into());
    }
    Ok(DockerPublishedPort {
        container_port: container_port.to_string(),
        host_address: optional_json_string(binding, "HostIp").unwrap_or_else(|| "*".into()),
        host_port,
    })
}

fn required_json_string(value: &Value, key: &str, label: &str) -> Result<String, String> {
    let value = value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| format!("Docker inspect returned an invalid {label}"))?;
    Ok(value.to_string())
}

fn optional_json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
        })
        .map(str::to_string)
}

fn redact_registry_reference(value: &str) -> String {
    let without_query = value
        .split_once('?')
        .map_or(value, |(reference, _)| reference);
    let Some((scheme, remainder)) = without_query.split_once("://") else {
        return without_query.to_string();
    };
    let authority_end = remainder.find('/').unwrap_or(remainder.len());
    let (authority, path) = remainder.split_at(authority_end);
    let authority = authority
        .rsplit_once('@')
        .map_or(authority.to_string(), |(_, host)| {
            format!("[redacted]@{host}")
        });
    format!("{scheme}://{authority}{path}")
}

fn valid_compose_project(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 255
        || !value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        || !value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || "_-".contains(character)
        })
    {
        return None;
    }
    Some(value.to_string())
}

fn valid_compose_service(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 255
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return None;
    }
    Some(value.to_string())
}

struct ManagedStream {
    child: Mutex<Child>,
    stop_requested: AtomicBool,
    failure: Mutex<Option<String>>,
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
        let service = validate_systemd_unit_id(service)?;
        validate_tail(lines)?;
        let command = journal_command(service, lines, follow);
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
        let command = docker_log_command(container, lines, follow);
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
            if let Some(mut stdin) = child.stdin.take()
                && let Err(error) = stdin
                    .write_all(password.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        } else {
            drop(child.stdin.take());
        }
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let stream_id = Uuid::new_v4().to_string();
        let managed = Arc::new(ManagedStream {
            child: Mutex::new(child),
            stop_requested: AtomicBool::new(false),
            failure: Mutex::new(None),
        });
        self.streams
            .lock()
            .insert(stream_id.clone(), managed.clone());

        let output_stream = managed.clone();
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
                            output_stream.stop_requested.store(true, Ordering::SeqCst);
                            let _ = output_stream.child.lock().kill();
                            break;
                        }
                    }
                    Err(error) => {
                        *output_stream.failure.lock() = Some(error.to_string());
                        let _ = output_stream.child.lock().kill();
                        break;
                    }
                }
            }
        });

        let stderr_reader = thread::spawn(move || read_stream_diagnostics(stderr));
        let wait_id = stream_id.clone();
        let wait_app = app;
        let streams = self.streams.clone();
        thread::spawn(move || {
            loop {
                let status = managed.child.lock().try_wait();
                match status {
                    Ok(Some(status)) => {
                        streams.lock().remove(&wait_id);
                        let error_bytes = stderr_reader.join().unwrap_or_else(|_| {
                            b"Remote error reader panicked while collecting diagnostics".to_vec()
                        });
                        let failure = managed.failure.lock().take();
                        let (state, reason) = classify_stream_exit(
                            managed.stop_requested.load(Ordering::SeqCst),
                            failure,
                            status.success(),
                            status.code().unwrap_or(255),
                            &error_bytes,
                        );
                        emit_stream_state(&wait_app, &wait_id, state, reason);
                        break;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                    Err(error) => {
                        streams.lock().remove(&wait_id);
                        managed.stop_requested.store(true, Ordering::SeqCst);
                        let _ = managed.child.lock().kill();
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
        stream.stop_requested.store(true, Ordering::SeqCst);
        stream
            .child
            .lock()
            .kill()
            .map_err(|error| error.to_string())
    }

    pub fn stop_all(&self) {
        for stream in self.streams.lock().values() {
            stream.stop_requested.store(true, Ordering::SeqCst);
            let _ = stream.child.lock().kill();
        }
    }
}

fn journal_command(service: &str, lines: u16, follow: bool) -> String {
    format!(
        "env LC_ALL=C journalctl -u '{service}' -n {lines} --no-pager -o short-iso-precise{}",
        if follow { " -f" } else { "" }
    )
}

fn docker_log_command(container: &str, lines: u16, follow: bool) -> String {
    format!(
        "env LC_ALL=C docker logs --tail {lines}{} '{container}' 2>&1",
        if follow { " --follow" } else { "" }
    )
}

fn read_stream_diagnostics(mut reader: impl Read) -> Vec<u8> {
    let mut diagnostics = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let remaining = STREAM_DIAGNOSTIC_LIMIT.saturating_sub(diagnostics.len());
        diagnostics.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    diagnostics
}

fn classify_stream_exit(
    stop_requested: bool,
    failure: Option<String>,
    success: bool,
    exit_code: i32,
    diagnostics: &[u8],
) -> (&'static str, Option<String>) {
    if let Some(failure) = failure {
        return ("error", Some(failure));
    }
    if stop_requested || success {
        return ("stopped", None);
    }
    ("error", Some(classify_failure(exit_code, diagnostics)))
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
    if LOG_TAIL_OPTIONS.contains(&lines) {
        Ok(())
    } else {
        Err("Unsupported log tail count".into())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };

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
            group_id: None,
            tags: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        }
    }

    #[test]
    fn parses_and_sorts_systemd_units_across_supported_types() {
        let units = parse_systemd_units(
            "Id=nginx.service\nDescription=nginx\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n\nId=cleanup.timer\nDescription=Cleanup timer\nLoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\n\nId=data.mount\nDescription=Data mount\nLoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=generated\n\nId=api.socket\nDescription=API socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nUnitFileState=enabled\n",
        );
        assert_eq!(units.len(), 4);
        assert_eq!(units[0].id, "data.mount");
        assert_eq!(units[1].id, "cleanup.timer");
        assert_eq!(units[2].unit_type, "service");
        assert_eq!(units[3].unit_type, "socket");
    }

    #[test]
    fn ignores_unsupported_or_malformed_systemd_units() {
        let units = parse_systemd_units(
            "Id=multi-user.target\nActiveState=active\n\nId=missing-suffix\nActiveState=failed\n",
        );
        assert!(units.is_empty());
    }

    #[test]
    fn systemd_unit_listing_is_bounded_and_read_only() {
        let command = systemd_unit_list_command();
        assert!(command.contains("--type=service,timer,mount,socket"));
        assert!(
            command
                .contains("--property=Id,Description,LoadState,ActiveState,SubState,UnitFileState")
        );
        for mutation in [
            " start ",
            " stop ",
            " restart ",
            " reset-failed ",
            " enable ",
            " disable ",
        ] {
            assert!(!command.contains(mutation));
        }
    }

    #[test]
    fn parses_tcp_udp_address_families_owners_and_shared_ports() {
        let sockets = parse_listening_sockets(
            "tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:((\"nginx\",pid=742,fd=6))\n\
             tcp LISTEN 0 511 [::]:443 [::]:* users:((\"nginx\",pid=742,fd=7))\n\
             udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\n\
             tcp LISTEN 0 64 127.0.0.1:8080 0.0.0.0:* users:((\"worker-a\",pid=900,fd=3),(\"worker-b\",pid=901,fd=3))\n\
             __CONTROL_ROOM_PROCESS_UNITS__\n\
             742 nginx.service nginx\n\
             900 worker-a.scope worker-a\n",
        )
        .unwrap();

        assert_eq!(sockets.len(), 4);
        assert_eq!(
            sockets.iter().filter(|socket| socket.port == 443).count(),
            2
        );
        assert_eq!(sockets[0].protocol, "udp");
        assert_eq!(sockets[0].address_family, "ipv4");
        assert_eq!(sockets[0].ownership, "unavailable");
        assert_eq!(sockets[1].systemd_unit.as_deref(), Some("nginx.service"));
        assert_eq!(sockets[2].address_family, "ipv6");
        assert_eq!(sockets[3].ownership, "ambiguous");
        assert_eq!(sockets[3].process_id, None);
        assert_eq!(sockets[3].systemd_unit, None);
    }

    #[test]
    fn socket_activated_sshd_is_owned_by_sshd_not_by_systemd() {
        // Real output from an Ubuntu 24.04 host read as root. ssh.socket means
        // pid 1 holds the listening fd alongside sshd. Before this rule the two
        // names disagreed and port 22 reported no owner at all.
        let text = concat!(
            "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* ",
            "users:((\"sshd\",pid=1276,fd=3),(\"systemd\",pid=1,fd=94))
",
            "
__CONTROL_ROOM_PROCESS_UNITS__
",
            "1276 ssh.service sshd
",
        );
        let sockets = parse_listening_sockets(text).unwrap();
        let ssh = &sockets[0];
        assert_eq!(ssh.ownership, "known");
        assert_eq!(ssh.process_id, Some(1276));
        assert_eq!(ssh.process_name.as_deref(), Some("sshd"));
        // A single owning PID is what unlocks systemd navigation, so the unit
        // has to come through with it.
        assert_eq!(ssh.systemd_unit.as_deref(), Some("ssh.service"));
    }

    #[test]
    fn a_socket_waiting_on_activation_still_reports_systemd() {
        // Nothing has been started behind this socket yet, so pid 1 is the only
        // holder and is the honest answer rather than an artifact to drop.
        let text = concat!(
            "tcp LISTEN 0 4096 0.0.0.0:2375 0.0.0.0:* ",
            "users:((\"systemd\",pid=1,fd=120))
",
            "
__CONTROL_ROOM_PROCESS_UNITS__
",
        );
        let sockets = parse_listening_sockets(text).unwrap();
        assert_eq!(sockets[0].ownership, "known");
        assert_eq!(sockets[0].process_name.as_deref(), Some("systemd"));
    }

    #[test]
    fn dropping_the_supervisor_does_not_invent_an_owner_for_real_rivals() {
        // Two genuinely different services on one socket stay ambiguous. The
        // rule removes systemd's activation claim, not disagreement.
        let text = concat!(
            "tcp LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* ",
            "users:((\"nginx\",pid=900,fd=6),(\"haproxy\",pid=901,fd=7),(\"systemd\",pid=1,fd=9))
",
            "
__CONTROL_ROOM_PROCESS_UNITS__
",
        );
        let sockets = parse_listening_sockets(text).unwrap();
        assert_eq!(sockets[0].ownership, "ambiguous");
        assert_eq!(sockets[0].process_id, None);
    }

    #[test]
    fn a_process_merely_named_systemd_is_not_the_supervisor() {
        // systemd-resolve is a service like any other. Only pid 1 itself is the
        // activation supervisor.
        let text = concat!(
            "udp UNCONN 0 0 127.0.0.53:53 0.0.0.0:* ",
            "users:((\"systemd-resolve\",pid=673,fd=14),(\"unbound\",pid=674,fd=3))
",
            "
__CONTROL_ROOM_PROCESS_UNITS__
",
        );
        let sockets = parse_listening_sockets(text).unwrap();
        assert_eq!(sockets[0].ownership, "ambiguous");
    }

    #[test]
    fn shared_name_multiprocess_listener_keeps_the_process_name_but_not_ownership() {
        // A prefork/worker server (nginx master + workers) reports one socket
        // held by several PIDs that all share a process name.
        let sockets = parse_listening_sockets(
            "tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:((\"nginx\",pid=742,fd=6),(\"nginx\",pid=743,fd=6),(\"nginx\",pid=744,fd=6))\n\
             __CONTROL_ROOM_PROCESS_UNITS__\n\
             742 nginx.service nginx\n",
        )
        .unwrap();

        assert_eq!(sockets.len(), 1);
        // Process name is an unambiguous kernel fact and must survive for
        // display and filtering.
        assert_eq!(sockets[0].process_name.as_deref(), Some("nginx"));
        // The owning PID and systemd correlation are genuinely ambiguous.
        assert_eq!(sockets[0].ownership, "ambiguous");
        assert_eq!(sockets[0].process_id, None);
        assert_eq!(sockets[0].systemd_unit, None);
    }

    #[test]
    fn ignores_unix_and_malformed_socket_rows() {
        let sockets = parse_listening_sockets(
            "u_str LISTEN 0 4096 /run/dbus/system_bus_socket * 0\n\
             tcp LISTEN 0 128 127.0.0.1:* 0.0.0.0:*\n\
             __CONTROL_ROOM_PROCESS_UNITS__\n",
        )
        .unwrap();
        assert!(sockets.is_empty());
    }

    #[test]
    fn port_listing_is_one_bounded_read_only_query_without_process_arguments() {
        let command = port_list_command();
        assert!(command.contains("ss -H -lntupO"));
        assert!(command.contains("ps -eo pid=,unit=,comm="));
        assert!(!command.contains("args="));
        for mutation in [" kill ", " rm ", " systemctl start ", " docker stop "] {
            assert!(!command.contains(mutation));
        }
    }

    #[test]
    fn parses_ufw_status_rules_defaults_and_families() {
        let status = parse_firewall_status(
            "Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\nNew profiles: skip\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    Anywhere\n443                        ALLOW IN    Anywhere\n5432/tcp                   ALLOW IN    192.168.0.0/16\n22/tcp (v6)                ALLOW IN    Anywhere (v6)\n",
        );
        assert!(status.available);
        assert_eq!(status.active, Some(true));
        assert_eq!(status.default_incoming.as_deref(), Some("deny"));
        assert_eq!(status.rules.len(), 4);
        assert_eq!(status.rules[0].port, Some(22));
        assert_eq!(status.rules[0].protocol.as_deref(), Some("tcp"));
        assert_eq!(status.rules[0].from, "Anywhere");
        // A bare port keeps no protocol; a private source is preserved verbatim.
        assert_eq!(status.rules[1].port, Some(443));
        assert_eq!(status.rules[1].protocol, None);
        assert_eq!(status.rules[2].from, "192.168.0.0/16");
        assert!(status.rules[3].ipv6);
    }

    #[test]
    fn firewall_reports_unavailable_when_ufw_is_missing() {
        let status = parse_firewall_status("__CR_FW_UNAVAILABLE__\n");
        assert!(!status.available);
        assert_eq!(status.active, None);
        assert!(status.rules.is_empty());
    }

    #[test]
    fn firewall_command_is_read_only_and_probes_ufw() {
        let command = firewall_status_command();
        assert!(command.contains("ufw status"));
        for mutation in [
            " ufw enable",
            " ufw disable",
            " ufw allow",
            " ufw deny",
            " ufw delete",
        ] {
            assert!(!command.contains(mutation));
        }
    }

    #[test]
    fn aggregates_established_connections_by_owner_and_port() {
        let text = "0 0 10.0.0.5:443 203.0.113.9:5001 users:((\"nginx\",pid=742,fd=8))\n\
             0 0 10.0.0.5:443 203.0.113.9:5002 users:((\"nginx\",pid=743,fd=9))\n\
             0 0 10.0.0.5:443 198.51.100.7:6100 users:((\"nginx\",pid=742,fd=10))\n\
             0 0 10.0.0.5:22 198.51.100.9:40001 users:((\"sshd\",pid=1200,fd=3))\n\
             __CONTROL_ROOM_PROCESS_UNITS__\n\
             742 nginx.service nginx\n\
             743 nginx.service nginx\n\
             1200 ssh.service sshd\n";
        let overview = parse_established_connections(text);
        assert_eq!(overview.total_established, 4);
        assert!(!overview.truncated);
        assert_eq!(overview.groups.len(), 2);
        // Busiest listener first.
        let https = &overview.groups[0];
        assert_eq!(https.local_port, 443);
        assert_eq!(https.systemd_unit.as_deref(), Some("nginx.service"));
        assert_eq!(https.established, 3);
        assert_eq!(https.remote_address_count, 2);
        assert_eq!(https.remotes[0].address, "203.0.113.9");
        assert_eq!(https.remotes[0].count, 2);
        // Mixed PIDs behind one service leave no single PID.
        assert_eq!(https.process_id, None);
        let ssh = &overview.groups[1];
        assert_eq!(ssh.local_port, 22);
        assert_eq!(ssh.process_id, Some(1200));
    }

    #[test]
    fn established_connections_parse_ipv6_and_tolerate_missing_ownership() {
        let text = "0 0 [2001:db8::1]:443 [2001:db8::99]:5001 \n\
             __CONTROL_ROOM_PROCESS_UNITS__\n";
        let overview = parse_established_connections(text);
        assert_eq!(overview.total_established, 1);
        assert_eq!(overview.groups.len(), 1);
        let group = &overview.groups[0];
        assert_eq!(group.local_port, 443);
        assert_eq!(group.process_name, None);
        assert_eq!(group.systemd_unit, None);
        assert_eq!(group.remotes[0].address, "2001:db8::99");
    }

    #[test]
    fn connections_command_is_one_bounded_read_only_query() {
        let command = connections_command();
        assert!(command.contains("ss -H -tnp state established"));
        assert!(command.contains("head -n 4000"));
        assert!(!command.contains("args="));
        for mutation in [" kill ", " rm ", " ss -K", " tcpkill "] {
            assert!(!command.contains(mutation));
        }
    }

    #[test]
    fn parses_docker_json_lines() {
        let container = parse_container(
            r#"{"ID":"abc","Names":"npmplus","Image":"docker.io/npmplus","State":"running","Status":"Up","Ports":"80/tcp","CreatedAt":"today","ComposeProject":"proxy","ComposeService":"gateway","ComposeContainerNumber":"2","ComposeOneoff":"False"}"#,
        )
        .unwrap();
        assert_eq!(container.name, "npmplus");
        assert_eq!(container.state, "running");
        assert_eq!(container.compose_project.as_deref(), Some("proxy"));
        assert_eq!(container.compose_service.as_deref(), Some("gateway"));
        assert_eq!(container.compose_container_number, Some(2));
        assert_eq!(container.compose_oneoff, Some(false));
    }

    #[test]
    fn parses_unhealthy_compose_container_details_without_sensitive_values() {
        let id = "a".repeat(64);
        // Raw `docker inspect` output. The parser must surface only approved
        // fields even though Env, host mount Source, and health Log are present.
        let json = r#"[{
            "Id":"__ID__","Name":"/gateway-1","Image":"sha256:abc",
            "Config":{
                "Image":"https://user:secret@registry.example/gateway:latest?token=hidden",
                "Env":["SECRET=should-not-surface"],
                "Cmd":["/bin/gateway","--serve"],
                "Labels":{
                    "com.docker.compose.project":"proxy",
                    "com.docker.compose.service":"gateway",
                    "com.docker.compose.container-number":"1",
                    "com.docker.compose.oneoff":"False"
                }
            },
            "State":{
                "Status":"running","Running":true,"Paused":false,"Restarting":false,
                "OOMKilled":false,"Dead":false,"ExitCode":0,
                "StartedAt":"2026-08-31T01:00:00Z","FinishedAt":"0001-01-01T00:00:00Z",
                "Health":{"Status":"unhealthy","FailingStreak":3,"Log":[{"Output":"boom"}]}
            },
            "HostConfig":{"RestartPolicy":{"Name":"unless-stopped","MaximumRetryCount":0}},
            "Mounts":[{"Type":"bind","Name":"","Source":"/host/secret","Destination":"/etc/gateway","RW":false,"Propagation":"rprivate"}],
            "NetworkSettings":{
                "Networks":{"proxy_default":{"IPAddress":"172.20.0.2","Gateway":"172.20.0.1","GlobalIPv6Address":"","IPv6Gateway":""}},
                "Ports":{"8443/tcp":[{"HostIp":"0.0.0.0","HostPort":"443"}]}
            }
        }]"#
        .replace("__ID__", &id);
        let details = parse_container_details(&json).unwrap();

        assert_eq!(details.id, id);
        assert_eq!(details.name, "gateway-1");
        assert_eq!(
            details.image_reference,
            "https://[redacted]@registry.example/gateway:latest"
        );
        assert_eq!(details.health_status.as_deref(), Some("unhealthy"));
        assert_eq!(details.failing_streak, Some(3));
        assert_eq!(details.finished_at, None);
        assert_eq!(details.compose_project.as_deref(), Some("proxy"));
        assert_eq!(details.compose_container_number, Some(1));
        assert_eq!(details.mounts[0].mount_type, "bind");
        assert_eq!(details.mounts[0].name, None);
        assert_eq!(
            details.networks[0].ipv4_address.as_deref(),
            Some("172.20.0.2")
        );
        assert_eq!(details.published_ports[0].host_port, 443);

        // Env, host mount source, and health-check logs are never exposed.
        let serialized = serde_json::to_string(&details).unwrap();
        assert!(!serialized.contains("should-not-surface"));
        assert!(!serialized.contains("/host/secret"));
        assert!(!serialized.contains("boom"));
        assert!(!serialized.contains("secret@"));
    }

    #[test]
    fn parses_stopped_non_compose_container_without_health_or_bindings() {
        let id = "b".repeat(64);
        // A container with no healthcheck has no `State.Health` key at all, and
        // an exposed-but-unpublished port maps to a null binding list. Both must
        // parse cleanly rather than fail.
        let json = r#"[{
            "Id":"__ID__","Name":"/job","Image":"sha256:def",
            "Config":{"Image":"job:1","Labels":{}},
            "State":{
                "Status":"exited","Running":false,"Paused":false,"Restarting":false,
                "OOMKilled":true,"Dead":false,"ExitCode":137,
                "StartedAt":"2026-08-31T01:00:00Z","FinishedAt":"2026-08-31T01:05:00Z"
            },
            "HostConfig":{"RestartPolicy":{"Name":"no","MaximumRetryCount":0}},
            "Mounts":[],
            "NetworkSettings":{"Networks":{},"Ports":{"5000/tcp":null}}
        }]"#
        .replace("__ID__", &id);
        let details = parse_container_details(&json).unwrap();

        assert!(!details.running);
        assert!(details.oom_killed);
        assert_eq!(details.exit_code, 137);
        assert_eq!(details.health_status, None);
        assert_eq!(details.failing_streak, None);
        assert_eq!(details.compose_project, None);
        assert!(details.mounts.is_empty());
        assert!(details.networks.is_empty());
        assert!(details.published_ports.is_empty());
    }

    #[test]
    fn container_inspection_uses_full_stable_id_and_avoids_templates_and_mutations() {
        let id = "c".repeat(64);
        assert!(validate_stable_container_id(&id).is_ok());
        assert!(validate_stable_container_id("short-id").is_err());
        let command = docker_container_inspect_command(&id);
        assert!(command.starts_with("docker inspect --type container -- "));
        assert!(command.ends_with(&format!("'{id}'")));
        // No Go template projection: raw JSON is fetched once and filtered in Rust.
        assert!(!command.contains("--format"));
        assert!(!command.contains("{{"));
        for mutation in [" start ", " stop ", " restart ", " rm ", " exec "] {
            assert!(!command.contains(mutation));
        }
    }

    #[test]
    fn reports_removed_containers_as_stale_selection() {
        assert!(is_missing_container(b"Error: No such object: abc"));
        assert!(!is_missing_container(b"permission denied"));
    }

    #[test]
    fn rejects_incomplete_or_malformed_compose_identity() {
        let missing_service = parse_container(
            r#"{"ID":"one","ComposeProject":"proxy","ComposeService":"","ComposeContainerNumber":"1","ComposeOneoff":"False"}"#,
        )
        .unwrap();
        let malformed_project = parse_container(
            r#"{"ID":"two","ComposeProject":"proxy/app","ComposeService":"gateway","ComposeContainerNumber":"1","ComposeOneoff":"True"}"#,
        )
        .unwrap();

        assert_eq!(missing_service.compose_project, None);
        assert_eq!(missing_service.compose_service, None);
        assert_eq!(malformed_project.compose_project, None);
        assert_eq!(malformed_project.compose_oneoff, None);
    }

    #[test]
    fn container_listing_requests_only_selected_compose_labels() {
        let command = docker_container_list_command();
        assert!(command.contains("com.docker.compose.project"));
        assert!(command.contains("com.docker.compose.service"));
        assert!(command.contains("com.docker.compose.container-number"));
        assert!(command.contains("com.docker.compose.oneoff"));
        assert!(!command.contains(".Labels"));
    }

    #[test]
    fn classifies_useful_ssh_errors() {
        assert!(classify_failure(255, b"Permission denied (publickey)").starts_with("Permission"));
        assert!(classify_failure(255, b"Connection refused").starts_with("Connection refused"));
        assert!(
            classify_failure(127, b"sh: 1: docker: not found")
                .starts_with("Feature is not installed")
        );
    }

    #[test]
    fn docker_logs_merge_container_stderr_into_the_stream() {
        assert_eq!(
            docker_log_command("container-1", 200, true),
            "env LC_ALL=C docker logs --tail 200 --follow 'container-1' 2>&1"
        );
        assert_eq!(
            journal_command("ssh.service", 50, false),
            "env LC_ALL=C journalctl -u 'ssh.service' -n 50 --no-pager -o short-iso-precise"
        );
    }

    #[test]
    fn stream_diagnostics_are_capped_but_fully_drained() {
        struct CountingReader {
            inner: Cursor<Vec<u8>>,
            read: Arc<AtomicUsize>,
        }

        impl Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = self.inner.read(buffer)?;
                self.read.fetch_add(count, Ordering::SeqCst);
                Ok(count)
            }
        }

        let total = STREAM_DIAGNOSTIC_LIMIT * 3;
        let read = Arc::new(AtomicUsize::new(0));
        let diagnostics = read_stream_diagnostics(CountingReader {
            inner: Cursor::new(vec![b'x'; total]),
            read: read.clone(),
        });
        assert_eq!(diagnostics.len(), STREAM_DIAGNOSTIC_LIMIT);
        assert_eq!(read.load(Ordering::SeqCst), total);
    }

    #[test]
    fn requested_stream_stop_is_not_reported_as_a_failure() {
        assert_eq!(
            classify_stream_exit(true, None, false, 1, b"killed"),
            ("stopped", None)
        );
        assert_eq!(
            classify_stream_exit(false, Some("pipe failed".into()), false, 1, b""),
            ("error", Some("pipe failed".into()))
        );
    }

    #[test]
    #[cfg(windows)]
    fn terminated_remote_children_are_reaped() {
        let mut child = background_command("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .spawn()
            .unwrap();
        terminate_child(&mut child);
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn limits_parallel_structured_operations_per_connection() {
        let limiter = Arc::new(RemoteOperationLimiter::default());
        let start = Arc::new(Barrier::new(7));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();

        for _ in 0..6 {
            let limiter = limiter.clone();
            let start = start.clone();
            let active = active.clone();
            let maximum = maximum.clone();
            workers.push(thread::spawn(move || {
                start.wait();
                let _permit = limiter.acquire("connection-a").unwrap();
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(current, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(25));
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }

        start.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 2);
        assert_eq!(limiter.tracked_connections(), 0);
    }

    #[test]
    fn queued_structured_operations_have_a_deadline() {
        let limiter = RemoteOperationLimiter::default();
        let first = limiter
            .acquire_for("connection-a", Duration::from_millis(10))
            .unwrap();
        let second = limiter
            .acquire_for("connection-a", Duration::from_millis(10))
            .unwrap();

        let error = limiter
            .acquire_for("connection-a", Duration::from_millis(10))
            .err()
            .expect("the third operation should time out");

        assert_eq!(error, "Remote operation queue was busy for 4 seconds");
        drop(first);
        drop(second);
        assert_eq!(limiter.tracked_connections(), 0);
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
