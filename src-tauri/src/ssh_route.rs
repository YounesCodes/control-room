use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    time::Duration,
};

use chrono::Utc;
use serde::Serialize;
use wait_timeout::ChildExt;

use crate::{
    models::SavedConnection,
    ssh::{background_command, detect_ssh_path},
};

/// A route longer than this is reported as truncated rather than followed. It
/// also caps how many times the local `ssh` binary is run for one request.
pub const MAX_SEGMENTS: usize = 8;
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

pub const SEGMENT_ORIGIN: &str = "origin";
pub const SEGMENT_JUMP: &str = "jump";
pub const SEGMENT_DESTINATION: &str = "destination";

pub const SEGMENT_RESOLVED: &str = "resolved";
pub const SEGMENT_UNRESOLVED: &str = "unresolved";
pub const SEGMENT_OPAQUE_PROXY: &str = "opaqueProxy";
pub const SEGMENT_LOOP: &str = "loop";
pub const SEGMENT_LIMIT: &str = "limit";

pub const ROUTE_RESOLVED: &str = "resolved";
pub const ROUTE_PARTIAL: &str = "partial";

const OPAQUE_PROXY_NOTE: &str = "Custom proxy command, route not safely interpretable";
const LOOP_NOTE: &str =
    "This host was already on the route. Control Room stopped rather than follow the loop.";
const LIMIT_NOTE: &str = "The route reached the segment limit and was not followed further.";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouteSegment {
    pub kind: String,
    pub status: String,
    /// The name as written, either in the Saved Connection or in a ProxyJump
    /// entry. Kept separate from the hostname OpenSSH resolved it to.
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
    /// The program name of a ProxyCommand, when it is a bare name. Arguments
    /// are never included.
    pub proxy_program: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshRoute {
    pub connection_id: String,
    pub resolved_at: String,
    pub status: String,
    pub segments: Vec<RouteSegment>,
    pub truncated: bool,
    pub note: Option<String>,
}

/// One hop as written in a ProxyJump value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpTarget {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffectiveConfiguration {
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
    pub proxy_jump: Vec<JumpTarget>,
    pub proxy_command: Option<String>,
}

/// `ssh -G` prints the configuration a connection would use and makes no
/// network connection of its own.
pub fn effective_configuration_arguments(
    target: &JumpTarget,
    identity_file: Option<&str>,
) -> Vec<String> {
    let mut arguments: Vec<String> = vec!["-G".into()];
    if let Some(user) = &target.user {
        arguments.extend(["-l".into(), user.clone()]);
    }
    if let Some(port) = target.port {
        arguments.extend(["-p".into(), port.to_string()]);
    }
    if let Some(identity_file) = identity_file {
        arguments.extend(["-i".into(), identity_file.to_string()]);
    }
    arguments.push(target.host.clone());
    arguments
}

/// A host token becomes a process argument, never a shell word, so the checks
/// that matter are that it cannot be read as an option and that it looks like a
/// host name or address rather than whatever else the config happened to hold.
pub fn usable_host_token(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 255 || value.starts_with('-') {
        return None;
    }
    let shaped = value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || ".-_:".contains(character));
    if !shaped {
        return None;
    }
    Some(value)
}

/// `[user@]host[:port]`, with an IPv6 literal in brackets.
pub fn parse_jump_target(value: &str) -> Option<JumpTarget> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("none") {
        return None;
    }
    let (user, remainder) = match value.rsplit_once('@') {
        Some((user, remainder)) if !user.is_empty() => (Some(user.to_string()), remainder),
        _ => (None, value),
    };
    let (host, port) = if let Some(rest) = remainder.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = after
            .strip_prefix(':')
            .map(|digits| digits.parse::<u16>().ok())
            .unwrap_or(None);
        if after.starts_with(':') && port.is_none() {
            return None;
        }
        (host.to_string(), port)
    } else {
        match remainder.rsplit_once(':') {
            Some((host, digits)) => match digits.parse::<u16>() {
                Ok(port) => (host.to_string(), Some(port)),
                Err(_) => return None,
            },
            None => (remainder.to_string(), None),
        }
    };
    let host = usable_host_token(&host)?.to_string();
    Some(JumpTarget { host, user, port })
}

pub fn parse_proxy_jump(value: &str) -> Vec<JumpTarget> {
    value
        .split(',')
        .filter_map(parse_jump_target)
        .take(MAX_SEGMENTS)
        .collect()
}

/// Only a bare program name is summarized, never an argument. A proxy command
/// can carry tokens and credentials, and no part of it is worth guessing at.
pub fn proxy_program_name(command: &str) -> Option<String> {
    let first = command.split_whitespace().next()?;
    if first.len() > 64 {
        return None;
    }
    let usable = first
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || r"._-+:/\".contains(character));
    if !usable {
        return None;
    }
    Path::new(first)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

pub fn parse_effective_configuration(text: &str) -> EffectiveConfiguration {
    let mut values: HashMap<String, Vec<String>> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        values
            .entry(key.to_ascii_lowercase())
            .or_default()
            .push(value.trim().to_string());
    }
    let first = |key: &str| {
        values
            .get(key)
            .and_then(|entries| entries.first())
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"))
            .map(str::to_string)
    };
    EffectiveConfiguration {
        hostname: first("hostname"),
        user: first("user"),
        port: first("port").and_then(|value| value.parse().ok()),
        identity_files: values.get("identityfile").cloned().unwrap_or_default(),
        proxy_jump: first("proxyjump")
            .map(|value| parse_proxy_jump(&value))
            .unwrap_or_default(),
        proxy_command: first("proxycommand"),
    }
}

fn visit_key(target: &JumpTarget) -> String {
    format!(
        "{}|{}|{}",
        target.host.to_ascii_lowercase(),
        target.user.clone().unwrap_or_default(),
        target.port.map(|port| port.to_string()).unwrap_or_default()
    )
}

fn read_effective_configuration(
    ssh_path: &Path,
    target: &JumpTarget,
    identity_file: Option<&str>,
) -> Result<String, String> {
    let mut child = background_command(ssh_path)
        .args(effective_configuration_arguments(target, identity_file))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run the OpenSSH client: {error}"))?;
    let status = match child.wait_timeout(RESOLVE_TIMEOUT) {
        Ok(Some(status)) => status,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Reading the effective configuration timed out".into());
        }
        Err(error) => {
            return Err(format!(
                "Could not read the effective configuration: {error}"
            ));
        }
    };
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not read the effective configuration: {error}"))?;
    if !status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "The OpenSSH client could not resolve this configuration".into()
        } else {
            stderr
        });
    }
    let mut stdout = output.stdout;
    stdout.truncate(MAX_OUTPUT_BYTES);
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

fn segment_from(
    kind: &str,
    target: &JumpTarget,
    configuration: &EffectiveConfiguration,
) -> RouteSegment {
    let opaque = configuration
        .proxy_command
        .as_deref()
        .filter(|_| configuration.proxy_jump.is_empty());
    RouteSegment {
        kind: kind.into(),
        status: if opaque.is_some() {
            SEGMENT_OPAQUE_PROXY.into()
        } else {
            SEGMENT_RESOLVED.into()
        },
        alias: target.host.clone(),
        hostname: configuration.hostname.clone(),
        user: target.user.clone().or_else(|| configuration.user.clone()),
        port: target.port.or(configuration.port),
        identity_files: configuration.identity_files.clone(),
        proxy_program: opaque.and_then(proxy_program_name),
        note: opaque.map(|_| OPAQUE_PROXY_NOTE.to_string()),
    }
}

fn unresolved_segment(kind: &str, target: &JumpTarget, status: &str, note: &str) -> RouteSegment {
    RouteSegment {
        kind: kind.into(),
        status: status.into(),
        alias: target.host.clone(),
        hostname: None,
        user: target.user.clone(),
        port: target.port,
        identity_files: Vec::new(),
        proxy_program: None,
        note: Some(note.to_string()),
    }
}

struct Expansion<'a> {
    ssh_path: &'a Path,
    identity_file: Option<&'a str>,
    visited: HashSet<String>,
    segments: Vec<RouteSegment>,
    truncated: bool,
}

impl Expansion<'_> {
    fn expand(&mut self, target: &JumpTarget, kind: &str) {
        if self.segments.len() >= MAX_SEGMENTS {
            self.truncated = true;
            self.segments
                .push(unresolved_segment(kind, target, SEGMENT_LIMIT, LIMIT_NOTE));
            return;
        }
        let key = visit_key(target);
        if !self.visited.insert(key) {
            self.segments
                .push(unresolved_segment(kind, target, SEGMENT_LOOP, LOOP_NOTE));
            return;
        }
        match read_effective_configuration(self.ssh_path, target, self.identity_file) {
            Ok(text) => {
                let configuration = parse_effective_configuration(&text);
                for hop in &configuration.proxy_jump {
                    self.expand(hop, SEGMENT_JUMP);
                }
                self.segments
                    .push(segment_from(kind, target, &configuration));
            }
            Err(error) => {
                self.segments
                    .push(unresolved_segment(kind, target, SEGMENT_UNRESOLVED, &error));
            }
        }
    }
}

pub fn origin_segment() -> RouteSegment {
    RouteSegment {
        kind: SEGMENT_ORIGIN.into(),
        status: SEGMENT_RESOLVED.into(),
        alias: "This PC".into(),
        hostname: None,
        user: None,
        port: None,
        identity_files: Vec::new(),
        proxy_program: None,
        note: None,
    }
}

pub fn route_status(segments: &[RouteSegment]) -> &'static str {
    if segments
        .iter()
        .all(|segment| segment.status == SEGMENT_RESOLVED)
    {
        ROUTE_RESOLVED
    } else {
        ROUTE_PARTIAL
    }
}

pub fn resolve_route(connection: &SavedConnection) -> Result<SshRoute, String> {
    let ssh_path = detect_ssh_path()
        .ok_or_else(|| "The Windows OpenSSH client was not found on this PC".to_string())?;
    let destination = JumpTarget {
        host: usable_host_token(&connection.destination)
            .ok_or_else(|| "This connection's destination cannot be resolved".to_string())?
            .to_string(),
        user: connection.username.clone(),
        port: connection.port,
    };
    let mut expansion = Expansion {
        ssh_path: &ssh_path,
        identity_file: connection.identity_file.as_deref(),
        visited: HashSet::new(),
        segments: vec![origin_segment()],
        truncated: false,
    };
    expansion.expand(&destination, SEGMENT_DESTINATION);
    let segments = expansion.segments;
    let status = route_status(&segments);
    Ok(SshRoute {
        connection_id: connection.id.clone(),
        resolved_at: Utc::now().to_rfc3339(),
        status: status.into(),
        truncated: expansion.truncated,
        note: Some(
            "Read from the installed OpenSSH client's effective configuration. No host was contacted."
                .into(),
        ),
        segments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str) -> JumpTarget {
        JumpTarget {
            host: host.into(),
            user: None,
            port: None,
        }
    }

    #[test]
    fn the_effective_configuration_call_never_carries_a_remote_command() {
        let arguments = effective_configuration_arguments(
            &JumpTarget {
                host: "web-01".into(),
                user: Some("deploy".into()),
                port: Some(2222),
            },
            Some(r"C:\keys\id_ed25519"),
        );
        assert_eq!(
            arguments,
            vec![
                "-G",
                "-l",
                "deploy",
                "-p",
                "2222",
                "-i",
                r"C:\keys\id_ed25519",
                "web-01"
            ]
        );
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| *argument == "-G")
                .count(),
            1
        );
    }

    #[test]
    fn a_bare_destination_needs_no_overrides() {
        assert_eq!(
            effective_configuration_arguments(&target("web-01"), None),
            vec!["-G", "web-01"]
        );
    }

    #[test]
    fn a_host_token_that_could_be_read_as_an_option_is_refused() {
        assert_eq!(usable_host_token("web-01"), Some("web-01"));
        assert_eq!(usable_host_token(" web-01 "), Some("web-01"));
        assert_eq!(usable_host_token("2001:db8::1"), Some("2001:db8::1"));
        for rejected in [
            "",
            "-oProxyCommand=id",
            "--help",
            "web 01",
            "user@host",
            "host;id",
            "$(id)",
            &"a".repeat(256),
        ] {
            assert_eq!(usable_host_token(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn jump_targets_keep_their_user_and_port() {
        assert_eq!(
            parse_jump_target("deploy@bastion.example:2222"),
            Some(JumpTarget {
                host: "bastion.example".into(),
                user: Some("deploy".into()),
                port: Some(2222)
            })
        );
        assert_eq!(
            parse_jump_target("bastion.example"),
            Some(target("bastion.example"))
        );
    }

    #[test]
    fn an_ipv6_jump_target_keeps_its_literal_apart_from_the_port() {
        assert_eq!(
            parse_jump_target("[2001:db8::1]:2222"),
            Some(JumpTarget {
                host: "2001:db8::1".into(),
                user: None,
                port: Some(2222)
            })
        );
        assert_eq!(
            parse_jump_target("[2001:db8::1]"),
            Some(target("2001:db8::1"))
        );
    }

    #[test]
    fn an_unusable_jump_entry_is_dropped_rather_than_guessed_at() {
        for rejected in [
            "",
            "none",
            "None",
            "host:notaport",
            "-oProxyCommand=id",
            "@host",
        ] {
            assert_eq!(parse_jump_target(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn a_proxy_jump_chain_keeps_its_order_and_stays_bounded() {
        let chain = parse_proxy_jump("first.example,deploy@second.example:2222,third.example");
        assert_eq!(
            chain
                .iter()
                .map(|hop| hop.host.as_str())
                .collect::<Vec<_>>(),
            vec!["first.example", "second.example", "third.example"]
        );
        let long = (0..MAX_SEGMENTS + 5)
            .map(|index| format!("host-{index}"))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_proxy_jump(&long).len(), MAX_SEGMENTS);
    }

    #[test]
    fn effective_configuration_keeps_alias_and_resolved_hostname_apart() {
        let text = "user deploy\nhostname web-01.internal\nport 2222\nidentityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_rsa\nproxyjump bastion.example\nproxycommand none\naddressfamily any\n";
        let configuration = parse_effective_configuration(text);
        assert_eq!(configuration.hostname.as_deref(), Some("web-01.internal"));
        assert_eq!(configuration.user.as_deref(), Some("deploy"));
        assert_eq!(configuration.port, Some(2222));
        assert_eq!(configuration.identity_files.len(), 2);
        assert_eq!(configuration.proxy_jump, vec![target("bastion.example")]);
        assert_eq!(configuration.proxy_command, None);
    }

    #[test]
    fn a_configuration_without_a_resolved_hostname_reports_none() {
        let configuration = parse_effective_configuration("port 22\n");
        assert_eq!(configuration.hostname, None);
        assert_eq!(configuration.user, None);
        assert!(configuration.proxy_jump.is_empty());
    }

    #[test]
    fn an_unknown_key_or_malformed_line_is_ignored() {
        let configuration =
            parse_effective_configuration("somethingnew value\nnokeyvalue\n\nport 22\n");
        assert_eq!(configuration.port, Some(22));
    }

    #[test]
    fn a_proxy_command_makes_the_segment_opaque_and_shows_no_arguments() {
        let configuration = parse_effective_configuration(
            "hostname web-01\nproxycommand C:\\tools\\connect.exe --token abc123 %h %p\n",
        );
        let segment = segment_from(SEGMENT_DESTINATION, &target("web-01"), &configuration);
        assert_eq!(segment.status, SEGMENT_OPAQUE_PROXY);
        assert_eq!(segment.proxy_program.as_deref(), Some("connect.exe"));
        assert_eq!(segment.note.as_deref(), Some(OPAQUE_PROXY_NOTE));
        let rendered = serde_json::to_string(&segment).expect("segment serializes");
        assert!(!rendered.contains("abc123"));
        assert!(!rendered.contains("--token"));
    }

    #[test]
    fn a_proxy_command_that_is_not_a_bare_program_is_summarized_as_nothing() {
        assert_eq!(proxy_program_name(""), None);
        assert_eq!(proxy_program_name("$(id)"), None);
        assert_eq!(proxy_program_name("'weird name'"), None);
        assert_eq!(proxy_program_name(&"a".repeat(65)), None);
        assert_eq!(
            proxy_program_name("ssh -W %h:%p bastion"),
            Some("ssh".into())
        );
    }

    #[test]
    fn a_proxy_jump_wins_over_the_proxy_command_open_ssh_derived_from_it() {
        // OpenSSH reports the ProxyCommand it built for a ProxyJump. That route
        // is interpretable, so the segment must not be marked opaque.
        let configuration = parse_effective_configuration(
            "hostname web-01\nproxyjump bastion.example\nproxycommand ssh -W %h:%p bastion.example\n",
        );
        let segment = segment_from(SEGMENT_DESTINATION, &target("web-01"), &configuration);
        assert_eq!(segment.status, SEGMENT_RESOLVED);
        assert_eq!(segment.proxy_program, None);
        assert_eq!(segment.note, None);
    }

    #[test]
    fn a_jump_specs_user_and_port_take_precedence_over_the_resolved_ones() {
        let configuration =
            parse_effective_configuration("hostname b.internal\nuser root\nport 22\n");
        let segment = segment_from(
            SEGMENT_JUMP,
            &JumpTarget {
                host: "bastion".into(),
                user: Some("deploy".into()),
                port: Some(2222),
            },
            &configuration,
        );
        assert_eq!(segment.alias, "bastion");
        assert_eq!(segment.hostname.as_deref(), Some("b.internal"));
        assert_eq!(segment.user.as_deref(), Some("deploy"));
        assert_eq!(segment.port, Some(2222));
    }

    #[test]
    fn a_route_is_partial_when_any_segment_is_not_resolved() {
        let resolved = vec![origin_segment()];
        assert_eq!(route_status(&resolved), ROUTE_RESOLVED);
        let partial = vec![
            origin_segment(),
            unresolved_segment(SEGMENT_JUMP, &target("bastion"), SEGMENT_LOOP, LOOP_NOTE),
        ];
        assert_eq!(route_status(&partial), ROUTE_PARTIAL);
    }

    #[test]
    fn a_loop_is_reported_once_and_not_followed() {
        let mut expansion = Expansion {
            ssh_path: Path::new("ssh.exe"),
            identity_file: None,
            visited: HashSet::new(),
            segments: Vec::new(),
            truncated: false,
        };
        expansion.visited.insert(visit_key(&target("bastion")));
        expansion.expand(&target("bastion"), SEGMENT_JUMP);
        assert_eq!(expansion.segments.len(), 1);
        assert_eq!(expansion.segments[0].status, SEGMENT_LOOP);
        assert_eq!(expansion.segments[0].note.as_deref(), Some(LOOP_NOTE));
    }

    #[test]
    fn the_segment_limit_stops_expansion_and_marks_the_route_truncated() {
        let mut expansion = Expansion {
            ssh_path: Path::new("ssh.exe"),
            identity_file: None,
            visited: HashSet::new(),
            segments: (0..MAX_SEGMENTS).map(|_| origin_segment()).collect(),
            truncated: false,
        };
        expansion.expand(&target("one-too-many"), SEGMENT_JUMP);
        assert!(expansion.truncated);
        assert_eq!(expansion.segments.len(), MAX_SEGMENTS + 1);
        assert_eq!(expansion.segments[MAX_SEGMENTS].status, SEGMENT_LIMIT);
    }

    #[test]
    fn the_route_reader_holds_no_remote_command_path() {
        let source = include_str!("ssh_route.rs");
        let collectors = &source[..source.find("mod tests").expect("tests module exists")];
        // Route inspection is local. Split so the assertion text itself is not
        // what the scan finds.
        assert!(!collectors.contains(concat!("Remote", "CommandExecutor")));
        assert!(!collectors.contains("run_ssh"));
        for connecting in ["-W", "-N", "-L", "-R", "-D", "BatchMode"] {
            assert!(
                !collectors.contains(&format!("\"{connecting}\"")),
                "route inspection must not pass {connecting}"
            );
        }
    }
}
