//! Read-only macOS SSH collectors. Commands use tools shipped with macOS.
use crate::{
    models::*,
    remote::{Elevation, RemoteCommandExecutor},
};
use chrono::Utc;
use parking_lot::Mutex;
use std::{
    collections::{BTreeMap, HashMap},
    sync::OnceLock,
    time::{Duration, Instant},
};

type HostCache = Mutex<HashMap<String, (Instant, bool)>>;
fn cache() -> &'static HostCache {
    static CACHE: OnceLock<HostCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}
fn key(c: &SavedConnection) -> String {
    serde_json::to_string(&(&c.id, &c.destination, &c.username, c.port, &c.identity_file))
        .expect("connection fields serialize")
}
pub(crate) fn remember(c: &SavedConnection, mac: bool) {
    let mut cch = cache().lock();
    cch.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
    if cch.len() >= 64 {
        cch.clear();
    }
    cch.insert(key(c), (Instant::now(), mac));
}
pub(crate) fn is_host(c: &SavedConnection) -> Result<bool, String> {
    if let Some((at, mac)) = cache().lock().get(&key(c))
        && at.elapsed() < Duration::from_secs(60)
    {
        return Ok(*mac);
    }
    let text = RemoteCommandExecutor::execute(c, "detect_macos", "uname -s")?.success_text()?;
    let mac = text.trim() == "Darwin";
    remember(c, mac);
    Ok(mac)
}
pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub(crate) fn command(script: &str) -> String {
    format!(
        "/bin/sh -c {}",
        quote(&format!(
            "export LC_ALL=C; PATH=\"$PATH:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin\"; export PATH; {script}"
        ))
    )
}
fn read(
    c: &SavedConnection,
    operation: &'static str,
    script: &str,
    elevation: &Elevation,
) -> Result<String, String> {
    RemoteCommandExecutor::execute_elevated(c, operation, &command(script), elevation)?
        .success_text()
}
pub(crate) const CAPABILITIES: &str = r#"
printf 'hostname=%s\nos_id=macos\nos_name=%s\nos_version=%s\nkernel=%s\narchitecture=%s\n' "$(hostname)" "$(sw_vers -productName)" "$(sw_vers -productVersion)" "$(uname -r)" "$(uname -m)"
printf 'uptime=%s\n' "$(uptime)"
printf 'default_shell=%s\n' "$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed 's/^UserShell: //')"
printf 'systemd_available=false\njournald_available=false\n'
command -v launchctl >/dev/null && printf 'launchd_available=true\n'
test -x /usr/bin/log && printf 'unified_log_available=true\n'
sudo -n true 2>/dev/null && printf 'passwordless_sudo=true\n' || printf 'passwordless_sudo=false\n'
if command -v docker >/dev/null; then
 printf 'docker_available=true\n'; printf 'docker_version=%s\n' "$(docker --version 2>/dev/null)"
 context=$(docker context show 2>/dev/null); endpoint=$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}' 2>/dev/null); if test -z "${DOCKER_CONTEXT:-}" && test -n "${DOCKER_HOST:-}"; then endpoint=$DOCKER_HOST; fi
 printf 'docker_context=%s\ndocker_endpoint=%s\n' "$context" "$endpoint"
 case "$endpoint" in unix://*) printf 'docker_remote=false\n';; *) printf 'docker_remote=true\n';; esac
 if docker info >/dev/null 2>&1; then printf 'docker_accessible=true\nrunning_container_count=%s\ntotal_container_count=%s\n' "$(docker ps -q | wc -l)" "$(docker ps -aq | wc -l)"; else printf 'docker_accessible=false\n'; fi
else printf 'docker_available=false\ndocker_accessible=false\n'; fi
printf 'running_service_count=%s\n' "$(launchctl print system 2>/dev/null | awk '/services = \{/ {inside=1;next} inside && /^[[:space:]]*}/ {exit} inside && $1+0>0 {n++} END {print n+0}')"
"#;
pub(crate) fn capabilities_command() -> String {
    command(CAPABILITIES)
}
pub(crate) fn shells(
    c: &SavedConnection,
) -> Result<crate::windows_ssh::RemoteShellCatalog, String> {
    let text = read(
        c,
        "macos_shells",
        r#"for shell in zsh bash fish; do case "$shell" in zsh) test -x /bin/zsh && echo macos:zsh;; bash) test -x /bin/bash && echo macos:bash;; fish) if test -x /opt/homebrew/bin/fish || test -x /usr/local/bin/fish; then echo macos:fish; fi;; esac; done"#,
        &Elevation::None,
    )?;
    let shells = text
        .lines()
        .filter(|v| ["macos:zsh", "macos:bash", "macos:fish"].contains(v))
        .map(|id| crate::windows_ssh::RemoteShellProfile {
            id: id.into(),
            label: if id == "macos:bash" {
                "Bash"
            } else {
                id.trim_start_matches("macos:")
            }
            .into(),
        })
        .collect();
    Ok(crate::windows_ssh::RemoteShellCatalog {
        platform: "macos".into(),
        shells,
        windows_terminal_available: false,
        wsl_error: None,
        profile_error: None,
        // An unavailable Docker context must not prevent an SSH terminal.
        // Overview can retry optional host discovery independently.
        capabilities: crate::remote::discover_capabilities(c).ok(),
    })
}
pub(crate) fn shell_command(id: &str, history: bool) -> Result<String, String> {
    let shell = match id {
        "macos:zsh" => "/bin/zsh -l",
        "macos:bash" if history => "/bin/bash -i",
        "macos:bash" => "/bin/bash --login -i",
        "macos:fish" => {
            "$(if test -x /opt/homebrew/bin/fish; then printf /opt/homebrew/bin/fish; else printf /usr/local/bin/fish; fi) --login"
        }
        _ => return Err("Unknown macOS shell".into()),
    };
    let integration = if history {
        "export CONTROL_ROOM_SHELL_INTEGRATION=1; "
    } else {
        ""
    };
    Ok(command(&format!(
        "printf '\\033]633;ControlRoom;connected\\007'; export TERM=xterm-256color; {integration}exec {shell}"
    )))
}
pub(crate) fn metrics(
    c: &SavedConnection,
    wanted: &[HeaderMetric],
) -> Result<HeaderMetrics, String> {
    let text = read(
        c,
        "macos_metrics",
        &crate::header_metrics::macos::script(wanted),
        &Elevation::None,
    )?;
    Ok(crate::header_metrics::macos::parse(&text, wanted))
}
pub(crate) fn resources(c: &SavedConnection) -> Result<HostResources, String> {
    let wanted = [HeaderMetric::Cpu, HeaderMetric::Ram];
    let script = format!(
        "{} printf 'cores='; sysctl -n hw.ncpu; printf 'load='; sysctl -n vm.loadavg; sysctl vm.swapusage",
        crate::header_metrics::macos::script(&wanted)
    );
    let text = read(c, "macos_resources", &script, &Elevation::None)?;
    let sample = crate::header_metrics::macos::parse(&text, &wanted);
    let values: HashMap<_, _> = text.lines().filter_map(|l| l.split_once('=')).collect();
    let load: Vec<f64> = values
        .get("load")
        .unwrap_or(&"")
        .split_whitespace()
        .filter_map(|v| v.parse().ok())
        .collect();
    let swap = |name: &str| -> Option<u64> {
        let line = text.lines().find(|l| l.starts_with("vm.swapusage:"))?;
        let value = line
            .split(&format!("{name} = "))
            .nth(1)?
            .split_whitespace()
            .next()?;
        let (number, unit) = value.split_at(value.len().checked_sub(1)?);
        let n = number.parse::<f64>().ok()?;
        let scale = match unit {
            "K" => 1.0,
            "M" => 1024.0,
            "G" => 1024.0 * 1024.0,
            _ => return None,
        };
        (n.is_finite() && n >= 0.0 && n * scale < u64::MAX as f64).then_some((n * scale) as u64)
    };
    Ok(HostResources {
        sampled_at: sample.sampled_at,
        cpu_percent: sample.cpu_percent,
        core_count: values.get("cores").and_then(|v| v.trim().parse().ok()),
        load1: load.first().copied(),
        load5: load.get(1).copied(),
        load15: load.get(2).copied(),
        memory_total_kib: sample.memory_total_kib,
        memory_available_kib: sample.memory_available_kib,
        swap_total_kib: swap("total"),
        swap_free_kib: swap("free"),
    })
}

const SERVICES: &str = r#"uid=${SUDO_UID:-$(id -u)}; for domain in system "user/$uid" "gui/$uid"; do printf '__CR_DOMAIN__%s\n' "$domain"; launchctl print "$domain" 2>/dev/null || true; done"#;
pub(crate) fn services(c: &SavedConnection) -> Result<Vec<SystemdUnit>, String> {
    parse_services(&read(c, "macos_services", SERVICES, &Elevation::None)?)
}

fn service_owners(text: &str) -> HashMap<u32, Option<String>> {
    let mut owners = HashMap::new();
    for service in parse_services(text).unwrap_or_default() {
        if let Some(pid) = service
            .sub_state
            .strip_prefix("running (PID ")
            .and_then(|s| s.strip_suffix(')'))
            .and_then(|s| s.parse::<u32>().ok())
        {
            owners
                .entry(pid)
                .and_modify(|id| *id = None)
                .or_insert(Some(service.id));
        }
    }
    owners
}
fn parse_services(text: &str) -> Result<Vec<SystemdUnit>, String> {
    let mut domain = "";
    let mut inside = false;
    let mut seen = false;
    let mut units = BTreeMap::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("__CR_DOMAIN__") {
            domain = value.trim();
            inside = false;
            continue;
        }
        if line.trim() == "services = {" {
            inside = true;
            seen = true;
            continue;
        }
        if inside && line.trim() == "}" {
            inside = false;
        }
        if !inside {
            continue;
        }
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 3 || domain.is_empty() || units.len() >= 4000 {
            continue;
        }
        let Some(pid) = fields[0].parse::<u32>().ok() else {
            continue;
        };
        let label = fields[2];
        if !valid_label(label) {
            continue;
        }
        let failed = fields[1].parse::<i32>().is_ok_and(|status| status != 0);
        let id = format!("{domain}/{label}");
        units.insert(
            id.clone(),
            SystemdUnit {
                id,
                unit_type: if domain == "system" {
                    "daemon"
                } else {
                    "agent"
                }
                .into(),
                description: label.into(),
                load_state: "loaded".into(),
                active_state: if pid > 0 {
                    "active"
                } else if failed {
                    "failed"
                } else {
                    "inactive"
                }
                .into(),
                sub_state: if pid > 0 {
                    format!("running (PID {pid})")
                } else if failed {
                    format!("last exit {}", fields[1])
                } else {
                    "waiting".into()
                },
                unit_file_state: None,
            },
        );
    }
    if !seen {
        return Err("launchd service domains could not be read by this account".into());
    }
    Ok(units.into_values().collect())
}
fn valid_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"._-:@".contains(&v))
}

const SOCKETS: &str = r#"netstat -an -p tcp || exit $?; netstat -an -p udp || exit $?; printf '\n__CR_OWNERS__\n'; /usr/sbin/lsof -nP -i -F0pcfPntT 2>/dev/null || true"#;
#[derive(Clone, Debug)]
struct Socket {
    protocol: String,
    family: String,
    address: String,
    port: u16,
    peer: Option<String>,
    pid: Option<u32>,
    name: Option<String>,
    ownership: String,
}
fn endpoint(value: &str) -> Option<(String, u16)> {
    let (address, port) = value.rsplit_once('.')?;
    let port = port.parse().ok()?;
    let address = if address == "*" {
        "*"
    } else {
        address.trim_matches(['[', ']'])
    };
    if address.is_empty() {
        return None;
    }
    Some((address.into(), port))
}
fn parse_sockets(text: &str, established: bool) -> Vec<Socket> {
    let (net, owners) = text.split_once("__CR_OWNERS__").unwrap_or((text, ""));
    type OwnerKey = (String, String, String, u16, Option<(String, u16)>);
    let mut evidence: HashMap<OwnerKey, Vec<(u32, String)>> = HashMap::new();
    let (mut pid, mut name, mut protocol, mut family) =
        (None, String::new(), String::new(), String::new());
    for field in owners.split(['\0', '\n']).filter(|s| !s.is_empty()) {
        let Some(tag) = field.get(..1) else {
            continue;
        };
        let value = &field[1..];
        match tag {
            "p" => {
                pid = value.parse::<u32>().ok();
                name.clear();
                protocol.clear();
            }
            "c" => name = value.chars().take(256).collect(),
            "f" => {
                protocol.clear();
                family.clear();
            }
            "t" => family = value.to_ascii_lowercase(),
            "P" => protocol = value.to_ascii_lowercase(),
            "n" => {
                let (local, peer) = value
                    .split_once("->")
                    .map(|(a, b)| (a, Some(b)))
                    .unwrap_or((value, None));
                if let Some((address, port)) = local.rsplit_once(':')
                    && let Ok(port) = port.parse::<u16>()
                    && let Some(pid) = pid
                {
                    let item = evidence
                        .entry((
                            protocol.clone(),
                            family.clone(),
                            address.trim_matches(['[', ']']).into(),
                            port,
                            peer.and_then(|p| {
                                let (a, b) = p.rsplit_once(':')?;
                                Some((a.trim_matches(['[', ']']).into(), b.parse().ok()?))
                            }),
                        ))
                        .or_default();
                    if !item.iter().any(|(p, _)| *p == pid) {
                        item.push((pid, name.clone()));
                    }
                }
            }
            _ => (),
        }
    }
    let mut sockets = BTreeMap::new();
    for line in net.lines() {
        let f: Vec<_> = line.split_whitespace().collect();
        if f.len() < 5 || sockets.len() >= 4000 {
            continue;
        }
        let tcp = f[0].starts_with("tcp");
        let udp = f[0].starts_with("udp");
        if (!tcp && !udp)
            || (established && (!tcp || f.get(5) != Some(&"ESTABLISHED")))
            || (!established && tcp && f.get(5) != Some(&"LISTEN"))
        {
            continue;
        }
        let Some((address, port)) = endpoint(f[3]) else {
            continue;
        };
        if port == 0 {
            continue;
        }
        let protocol = if tcp { "tcp" } else { "udp" };
        let family = if f[0].contains('6') { "ipv6" } else { "ipv4" };
        let peer = if established {
            endpoint(f[4]).map(|(host, _)| host)
        } else {
            None
        };
        let candidates = evidence.get(&(
            protocol.into(),
            family.into(),
            address.clone(),
            port,
            if established { endpoint(f[4]) } else { None },
        ));
        let one = candidates.filter(|v| v.len() == 1).and_then(|v| v.first());
        let ownership = if one.is_some() {
            "known"
        } else if candidates.is_some_and(|v| v.len() > 1) {
            "ambiguous"
        } else {
            "unavailable"
        };
        let socket = Socket {
            protocol: protocol.into(),
            family: family.into(),
            address: address.clone(),
            port,
            peer: peer.clone(),
            pid: one.map(|v| v.0),
            name: one.map(|v| v.1.clone()),
            ownership: ownership.into(),
        };
        sockets.insert(
            (
                protocol.to_string(),
                family.to_string(),
                address,
                port,
                if established { endpoint(f[4]) } else { None },
            ),
            socket,
        );
    }
    sockets.into_values().collect()
}
pub(crate) fn ports(
    c: &SavedConnection,
    elevation: &Elevation,
) -> Result<Vec<ListeningSocket>, String> {
    let text = read(
        c,
        "macos_ports",
        &format!("{SOCKETS}; {SERVICES}"),
        elevation,
    )?;
    let owners = service_owners(&text);
    Ok(parse_sockets(&text, false)
        .into_iter()
        .map(|s| {
            let local_address = if s.address == "*" {
                if s.family == "ipv6" { "::" } else { "0.0.0.0" }.into()
            } else {
                s.address
            };
            ListeningSocket {
                id: format!("{}:{}:{}:{}", s.protocol, s.family, local_address, s.port),
                protocol: s.protocol,
                address_family: s.family,
                local_address,
                port: s.port,
                process_name: s.name,
                process_id: s.pid,
                systemd_unit: s.pid.and_then(|pid| owners.get(&pid).cloned().flatten()),
                ownership: s.ownership,
            }
        })
        .collect())
}
pub(crate) fn connections(
    c: &SavedConnection,
    elevation: &Elevation,
) -> Result<EstablishedConnections, String> {
    let text = read(
        c,
        "macos_connections",
        &format!("{SOCKETS}; {SERVICES}"),
        elevation,
    )?;
    let sockets = parse_sockets(&text, true);
    let owners = service_owners(&text);
    let mut groups: BTreeMap<String, ConnectionSummary> = BTreeMap::new();
    let mut total = 0;
    for s in sockets {
        total += 1;
        let key = format!(
            "{}:{}:{}",
            s.protocol,
            s.port,
            s.pid.map_or("unknown".into(), |v| v.to_string())
        );
        let group = groups
            .entry(key.clone())
            .or_insert_with(|| ConnectionSummary {
                key,
                protocol: s.protocol,
                local_port: s.port,
                process_name: s.name,
                process_id: s.pid,
                systemd_unit: s.pid.and_then(|pid| owners.get(&pid).cloned().flatten()),
                established: 0,
                remote_address_count: 0,
                remotes: vec![],
            });
        group.established += 1;
        if let Some(peer) = s.peer {
            if let Some(remote) = group.remotes.iter_mut().find(|r| r.address == peer) {
                remote.count += 1;
            } else {
                group.remotes.push(ConnectionRemote {
                    address: peer,
                    count: 1,
                });
            }
        }
    }
    for group in groups.values_mut() {
        group.remote_address_count = group.remotes.len() as u32;
        group
            .remotes
            .sort_by(|a, b| b.count.cmp(&a.count).then(a.address.cmp(&b.address)));
        group.remotes.truncate(20);
    }
    let truncated = groups.len() > 200 || total >= 4000;
    Ok(EstablishedConnections {
        groups: groups.into_values().take(200).collect(),
        total_established: total,
        truncated,
        collected_at: Utc::now().to_rfc3339(),
    })
}
pub(crate) fn firewall(
    c: &SavedConnection,
    elevation: &Elevation,
) -> Result<FirewallStatus, String> {
    let text = read(
        c,
        "macos_firewall",
        r#"/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate && /usr/libexec/ApplicationFirewall/socketfilterfw --getblockall && /usr/libexec/ApplicationFirewall/socketfilterfw --listapps"#,
        elevation,
    )?;
    let mut status = parse_firewall(&text);
    let pf = read(
        c,
        "macos_packet_filter",
        "/sbin/pfctl -s info && printf '\\n__CR_PF_RULES__\\n' && /sbin/pfctl -a '*' -sr",
        elevation,
    );
    status.packet_filter = Some(match pf {
        Ok(text) => {
            let (info, rules) = text.split_once("__CR_PF_RULES__").unwrap_or((&text, ""));
            PacketFilterStatus {
                active: if info.contains("Status: Enabled") {
                    Some(true)
                } else if info.contains("Status: Disabled") {
                    Some(false)
                } else {
                    None
                },
                rules: rules
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .take(200)
                    .map(|l| l.chars().take(2000).collect())
                    .collect(),
                error: None,
                permission_required: false,
            }
        }
        Err(error) => PacketFilterStatus {
            active: None,
            rules: vec![],
            permission_required: error.to_lowercase().contains("permission"),
            error: Some(error),
        },
    });
    Ok(status)
}
fn parse_firewall(text: &str) -> FirewallStatus {
    let active = if text.contains("State = 1") || text.contains("State = 2") {
        Some(true)
    } else if text.contains("State = 0") {
        Some(false)
    } else {
        None
    };
    let block = if text.contains("block all state set to enabled") {
        Some("Block all incoming applications".into())
    } else if text.contains("block all state set to disabled") {
        Some("Application rules".into())
    } else {
        None
    };
    let mut rules = vec![];
    let mut application = None;
    for line in text.lines() {
        if let Some((number, path)) = line.split_once(" : ")
            && number.trim().parse::<u32>().is_ok()
        {
            application = Some(path.trim().to_string());
        } else if let Some(path) = application.take() {
            let action = if line.contains("Allow incoming") {
                "ALLOW"
            } else if line.contains("Block incoming") {
                "BLOCK"
            } else {
                continue;
            };
            if rules.len() < 200 {
                rules.push(FirewallRule {
                    to: path,
                    action: action.into(),
                    from: "Any".into(),
                    port: None,
                    protocol: None,
                    ipv6: false,
                });
            }
        }
    }
    FirewallStatus {
        backend: Some("macos".into()),
        available: true,
        active,
        default_incoming: block,
        rules,
        packet_filter: None,
        collected_at: Utc::now().to_rfc3339(),
    }
}
pub(crate) fn identity(c: &SavedConnection) -> Result<HostIdentity, String> {
    let text = read(
        c,
        "macos_identity",
        r#"printf 'hostname=%s\nos_version=%s\nkernel=%s\narchitecture=%s\n' "$(hostname)" "$(sw_vers -productVersion)" "$(uname -r)" "$(uname -m)"; identity=$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ {printf "%s",$4}'); if test -n "$identity"; then printf '%s' "$identity" | /usr/bin/shasum -a 256 | cut -c1-16; fi"#,
        &Elevation::None,
    )?;
    let values: HashMap<_, _> = text.lines().filter_map(|l| l.split_once('=')).collect();
    let get = |k| {
        values
            .get(k)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
    };
    let fingerprint = text
        .lines()
        .last()
        .filter(|v| v.len() == 16 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_owned);
    Ok(HostIdentity {
        hostname: get("hostname"),
        machine_fingerprint: fingerprint,
        os_id: Some("macos".into()),
        os_version: get("os_version"),
        kernel: get("kernel"),
        architecture: get("architecture"),
    })
}
pub(crate) fn filesystems(c: &SavedConnection) -> Result<Vec<Filesystem>, String> {
    let text = read(
        c,
        "macos_filesystems",
        "df -kP || exit $?; printf '\\n__CR_MOUNTS__\\n'; mount",
        &Elevation::None,
    )?;
    parse_filesystems(&text)
}
fn parse_filesystems(text: &str) -> Result<Vec<Filesystem>, String> {
    let (df, mount) = text
        .split_once("__CR_MOUNTS__")
        .ok_or("macOS filesystem response is incomplete")?;
    let types: HashMap<_, _> = mount
        .lines()
        .filter_map(|l| {
            let (_, r) = l.split_once(" on ")?;
            let (path, kind) = r.rsplit_once(" (")?;
            Some((path, kind.split([',', ')']).next()?))
        })
        .collect();
    let mut results = vec![];
    for line in df.lines().skip(1) {
        let f: Vec<_> = line.split_whitespace().collect();
        if f.len() < 6 || results.len() >= 200 {
            continue;
        }
        let mut path = line;
        for _ in 0..5 {
            path = path
                .trim_start()
                .trim_start_matches(|c: char| !c.is_whitespace());
        }
        let path = path.trim_start().to_string();
        let kind = types.get(path.as_str()).copied().unwrap_or("unknown");
        if kind == "devfs" || kind == "autofs" {
            continue;
        }
        if let (Ok(size), Ok(used)) = (
            f[1].parse::<u64>(),
            f[4].trim_end_matches('%').parse::<u8>(),
        ) && used <= 100
        {
            results.push(Filesystem {
                mount_point: path,
                filesystem_type: kind.into(),
                size_kib: size,
                used_percent: used,
            });
        }
    }
    Ok(results)
}
pub(crate) fn log_command(service: &str, lines: u16, follow: bool) -> Result<String, String> {
    if !LOG_TAIL_OPTIONS.contains(&lines) {
        return Err("Unsupported log tail length".into());
    }
    let label = service.rsplit('/').next().unwrap_or(service);
    let target_ok = service.rsplit_once('/').is_some_and(|(domain, _)| {
        domain == "system"
            || domain
                .strip_prefix("gui/")
                .or_else(|| domain.strip_prefix("user/"))
                .is_some_and(|uid| !uid.is_empty() && uid.bytes().all(|c| c.is_ascii_digit()))
    });
    if service.len() > 512 || (service != "all" && (!valid_label(label) || !target_ok)) {
        return Err("Invalid launchd service identifier".into());
    }
    let (setup, predicate) = if service == "all" {
        (String::new(), String::new())
    } else {
        let follow_arg = if follow { "-F" } else { "" };
        let setup = format!(
            r#"job=$(launchctl print {}) || exit $?;
stdout=$(printf '%s\n' "$job" | sed -n 's/^[[:space:]]*stdout path = //p'); stderr=$(printf '%s\n' "$job" | sed -n 's/^[[:space:]]*stderr path = //p');
set --; for file in "$stdout" "$stderr"; do
 test -n "$file" || continue;
 if test -f "$file"; then test -r "$file" || {{ printf 'Permission denied reading service output\n' >&2; exit 1; }}; set -- "$@" "$file"; fi;
done;
if test "$#" -gt 0; then exec /usr/bin/tail -n {lines} {follow_arg} -- "$@"; fi;
pid=$(printf '%s\n' "$job" | awk '/^[[:space:]]*pid = [0-9]+$/ {{print $3;exit}}');
predicate={};
case "$pid" in ''|*[!0-9]*) ;; *) predicate="($predicate) OR processIdentifier == $pid";; esac;
"#,
            quote(service),
            quote(&format!(
                "subsystem == \"com.apple.launchd\" AND eventMessage CONTAINS[c] \"{label}\""
            ))
        );
        (setup, " --predicate \"$predicate\"".into())
    };
    let initial = format!(
        "/bin/bash -o pipefail -c {}",
        quote(&format!(
            "/usr/bin/log show --last 1h --style syslog --info{predicate} | /usr/bin/tail -n {lines}"
        ))
    );
    // Export the backend-built predicate to the pipefail subshell as data.
    Ok(command(&if follow {
        format!(
            "{setup} export predicate; {initial} || exit $?; exec /usr/bin/log stream --style syslog --level info{predicate}"
        )
    } else {
        format!("{setup} export predicate; {initial}")
    }))
}

pub(crate) fn boot(
    c: &SavedConnection,
    selected: Option<&str>,
    elevation: &Elevation,
) -> Result<BootDiagnostics, String> {
    let text = read(
        c,
        "macos_boots",
        r#"printf 'epoch='; sysctl -n kern.boottime | awk '{gsub(/,/,"",$4);print $4}'; printf 'uuid='; sysctl -n kern.bootsessionuuid; TZ=UTC last -wy -n 20 reboot"#,
        &Elevation::None,
    )?;
    let (records, epochs) = parse_boots(&text)?;
    let selected = selected
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| records[0].id.clone());
    let index = records
        .iter()
        .position(|r| r.id == selected)
        .ok_or("That boot is not present in this Mac's reboot records")?;
    let start = epochs[index];
    let end = if index > 0 {
        format!(" --end @{}", epochs[index - 1])
    } else {
        String::new()
    };
    let log_script = format!(
        "/bin/bash -o pipefail -c {}",
        quote(&format!(
            "/usr/bin/log show --start @{start}{end} --style syslog --predicate 'messageType == error OR messageType == fault' | tail -n 30"
        ))
    );
    let journal = read(c, "macos_boot_logs", &log_script, elevation);
    let failures = if index > 0 {
        Err("Historical launchd exit states are not retained by macOS.".into())
    } else {
        services(c).map(|s| {
            s.into_iter()
                .filter(|s| s.active_state == "failed")
                .collect::<Vec<_>>()
        })
    };
    let collected_at = Utc::now().to_rfc3339();
    let unavailable = |message: &str| BootSection {
        collected_at: collected_at.clone(),
        data: None,
        error: Some(message.into()),
        permission_required: false,
    };
    let journal = match journal {
        Ok(logs) => BootSection {
            collected_at: collected_at.clone(),
            data: Some(
                logs.lines()
                    .filter(|line| {
                        !line.trim().is_empty()
                            && !line.starts_with("Timestamp")
                            && !line.starts_with("Filtering the log data")
                    })
                    .map(str::to_owned)
                    .collect(),
            ),
            error: None,
            permission_required: false,
        },
        Err(e) => BootSection {
            collected_at: collected_at.clone(),
            data: None,
            permission_required: e.to_lowercase().contains("permission"),
            error: Some(e),
        },
    };
    let failed_units = match failures {
        Ok(s) => BootSection {
            collected_at: collected_at.clone(),
            data: Some(s),
            error: None,
            permission_required: false,
        },
        Err(e) => BootSection {
            collected_at: collected_at.clone(),
            data: None,
            error: Some(e),
            permission_required: false,
        },
    };
    Ok(BootDiagnostics {
        id: uuid::Uuid::new_v4().to_string(),
        collected_at: collected_at.clone(),
        selected_boot_id: Some(selected),
        boots: BootSection {
            collected_at: collected_at.clone(),
            data: Some(records),
            error: None,
            permission_required: false,
        },
        timing: unavailable("macOS does not expose systemd kernel/userspace boot timing."),
        slow_units: BootSection {
            collected_at: collected_at.clone(),
            data: None,
            error: Some("macOS does not expose per-service boot durations.".into()),
            permission_required: false,
        },
        failed_units,
        journal,
    })
}
fn parse_boots(text: &str) -> Result<(Vec<BootRecord>, Vec<i64>), String> {
    let fields: HashMap<_, _> = text.lines().filter_map(|l| l.split_once('=')).collect();
    let epoch = fields
        .get("epoch")
        .and_then(|s| s.trim().parse::<i64>().ok())
        .ok_or("macOS boot time was unavailable")?;
    let uuid = fields
        .get("uuid")
        .map(|s| s.trim().replace('-', "").to_ascii_lowercase())
        .filter(|s| s.len() == 32 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("macOS boot identifier was unavailable")?;
    let date = chrono::DateTime::from_timestamp(epoch, 0).ok_or("Invalid macOS boot time")?;
    let mut records = vec![BootRecord {
        index: 0,
        id: uuid,
        range: date.to_rfc3339(),
        current: true,
    }];
    let mut epochs = vec![epoch];
    for row in text.lines().filter_map(|l| l.strip_prefix("reboot time")) {
        let parts = row.split_whitespace().take(5).collect::<Vec<_>>().join(" ");
        if let Ok(date) = chrono::NaiveDateTime::parse_from_str(&parts, "%a %b %e %Y %H:%M") {
            let stamp = date.and_utc().timestamp();
            if stamp < epoch - 60 && !epochs.contains(&stamp) {
                records.push(BootRecord {
                    index: -(records.len() as i32),
                    id: format!("{stamp:032x}"),
                    range: format!("{} UTC (reboot record)", date.format("%Y-%m-%d %H:%M")),
                    current: false,
                });
                epochs.push(stamp);
            }
        }
    }
    Ok((records, epochs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires CONTROL_ROOM_TEST_MAC_HOST and pinned, noninteractive SSH access"]
    fn live_macos_native_collectors_and_docker_context() {
        let c: SavedConnection = serde_json::from_value(serde_json::json!({
            "id":"live-macos", "displayName":"Mac fixture",
            "destination":std::env::var("CONTROL_ROOM_TEST_MAC_HOST").expect("Mac fixture required"),
            "username":null,"port":null,"identityFile":null,"historyEnabled":false,"sudoEnabled":false,
            "groupId":null,"tags":[],"createdAt":"","updatedAt":"","lastConnectedAt":null
        })).unwrap();
        let caps = crate::remote::discover_capabilities(&c).unwrap();
        assert_eq!(caps.os_id.as_deref(), Some("macos"));
        assert!(caps.launchd_available && caps.unified_log_available);
        assert!(!caps.systemd_available && !caps.journald_available);
        let catalog = shells(&c).unwrap();
        assert_eq!(catalog.platform, "macos");
        assert!(catalog.shells.iter().any(|s| s.id == "macos:zsh"));
        let m = metrics(
            &c,
            &[
                HeaderMetric::Cpu,
                HeaderMetric::Ram,
                HeaderMetric::Disk,
                HeaderMetric::Uptime,
            ],
        )
        .unwrap();
        assert!(
            m.cpu_percent.is_some()
                && m.memory_total_kib.is_some()
                && m.disk_total_kib.is_some()
                && m.uptime_seconds.is_some()
        );
        let r = resources(&c).unwrap();
        assert!(r.core_count.is_some() && r.load1.is_some() && r.swap_total_kib.is_some());
        let jobs = services(&c).unwrap();
        assert!(jobs.len() > 10);
        assert!(jobs.iter().any(|s| s.id == "system/com.openssh.sshd"));
        let sockets = ports(&c, &Elevation::None).unwrap();
        assert!(sockets.iter().any(|s| s.port == 22 && s.protocol == "tcp"));
        assert!(connections(&c, &Elevation::None).unwrap().total_established > 0);
        let fw = firewall(&c, &Elevation::None).unwrap();
        assert_eq!(fw.backend.as_deref(), Some("macos"));
        assert!(fw.active.is_some());
        assert!(fw.packet_filter.is_some());
        let id = identity(&c).unwrap();
        assert_eq!(id.os_id.as_deref(), Some("macos"));
        assert!(id.machine_fingerprint.is_some());
        assert!(
            filesystems(&c)
                .unwrap()
                .iter()
                .any(|f| f.mount_point == "/" && f.filesystem_type == "apfs")
        );
        let b = boot(&c, None, &Elevation::None).unwrap();
        assert!(b.boots.data.as_ref().unwrap()[0].current);
        assert!(b.failed_units.error.is_none());
        assert!(b.journal.error.is_none(), "{:?}", b.journal.error);
        if let Some(previous) = b.boots.data.unwrap().iter().find(|b| !b.current) {
            let old = boot(&c, Some(&previous.id), &Elevation::None).unwrap();
            assert!(old.failed_units.data.is_none());
            assert!(old.failed_units.error.is_some());
        }
        assert!(boot(&c, Some("injected; date"), &Elevation::None).is_err());
        read(
            &c,
            "test_macos_logs",
            &log_command("system/com.openssh.sshd", 200, false).unwrap(),
            &Elevation::None,
        )
        .unwrap();
        if caps.docker_accessible {
            let containers = crate::remote::list_containers(&c, Elevation::Allowed).unwrap();
            assert_eq!(containers.len() as u32, caps.total_container_count.unwrap());
            if let Some(container) = containers.first() {
                crate::remote::inspect_container(&c, &container.id, Elevation::Allowed).unwrap();
            }
        }
    }
    #[test]
    fn reads_launchd_domains_and_preserves_waiting_and_failed_states() {
        let s=parse_services("__CR_DOMAIN__system\nservices = {\n 42 - com.example.running\n 0 9 com.example.failed\n}\n__CR_DOMAIN__gui/501\n services = {\n 0 0 com.example.waiting\n}\n").unwrap();
        assert_eq!(s.len(), 3);
        assert!(
            s.iter()
                .any(|s| s.id == "system/com.example.running" && s.active_state == "active")
        );
        assert!(s.iter().any(|s| s.active_state == "failed"));
        assert!(s.iter().any(|s| s.sub_state == "waiting"));
        assert!(parse_services("permission denied").is_err());
    }
    #[test]
    fn reads_ipv4_ipv6_listeners_and_ownership_without_inventing_missing_processes() {
        let s = parse_sockets(
            "tcp4 0 0 *.22 *.* LISTEN\ntcp6 0 0 ::1.8080 *.* LISTEN\nudp4 0 0 *.5353 *.*\n__CR_OWNERS__\np42\0csshd\0f1\0tIPv4\0PTCP\0n*:22\0",
            false,
        );
        assert_eq!(s.len(), 3);
        assert!(s.iter().any(|s| s.port == 22 && s.pid == Some(42)));
        assert!(
            s.iter()
                .any(|s| s.family == "ipv6" && s.address == "::1" && s.ownership == "unavailable")
        );
    }
    #[test]
    fn only_established_tcp_rows_become_connections() {
        let s = parse_sockets(
            "tcp4 0 0 127.0.0.1.22 127.0.0.2.60000 ESTABLISHED\ntcp4 0 0 127.0.0.1.22 127.0.0.2.60001 ESTABLISHED\ntcp4 0 0 *.22 *.* LISTEN\nudp4 0 0 *.5353 *.*",
            true,
        );
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].peer.as_deref(), Some("127.0.0.2"));
    }

    #[test]
    fn correlates_only_one_launchd_target_per_pid() {
        let owners = service_owners(
            "__CR_DOMAIN__system\nservices = {\n 42 - com.example.one\n 43 - com.example.two\n}\n__CR_DOMAIN__gui/501\nservices = {\n 43 - com.example.three\n}\n",
        );
        assert_eq!(owners[&42].as_deref(), Some("system/com.example.one"));
        assert_eq!(owners[&43], None);
    }

    #[test]
    #[ignore = "requires CONTROL_ROOM_TEST_MAC_HOST with a signed-in graphical user"]
    fn live_macos_launchd_service_output_files() {
        let c: SavedConnection = serde_json::from_value(serde_json::json!({
            "id":"live-macos-job", "displayName":"Mac fixture",
            "destination":std::env::var("CONTROL_ROOM_TEST_MAC_HOST").expect("Mac fixture required"),
            "username":null,"port":null,"identityFile":null,"historyEnabled":false,"sudoEnabled":false,
            "groupId":null,"tags":[],"createdAt":"","updatedAt":"","lastConnectedAt":null
        })).unwrap();
        let label = format!("com.control-room.test.{}", uuid::Uuid::new_v4().simple());
        let path = format!("/tmp/{label}");
        // Only this fixture's UUID-named job and directory are ever removed.
        struct Cleanup<'a>(&'a SavedConnection, String, String);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = read(
                    self.0,
                    "macos_test_cleanup",
                    &format!(
                        "launchctl bootout gui/$(id -u)/{} 2>/dev/null || true; rm -rf {}",
                        quote(&self.1),
                        quote(&self.2)
                    ),
                    &Elevation::None,
                );
            }
        }
        let _cleanup = Cleanup(&c, label.clone(), path.clone());
        let setup = format!(
            r#"mkdir -m 700 {path}; cat > {path}/job.plist <<'CR_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>printf 'CONTROL_ROOM_LAUNCHD_LOG_OK\n'; sleep 30</string></array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>{path}/output with spaces.log</string><key>StandardErrorPath</key><string>{path}/error.log</string></dict></plist>
CR_PLIST
launchctl bootstrap gui/$(id -u) {path}/job.plist || exit $?; printf 'gui/%s/{label}' "$(id -u)"
"#
        );
        let target = read(&c, "macos_test_bootstrap", &setup, &Elevation::None).unwrap();
        let command = log_command(target.trim(), 200, false).unwrap();
        let output = read(&c, "macos_test_service_logs", &command, &Elevation::None).unwrap();
        assert!(output.contains("CONTROL_ROOM_LAUNCHD_LOG_OK"));
    }
    #[test]
    fn application_firewall_rules_do_not_claim_port_reachability() {
        let f = parse_firewall(
            "Firewall is disabled. (State = 0)\nFirewall has block all state set to disabled.\n1 : /Applications/Test App.app\n (Allow incoming connections)\n",
        );
        assert_eq!(f.active, Some(false));
        assert_eq!(f.rules[0].port, None);
        assert_eq!(f.rules[0].to, "/Applications/Test App.app");
    }
    #[test]
    fn macos_df_preserves_mount_paths_and_filters_pseudo_filesystems() {
        let f=parse_filesystems("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 100 25 75 25% /Volumes/My  Disk\ndevfs 1 1 0 100% /dev\n__CR_MOUNTS__\n/dev/disk1 on /Volumes/My  Disk (apfs, local)\ndevfs on /dev (devfs, local)\n").unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].mount_point, "/Volumes/My  Disk");
        assert_eq!(f[0].filesystem_type, "apfs");
    }
    #[test]
    fn rejects_predicate_and_shell_injection_in_log_sources() {
        for s in [
            "bad' OR TRUE",
            "bad;touch /tmp/x",
            "bad\nname",
            "bad\"label",
        ] {
            assert!(log_command(s, 200, true).is_err());
        }
        assert!(
            log_command("system/com.apple.sshd", 200, true)
                .unwrap()
                .contains("log stream")
        );
        assert!(
            log_command("all", 200, false)
                .unwrap()
                .contains("--last 1h")
        );
        assert!(log_command("all", 0, false).is_err());
        assert_eq!(quote("a'b"), "'a'\\''b'");
    }
    #[test]
    fn macos_boots_keep_actual_current_uuid_and_timestamp_previous_records() {
        let (b,e)=parse_boots("epoch=1792986910\nuuid=2263C9E5-27E0-4236-B8F1-9A22C19AA9C7\nreboot time Mon Oct 26 2026 03:55\nreboot time Sun Oct 25 2026 03:32\n").unwrap();
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].id, "2263c9e527e04236b8f19a22c19aa9c7");
        assert!(e[1] < e[0]);
        assert!(!b[1].current);
        assert!(parse_boots("epoch=nan\nuuid=invalid").is_err());
    }
}
