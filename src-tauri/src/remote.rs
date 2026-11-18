use std::{
    collections::HashMap,
    io::Read,
    process::{Child, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use chrono::Utc;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, ipc::Channel, ipc::Response};
use uuid::Uuid;

use crate::{
    models::{
        ConnectionRemote, ConnectionSummary, DockerContainer, DockerContainerDetails, DockerMount,
        DockerNetworkAttachment, DockerPublishedPort, EstablishedConnections, FirewallRule,
        FirewallStatus, HostCapabilities, HostResources, LOG_TAIL_OPTIONS, ListeningSocket,
        SavedConnection, StreamNotice, StreamNoticeEvent, StreamStarted, StreamState,
        StreamStateEvent, SystemdUnit,
    },
    ssh::{
        background_command, connection_arguments, detect_ssh_path, ssh_not_found_message,
        validate_container_id, validate_systemd_unit_id,
    },
};

mod operation;

#[cfg(test)]
pub(crate) use operation::{COMMAND_TIMEOUT, MAX_STRUCTURED_QUEUE_WAIT};
use operation::{CommandOutput, classify_failure, spawn_input_writer};
pub use operation::{Elevation, RemoteCommandExecutor, RemoteOperationLimiter, elevated_command};

#[cfg(test)]
#[path = "remote_distro_matrix_tests.rs"]
mod distro_matrix_tests;

const STREAM_DIAGNOSTIC_LIMIT: usize = 64 * 1024;
const JOURNAL_RESTRICTED_HINT: &[u8] = b"not seeing messages from other users and the system";
const MAX_FIREWALL_RULES: usize = 200;
const MAX_CONNECTION_ROWS: usize = 4000;
const MAX_CONNECTION_GROUPS: usize = 200;
const MAX_CONNECTION_REMOTES: usize = 20;

fn capability_command() -> &'static str {
    r#"LC_ALL=C; printf 'hostname=%s\n' "$(hostname 2>/dev/null)"; if test -r /etc/os-release; then . /etc/os-release; printf 'os_id=%s\n' "$ID"; printf 'os_like=%s\n' "$ID_LIKE"; printf 'os_name=%s\n' "$NAME"; printf 'os_version=%s\n' "$VERSION_ID"; fi; printf 'kernel=%s\n' "$(uname -r 2>/dev/null)"; printf 'architecture=%s\n' "$(uname -m 2>/dev/null)"; uptime_value=$(uptime -p 2>/dev/null || true); if test -z "$uptime_value" && test -r /proc/uptime; then uptime_value=$(awk '{seconds=int($1); days=int(seconds/86400); hours=int((seconds%86400)/3600); minutes=int((seconds%3600)/60); if(days>0) printf "up %d days, ",days; else printf "up "; if(hours>0) printf "%d hours, ",hours; printf "%d minutes",minutes}' /proc/uptime); fi; printf 'uptime=%s\n' "$uptime_value"; account_name=$(id -un 2>/dev/null); default_shell=$(getent passwd "$account_name" 2>/dev/null | cut -d: -f7); if test -z "$default_shell" && test -r /etc/passwd; then default_shell=$(awk -F: -v account="$account_name" '$1==account {print $7; exit}' /etc/passwd); fi; printf 'default_shell=%s\n' "$default_shell"; if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then printf 'passwordless_sudo=true\n'; else printf 'passwordless_sudo=false\n'; fi; command -v systemctl >/dev/null 2>&1 && printf 'systemd_available=true\n' || printf 'systemd_available=false\n'; command -v journalctl >/dev/null 2>&1 && printf 'journald_available=true\n' || printf 'journald_available=false\n'; if command -v docker >/dev/null 2>&1; then printf 'docker_available=true\n'; printf 'docker_version=%s\n' "$(docker version --format '{{.Server.Version}}' 2>/dev/null || docker --version 2>/dev/null)"; if docker info >/dev/null 2>&1; then printf 'docker_accessible=true\n'; printf 'running_container_count=%s\n' "$(docker ps -q | wc -l)"; printf 'total_container_count=%s\n' "$(docker ps -aq | wc -l)"; else printf 'docker_accessible=false\n'; if sudo -n docker info >/dev/null 2>&1; then printf 'docker_accessible_with_sudo=true\n'; printf 'running_container_count=%s\n' "$(sudo -n docker ps -q | wc -l)"; printf 'total_container_count=%s\n' "$(sudo -n docker ps -aq | wc -l)"; fi; fi; else printf 'docker_available=false\n'; printf 'docker_accessible=false\n'; fi; if command -v systemctl >/dev/null 2>&1; then printf 'running_service_count=%s\n' "$(systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | wc -l)"; fi"#
}

fn distribution_family(os_id: Option<&str>, os_like: Option<&str>) -> Option<String> {
    let candidates = os_id
        .into_iter()
        .chain(os_like.into_iter().flat_map(str::split_whitespace));
    for candidate in candidates {
        let family = match candidate.trim().to_ascii_lowercase().as_str() {
            "debian" | "ubuntu" => "debian",
            "rhel" | "rocky" | "almalinux" | "ol" | "centos" | "fedora" => "rhel",
            "amzn" => "amazon",
            "suse" | "opensuse" | "opensuse-leap" | "sles" | "sled" => "suse",
            "arch" | "manjaro" => "arch",
            "alpine" => "alpine",
            "macos" => "macos",
            _ => continue,
        };
        return Some(family.into());
    }
    None
}

/// One round trip that reads `/proc` and nothing else. CPU busy share only
/// exists as a delta, so the two `/proc/stat` reads are taken on the host with
/// a short gap between them rather than by holding a previous sample here and
/// hoping the next request arrives on schedule. Everything is a plain read: no
/// process list, no command lines, no per-process accounting.
pub(crate) fn resource_command() -> &'static str {
    // /proc/stat guest counters are already included in user and nice; awk's integer printf range is platform-dependent.
    r#"LC_ALL=C; if test -r /proc/stat; then awk '/^cpu /{t=0; for(n=2;n<=9 && n<=NF;n++) t+=$n; printf "cpu_total_1=%.0f\ncpu_idle_1=%.0f\n", t, $5+$6}' /proc/stat; sleep 0.25; awk '/^cpu /{t=0; for(n=2;n<=9 && n<=NF;n++) t+=$n; printf "cpu_total_2=%.0f\ncpu_idle_2=%.0f\n", t, $5+$6}' /proc/stat; fi; printf 'cores=%s\n' "$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null)"; if test -r /proc/loadavg; then printf 'load=%s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"; fi; if test -r /proc/meminfo; then awk '/^MemTotal:|^MemAvailable:|^SwapTotal:|^SwapFree:/{key=tolower(substr($1,1,length($1)-1)); printf "%s=%s\n", key, $2}' /proc/meminfo; fi"#
}

fn cpu_percent_from(values: &HashMap<String, String>) -> Option<f64> {
    let read = |key: &str| values.get(key)?.parse::<u64>().ok();
    let total_1 = read("cpu_total_1")?;
    let idle_1 = read("cpu_idle_1")?;
    let total_2 = read("cpu_total_2")?;
    let idle_2 = read("cpu_idle_2")?;
    let total_delta = total_2.checked_sub(total_1)?;
    if total_delta == 0 {
        return None;
    }
    let idle_delta = idle_2.saturating_sub(idle_1).min(total_delta);
    let busy = (total_delta - idle_delta) as f64 / total_delta as f64 * 100.0;
    Some((busy * 10.0).round() / 10.0)
}

fn parse_kib(values: &HashMap<String, String>, key: &str) -> Option<u64> {
    values.get(key)?.parse().ok()
}

pub fn collect_host_resources(connection: &SavedConnection) -> Result<HostResources, String> {
    if crate::macos_remote::is_host(connection)? {
        return crate::macos_remote::resources(connection);
    }
    let text = RemoteCommandExecutor::execute(connection, "host_resources", resource_command())?
        .success_text()?;
    Ok(parse_host_resources(&text))
}

pub(crate) fn parse_host_resources(text: &str) -> HostResources {
    let values = parse_key_values(text);
    let loads: Vec<f64> = values
        .get("load")
        .map(|value| {
            value
                .split_whitespace()
                .filter_map(|part| part.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    HostResources {
        sampled_at: Utc::now().to_rfc3339(),
        cpu_percent: cpu_percent_from(&values),
        core_count: parse_count(&values, "cores"),
        load1: loads.first().copied(),
        load5: loads.get(1).copied(),
        load15: loads.get(2).copied(),
        memory_total_kib: parse_kib(&values, "memtotal"),
        memory_available_kib: parse_kib(&values, "memavailable"),
        swap_total_kib: parse_kib(&values, "swaptotal"),
        swap_free_kib: parse_kib(&values, "swapfree"),
    }
}

pub fn discover_capabilities(connection: &SavedConnection) -> Result<HostCapabilities, String> {
    let command = capability_command();
    let command = format!(
        "if test \"$(uname -s 2>/dev/null)\" = Darwin; then {}; else {}; fi",
        crate::macos_remote::capabilities_command(),
        command
    );
    let linux = RemoteCommandExecutor::execute(connection, "discover_capabilities", &command)
        .and_then(CommandOutput::success_text);
    let text = match linux {
        Ok(text)
            if parse_key_values(&text).contains_key("os_id")
                && !parse_key_values(&text)
                    .get("kernel")
                    .is_some_and(|kernel| kernel.to_ascii_lowercase().contains("microsoft")) =>
        {
            text
        }
        result => match crate::windows_ssh::discover_windows(connection) {
            Ok(host) => return Ok(host.capabilities),
            Err(_) => result?,
        },
    };
    let values = parse_key_values(&text);
    crate::macos_remote::remember(
        connection,
        values.get("os_id").is_some_and(|v| v == "macos"),
    );
    Ok(HostCapabilities {
        connection_id: connection.id.clone(),
        hostname: values.get("hostname").cloned(),
        os_id: values.get("os_id").cloned(),
        os_name: values.get("os_name").cloned(),
        os_version: values.get("os_version").cloned(),
        os_family: distribution_family(
            values.get("os_id").map(String::as_str),
            values.get("os_like").map(String::as_str),
        ),
        kernel: values.get("kernel").cloned(),
        architecture: values.get("architecture").cloned(),
        uptime: values.get("uptime").cloned(),
        default_shell: values.get("default_shell").cloned(),
        systemd_available: is_true(&values, "systemd_available"),
        journald_available: is_true(&values, "journald_available"),
        launchd_available: is_true(&values, "launchd_available"),
        unified_log_available: is_true(&values, "unified_log_available"),
        docker_available: is_true(&values, "docker_available"),
        docker_accessible: is_true(&values, "docker_accessible"),
        docker_accessible_with_sudo: is_true(&values, "docker_accessible_with_sudo"),
        passwordless_sudo: is_true(&values, "passwordless_sudo"),
        docker_version: values
            .get("docker_version")
            .filter(|value| !value.is_empty())
            .cloned(),
        docker_context: values
            .get("docker_context")
            .filter(|s| !s.is_empty())
            .cloned(),
        docker_endpoint: values
            .get("docker_endpoint")
            .filter(|s| !s.is_empty())
            .cloned(),
        docker_remote: is_true(&values, "docker_remote"),
        running_service_count: parse_count(&values, "running_service_count"),
        running_container_count: parse_count(&values, "running_container_count"),
        total_container_count: parse_count(&values, "total_container_count"),
        detected_at: Utc::now().to_rfc3339(),
    })
}

pub fn list_services(connection: &SavedConnection) -> Result<Vec<SystemdUnit>, String> {
    if crate::macos_remote::is_host(connection)? {
        return crate::macos_remote::services(connection);
    }
    let command = systemd_unit_list_command();
    let text =
        RemoteCommandExecutor::execute(connection, "list_services", command)?.success_text()?;
    Ok(parse_systemd_units(&text))
}

pub fn list_containers(
    connection: &SavedConnection,
    elevation: Elevation,
) -> Result<Vec<DockerContainer>, String> {
    let command = docker_container_list_command();
    let macos_command;
    let mac = crate::macos_remote::is_host(connection)?;
    let command = if mac {
        macos_command = crate::macos_remote::command(command);
        &macos_command
    } else {
        command
    };
    let elevation = if mac { Elevation::None } else { elevation };
    let output = RemoteCommandExecutor::execute_elevated(
        connection,
        "list_containers",
        command,
        &elevation,
    )?;
    let text = output.success_text()?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_container)
        .collect()
}

pub fn list_ports(
    connection: &SavedConnection,
    elevation: Elevation,
) -> Result<Vec<ListeningSocket>, String> {
    if crate::macos_remote::is_host(connection)? {
        return crate::macos_remote::ports(connection, &elevation);
    }
    let command = port_list_command();
    let output =
        RemoteCommandExecutor::execute_elevated(connection, "list_ports", command, &elevation)?;
    parse_listening_sockets(&output.success_text()?)
}

pub fn inspect_container(
    connection: &SavedConnection,
    container_id: &str,
    elevation: Elevation,
) -> Result<DockerContainerDetails, String> {
    let container_id = validate_stable_container_id(container_id)?;
    let command = docker_container_inspect_command(container_id);
    let mac = crate::macos_remote::is_host(connection)?;
    let command = if mac {
        crate::macos_remote::command(&command)
    } else {
        command
    };
    let elevation = if mac { Elevation::None } else { elevation };
    let output = RemoteCommandExecutor::execute_elevated(
        connection,
        "inspect_container",
        &command,
        &elevation,
    )?;
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

pub(crate) fn parse_container(line: &str) -> Result<DockerContainer, String> {
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

fn is_navigable_systemd_unit(unit: &str) -> bool {
    [".service", ".timer", ".mount", ".socket"]
        .iter()
        .any(|suffix| unit.ends_with(suffix))
}

fn parse_process_units(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let unit = validate_systemd_unit_id(fields.next()?).ok()?;
            is_navigable_systemd_unit(unit).then(|| (pid, unit.to_string()))
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
const FIREWALL_BACKEND_MARKER: &str = "__CR_FW_BACKEND__";
const FIREWALL_STATE_MARKER: &str = "__CR_FW_STATE__";
const FIREWALL_ZONE_MARKER: &str = "__CR_FW_ZONE__";

pub fn list_firewall(
    connection: &SavedConnection,
    elevation: Elevation,
) -> Result<FirewallStatus, String> {
    if crate::macos_remote::is_host(connection)? {
        return crate::macos_remote::firewall(connection, &elevation);
    }
    let command = firewall_status_command();
    let output =
        RemoteCommandExecutor::execute_elevated(connection, "list_firewall", command, &elevation)?;
    Ok(parse_firewall_status(&output.success_text()?))
}

fn firewall_status_command() -> &'static str {
    // UFW requires root on common distributions; policy can deny firewalld's unprivileged D-Bus reads.
    r#"env LC_ALL=C sh -c '
if command -v ufw >/dev/null 2>&1; then
  printf "__CR_FW_BACKEND__\tufw\n"
  ufw status verbose
  exit $?
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  printf "__CR_FW_BACKEND__\tfirewalld\n"
  if firewall-cmd --state >/dev/null 2>&1; then
    printf "__CR_FW_STATE__\tactive\n"
    zones=$(firewall-cmd --get-active-zones) || exit $?
    printf "%s\n" "$zones" | while IFS= read -r line; do
      case "$line" in
        [![:space:]]*)
          zone=${line%% *}
          test -n "$zone" || continue
          ports=$(firewall-cmd --zone="$zone" --list-ports) || exit $?
          printf "__CR_FW_ZONE__\t%s\t%s\n" "$zone" "$ports"
          ;;
      esac
    done || exit $?
  else
    status=$?
    if test "$status" -eq 252; then
      printf "__CR_FW_STATE__\tinactive\n"
    else
      firewall-cmd --state
      exit "$status"
    fi
  fi
  exit 0
fi
printf "__CR_FW_UNAVAILABLE__\n"
'"#
}

fn parse_firewall_status(text: &str) -> FirewallStatus {
    let collected_at = Utc::now().to_rfc3339();
    if text.contains(FIREWALL_UNAVAILABLE_MARKER) {
        return FirewallStatus {
            backend: None,
            available: false,
            active: None,
            default_incoming: None,
            rules: Vec::new(),
            packet_filter: None,
            collected_at,
        };
    }

    let backend = text.lines().find_map(|line| {
        line.strip_prefix(FIREWALL_BACKEND_MARKER)
            .map(str::trim)
            .filter(|value| matches!(*value, "ufw" | "firewalld"))
            .map(str::to_string)
    });

    if backend.as_deref() == Some("firewalld") {
        return parse_firewalld_status(text, collected_at);
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
        backend: Some("ufw".into()),
        available: true,
        active,
        default_incoming,
        rules,
        packet_filter: None,
        collected_at,
    }
}

fn parse_firewalld_status(text: &str, collected_at: String) -> FirewallStatus {
    let active = text.lines().find_map(|line| {
        line.strip_prefix(FIREWALL_STATE_MARKER)
            .map(str::trim)
            .and_then(|state| match state {
                "active" => Some(true),
                "inactive" => Some(false),
                _ => None,
            })
    });
    let mut rules = Vec::new();
    for line in text.lines() {
        let Some(details) = line.strip_prefix(FIREWALL_ZONE_MARKER) else {
            continue;
        };
        let mut fields = details.trim_start_matches('\t').splitn(2, '\t');
        let zone = fields.next().unwrap_or("").trim();
        let ports = fields.next().unwrap_or("");
        if zone.is_empty() {
            continue;
        }
        for value in ports.split_whitespace() {
            if rules.len() >= MAX_FIREWALL_RULES {
                break;
            }
            let (port, protocol) = parse_firewall_target(value);
            let (Some(port), Some(protocol)) = (port, protocol) else {
                continue;
            };
            for ipv6 in [false, true] {
                if rules.len() >= MAX_FIREWALL_RULES {
                    break;
                }
                rules.push(FirewallRule {
                    to: bounded_text(value, 120),
                    action: "ALLOW".into(),
                    from: bounded_text(&format!("zone {zone}"), 120),
                    port: Some(port),
                    protocol: Some(protocol.clone()),
                    ipv6,
                });
            }
        }
    }
    FirewallStatus {
        backend: Some("firewalld".into()),
        available: true,
        active,
        default_incoming: None,
        rules,
        packet_filter: None,
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

pub fn list_connections(
    connection: &SavedConnection,
    elevation: Elevation,
) -> Result<EstablishedConnections, String> {
    if crate::macos_remote::is_host(connection)? {
        return crate::macos_remote::connections(connection, &elevation);
    }
    let text = RemoteCommandExecutor::execute_elevated(
        connection,
        "list_connections",
        connections_command(),
        &elevation,
    )?
    .success_text()?;
    Ok(parse_established_connections(&text))
}

fn connections_command() -> &'static str {
    // Without privilege, ss shows process ownership only for the caller's own processes.
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

pub(crate) fn validate_stable_container_id(value: &str) -> Result<&str, String> {
    let value = validate_container_id(value)?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Container inspection requires a full Docker ID".into());
    }
    Ok(value)
}

fn docker_container_inspect_command(container_id: &str) -> String {
    // docker inspect --format fails on absent optional fields such as .State.Health (missingkey=error).
    format!("docker inspect --type container -- '{container_id}'")
}

pub(crate) fn parse_container_details(text: &str) -> Result<DockerContainerDetails, String> {
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
    pub elevation: Elevation,
    pub output: Channel<Response>,
}

#[derive(Clone, Default)]
pub struct StreamManager {
    streams: Arc<Mutex<HashMap<String, Arc<ManagedStream>>>>,
}

impl StreamManager {
    #[cfg(feature = "desktop-e2e")]
    pub fn e2e_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self.streams.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

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
            elevation,
            output,
        } = options;
        validate_tail(lines)?;
        if crate::macos_remote::is_host(connection)? {
            let command = crate::macos_remote::log_command(service, lines, follow)?;
            return self.start(app, connection, command, elevation, output);
        }
        let service = validate_systemd_unit_id(service)?;
        let command = journal_command(service, lines, follow);
        self.start(app, connection, command, elevation, output)
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
            elevation,
            output,
        } = options;
        let container = validate_container_id(container)?;
        validate_tail(lines)?;
        let command = docker_log_command(container, lines, follow);
        let mac = crate::macos_remote::is_host(connection)?;
        let command = if mac {
            crate::macos_remote::command(&command)
        } else {
            command
        };
        let elevation = if mac { Elevation::None } else { elevation };
        self.start(app, connection, command, elevation, output)
    }

    pub fn start_windows_docker_logs(
        &self,
        app: AppHandle,
        connection: &SavedConnection,
        container: &str,
        options: LogStreamOptions,
    ) -> Result<StreamStarted, String> {
        validate_tail(options.lines)?;
        let command = crate::windows_inspection::docker_log_command(
            container,
            options.lines,
            options.follow,
        )?;
        self.start(app, connection, command, Elevation::None, options.output)
    }

    fn start(
        &self,
        app: AppHandle,
        connection: &SavedConnection,
        command: String,
        elevation: Elevation,
        output: Channel<Response>,
    ) -> Result<StreamStarted, String> {
        let ssh_path = detect_ssh_path().ok_or_else(ssh_not_found_message)?;
        let mut arguments = connection_arguments(connection, false);
        arguments.push(elevated_command(&command, &elevation));
        let mut child = background_command(ssh_path)
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Log stream could not start: {error}"))?;
        let input_writer = if let Elevation::Password(password) = &elevation {
            Some(spawn_input_writer(
                child.stdin.take().expect("stdin was piped"),
                password.as_bytes(),
            ))
        } else {
            drop(child.stdin.take());
            None
        };
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
        let output_reader = thread::spawn(move || {
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

        let notice_app = app.clone();
        let notice_id = stream_id.clone();
        let stderr_reader = thread::spawn(move || {
            read_stream_diagnostics(stderr, |notice| {
                emit_stream_notice(&notice_app, &notice_id, notice)
            })
        });
        let wait_id = stream_id.clone();
        let wait_app = app;
        let streams = self.streams.clone();
        thread::spawn(move || {
            loop {
                let status = managed.child.lock().try_wait();
                match status {
                    Ok(Some(status)) => {
                        if let Some(writer) = input_writer {
                            let result = writer.join();
                            if status.success() && !matches!(result, Ok(Ok(()))) {
                                *managed.failure.lock() =
                                    Some("Could not send log stream input".into());
                            }
                        }
                        if output_reader.join().is_err() {
                            *managed.failure.lock() = Some("Log output reader panicked".into());
                        }
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
                        let _ = managed.child.lock().wait();
                        if let Some(writer) = input_writer {
                            let _ = writer.join();
                        }
                        let _ = output_reader.join();
                        let _ = stderr_reader.join();
                        emit_stream_state(
                            &wait_app,
                            &wait_id,
                            StreamState::Error,
                            Some(error.to_string()),
                        );
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

/// The shell started inside a container: bash when the image has it, otherwise
/// sh. It carries no quotes, so the Linux command and the Windows PowerShell
/// launcher can both pass it as one argument unchanged.
pub(crate) const CONTAINER_SHELL_SCRIPT: &str =
    "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";

/// An interactive shell inside one container, run on a Linux host over the
/// terminal's own ssh pty. The connected marker means ssh reached the host;
/// what `docker exec` then reports, such as a stopped container or a missing
/// shell, stays visible in the terminal. With sudo allowed, a host where this
/// account cannot reach the daemon retries through sudo, which can prompt in
/// the terminal. Only a full container ID is accepted, so the ID carries no
/// shell syntax.
pub(crate) fn docker_exec_command(
    container_id: &str,
    sudo_allowed: bool,
) -> Result<String, String> {
    let container_id = validate_stable_container_id(container_id)?;
    let exec = format!(
        "docker exec -it -e TERM=xterm-256color '{container_id}' sh -c '{CONTAINER_SHELL_SCRIPT}'"
    );
    let marker = "printf '\\033]633;ControlRoom;connected\\007'";
    Ok(if sudo_allowed {
        format!(
            "{marker}; if docker version >/dev/null 2>&1; then exec {exec}; else exec sudo {exec}; fi"
        )
    } else {
        format!("{marker}; exec {exec}")
    })
}

fn docker_log_command(container: &str, lines: u16, follow: bool) -> String {
    format!(
        "env LC_ALL=C docker logs --tail {lines}{} '{container}' 2>&1",
        if follow { " --follow" } else { "" }
    )
}

fn read_stream_diagnostics(
    mut reader: impl Read,
    mut on_notice: impl FnMut(StreamNotice),
) -> Vec<u8> {
    let mut diagnostics = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut restricted = false;
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let remaining = STREAM_DIAGNOSTIC_LIMIT.saturating_sub(diagnostics.len());
        diagnostics.extend_from_slice(&buffer[..count.min(remaining)]);
        if !restricted
            && diagnostics
                .windows(JOURNAL_RESTRICTED_HINT.len())
                .any(|window| window == JOURNAL_RESTRICTED_HINT)
        {
            restricted = true;
            on_notice(StreamNotice::JournalRestricted);
        }
    }
    diagnostics
}

fn classify_stream_exit(
    stop_requested: bool,
    failure: Option<String>,
    success: bool,
    exit_code: i32,
    diagnostics: &[u8],
) -> (StreamState, Option<String>) {
    if let Some(failure) = failure {
        return (StreamState::Error, Some(failure));
    }
    if stop_requested || success {
        return (StreamState::Stopped, None);
    }
    (
        StreamState::Error,
        Some(classify_failure(exit_code, diagnostics)),
    )
}

fn emit_stream_notice(app: &AppHandle, stream_id: &str, notice: StreamNotice) {
    let _ = app.emit(
        "stream-notice",
        StreamNoticeEvent {
            stream_id: stream_id.into(),
            notice,
        },
    );
}

fn emit_stream_state(app: &AppHandle, stream_id: &str, state: StreamState, reason: Option<String>) {
    let _ = app.emit(
        "stream-state-changed",
        StreamStateEvent {
            stream_id: stream_id.into(),
            state,
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
mod tests;
