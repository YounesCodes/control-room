//! Turns a reported Enhanced History command into a typed object reference.
//!
//! The parser only ever receives a command string that the opt-in Bash
//! integration already reported. It never sees keystrokes, terminal output, or
//! scrollback. It accepts a small allowlist of read-only inspection commands
//! and returns a reference only when exactly one supported object is
//! unambiguous. Everything else yields no context.

use crate::{
    models::TerminalContextReference,
    ssh::{validate_container_id, validate_systemd_unit_id},
};

const MAX_COMMAND_BYTES: usize = 4096;
pub const KIND_SYSTEMD_UNIT: &str = "systemdUnit";
pub const KIND_DOCKER_CONTAINER: &str = "dockerContainer";

/// Characters that give the shell a second meaning. An unquoted occurrence
/// means the command is a pipeline, a substitution, a glob, or several
/// commands, and none of those carry one unambiguous object.
const SHELL_METACHARACTERS: &str = "|&;<>()$`*?[]{}~!#\n\r";

/// Suffixes systemd recognises as unit types. Anything else makes `systemctl`
/// append `.service`, and this parser follows the same rule.
const UNIT_SUFFIXES: [&str; 11] = [
    ".service",
    ".socket",
    ".timer",
    ".mount",
    ".automount",
    ".target",
    ".device",
    ".swap",
    ".path",
    ".slice",
    ".scope",
];

/// `systemctl` verbs that only read state. Lifecycle verbs deliberately yield
/// no context: Control Room never offers a route built from a write command.
const SYSTEMCTL_READ_VERBS: [&str; 7] = [
    "status",
    "show",
    "cat",
    "is-active",
    "is-enabled",
    "is-failed",
    "list-dependencies",
];

#[derive(Default)]
struct OptionRules {
    /// Options that always take a value, inline or as the next argument.
    long_with_value: &'static [&'static str],
    /// Options that never take a value.
    long_flags: &'static [&'static str],
    /// Options that accept an inline value and otherwise take none.
    long_optional: &'static [&'static str],
    /// Options that take a value, but only consume the next argument when it is
    /// a plain number. `journalctl -n -u nginx` must not swallow `-u`.
    long_numeric: &'static [&'static str],
    short_with_value: &'static [char],
    short_flags: &'static [char],
    short_optional: &'static [char],
    short_numeric: &'static [char],
    /// Options that move the request to another host, another daemon, another
    /// root, or the user manager. They make the reference wrong, not unknown.
    rejected: &'static [&'static str],
}

struct ScannedArguments {
    options: Vec<(String, Option<String>)>,
    operands: Vec<String>,
    /// Index of the argument that stopped a leading-option scan.
    stopped_at: usize,
}

impl ScannedArguments {
    fn option_values(&self, name: &str, alias: &str) -> Vec<&str> {
        self.options
            .iter()
            .filter(|(option, _)| option == name || option == alias)
            .filter_map(|(_, value)| value.as_deref())
            .collect()
    }
}

pub fn parse_terminal_context(command: &str) -> Option<TerminalContextReference> {
    let trimmed = command.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_COMMAND_BYTES {
        return None;
    }
    let tokens = tokenize(trimmed)?;
    let tokens = strip_sudo(&tokens)?;
    let program = tokens.first()?;
    if is_assignment(program) {
        return None;
    }
    let arguments = &tokens[1..];
    let (kind, id) = match program_name(program) {
        "systemctl" => parse_systemctl(arguments),
        "journalctl" => parse_journalctl(arguments),
        "docker" => parse_docker(arguments),
        _ => None,
    }?;
    Some(TerminalContextReference {
        kind: kind.into(),
        id,
        source_command: trimmed.into(),
    })
}

fn tokenize(command: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut characters = command.chars();
    while let Some(character) = characters.next() {
        match character {
            ' ' | '\t' => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            '\'' => {
                started = true;
                loop {
                    match characters.next() {
                        Some('\'') => break,
                        Some(inner) => current.push(inner),
                        None => return None,
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match characters.next() {
                        Some('"') => break,
                        Some('\\') => {
                            let escaped = characters.next()?;
                            if !matches!(escaped, '\\' | '"' | '$' | '`') {
                                current.push('\\');
                            }
                            current.push(escaped);
                        }
                        Some('$' | '`') => return None,
                        Some(inner) => current.push(inner),
                        None => return None,
                    }
                }
            }
            '\\' => {
                started = true;
                current.push(characters.next()?);
            }
            _ if SHELL_METACHARACTERS.contains(character) => return None,
            _ => {
                started = true;
                current.push(character);
            }
        }
    }
    if started {
        tokens.push(current);
    }
    if tokens.is_empty() {
        None
    } else {
        Some(tokens)
    }
}

fn program_name(token: &str) -> &str {
    token.rsplit('/').next().unwrap_or(token)
}

fn is_assignment(token: &str) -> bool {
    let Some(index) = token.find('=') else {
        return false;
    };
    let name = &token[..index];
    !name.is_empty()
        && !name.starts_with(|character: char| character.is_ascii_digit())
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// Accepts a bare `sudo <command>` wrapper. `sudo` with options can change the
/// target user or environment, so it yields no context.
fn strip_sudo(tokens: &[String]) -> Option<&[String]> {
    if program_name(tokens.first()?) != "sudo" {
        return Some(tokens);
    }
    let rest = tokens.get(1..)?;
    let next = rest.first()?;
    if next.starts_with('-') || is_assignment(next) || program_name(next) == "sudo" {
        return None;
    }
    Some(rest)
}

fn scan_arguments(
    arguments: &[String],
    rules: &OptionRules,
    stop_at_first_operand: bool,
) -> Option<ScannedArguments> {
    let mut options = Vec::new();
    let mut operands = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].as_str();
        if argument == "--" {
            if stop_at_first_operand {
                break;
            }
            operands.extend(arguments[index + 1..].iter().cloned());
            index = arguments.len();
            break;
        }
        if let Some(long) = argument.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (long, None),
            };
            if name.is_empty() || rules.rejected.contains(&name) {
                return None;
            }
            if rules.long_with_value.contains(&name) {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        index += 1;
                        arguments.get(index)?.clone()
                    }
                };
                options.push((name.to_string(), Some(value)));
            } else if rules.long_numeric.contains(&name) {
                let value = match inline {
                    Some(value) => Some(value),
                    None => take_numeric(arguments, &mut index),
                };
                options.push((name.to_string(), value));
            } else if rules.long_optional.contains(&name) {
                options.push((name.to_string(), inline));
            } else if rules.long_flags.contains(&name) && inline.is_none() {
                options.push((name.to_string(), None));
            } else {
                return None;
            }
        } else if argument.starts_with('-') && argument.len() > 1 {
            let cluster: Vec<char> = argument.chars().skip(1).collect();
            let mut position = 0;
            while position < cluster.len() {
                let flag = cluster[position];
                let name = flag.to_string();
                if rules.rejected.contains(&name.as_str()) {
                    return None;
                }
                let inline: Option<String> = if position + 1 < cluster.len() {
                    Some(cluster[position + 1..].iter().collect())
                } else {
                    None
                };
                if rules.short_with_value.contains(&flag) {
                    let value = match inline {
                        Some(value) => value,
                        None => {
                            index += 1;
                            arguments.get(index)?.clone()
                        }
                    };
                    options.push((name, Some(value)));
                    position = cluster.len();
                } else if rules.short_numeric.contains(&flag) {
                    let value = match inline {
                        Some(value) => {
                            if !value.chars().all(|character| character.is_ascii_digit()) {
                                return None;
                            }
                            Some(value)
                        }
                        None => take_numeric(arguments, &mut index),
                    };
                    options.push((name, value));
                    position = cluster.len();
                } else if rules.short_optional.contains(&flag) {
                    options.push((name, inline));
                    position = cluster.len();
                } else if rules.short_flags.contains(&flag) {
                    options.push((name, None));
                    position += 1;
                } else {
                    return None;
                }
            }
        } else {
            if stop_at_first_operand {
                break;
            }
            operands.push(argument.to_string());
        }
        index += 1;
    }
    Some(ScannedArguments {
        options,
        operands,
        stopped_at: index,
    })
}

fn take_numeric(arguments: &[String], index: &mut usize) -> Option<String> {
    let next = arguments.get(*index + 1)?;
    if next.is_empty() || !next.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    *index += 1;
    Some(next.clone())
}

fn parse_systemctl(arguments: &[String]) -> Option<(&'static str, String)> {
    let rules = OptionRules {
        long_with_value: &[
            "type",
            "state",
            "property",
            "lines",
            "output",
            "since",
            "until",
            "job-mode",
            "signal",
            "kill-who",
            "kill-whom",
            "what",
        ],
        long_flags: &[
            "system",
            "all",
            "full",
            "quiet",
            "no-pager",
            "no-legend",
            "no-ask-password",
            "plain",
            "reverse",
            "after",
            "before",
            "value",
            "show-types",
            "recursive",
        ],
        short_with_value: &['t', 'p', 'n', 'o'],
        short_flags: &['a', 'l', 'q', 'r'],
        rejected: &[
            "user", "global", "host", "H", "machine", "M", "root", "image",
        ],
        ..OptionRules::default()
    };
    let scanned = scan_arguments(arguments, &rules, false)?;
    let verb = scanned.operands.first()?.as_str();
    if !SYSTEMCTL_READ_VERBS.contains(&verb) {
        return None;
    }
    let [unit] = scanned.operands.get(1..)? else {
        return None;
    };
    Some((KIND_SYSTEMD_UNIT, normalize_unit(unit)?))
}

fn parse_journalctl(arguments: &[String]) -> Option<(&'static str, String)> {
    let rules = OptionRules {
        long_with_value: &[
            "unit",
            "since",
            "until",
            "priority",
            "output",
            "identifier",
            "grep",
            "facility",
            "cursor",
            "after-cursor",
            "output-fields",
        ],
        long_flags: &[
            "follow",
            "no-pager",
            "no-hostname",
            "no-full",
            "full",
            "reverse",
            "catalog",
            "dmesg",
            "quiet",
            "all",
            "pager-end",
            "utc",
            "system",
        ],
        long_optional: &["boot"],
        long_numeric: &["lines"],
        short_with_value: &['u', 'p', 'o', 't', 'g'],
        short_flags: &['f', 'e', 'r', 'k', 'x', 'q', 'a', 'l'],
        short_optional: &['b'],
        short_numeric: &['n'],
        rejected: &[
            "user",
            "user-unit",
            "machine",
            "M",
            "directory",
            "D",
            "file",
            "root",
            "image",
            "namespace",
        ],
    };
    let scanned = scan_arguments(arguments, &rules, false)?;
    if !scanned.operands.is_empty() {
        return None;
    }
    let units = scanned.option_values("unit", "u");
    let [unit] = units.as_slice() else {
        return None;
    };
    Some((KIND_SYSTEMD_UNIT, normalize_unit(unit)?))
}

fn parse_docker(arguments: &[String]) -> Option<(&'static str, String)> {
    let global = OptionRules {
        long_with_value: &["log-level"],
        long_flags: &["debug", "tls", "tlsverify"],
        short_with_value: &['l'],
        short_flags: &['D'],
        rejected: &["host", "H", "context", "c", "config"],
        ..OptionRules::default()
    };
    let scanned = scan_arguments(arguments, &global, true)?;
    let mut rest = arguments.get(scanned.stopped_at..)?;
    let mut command = rest.first()?.as_str();
    // `docker container logs` and `docker logs` name the same object.
    if command == "container" {
        rest = rest.get(1..)?;
        command = rest.first()?.as_str();
    } else if command == "inspect" {
        // A bare `docker inspect` also accepts images, networks, and volumes,
        // so the object type is unknown. Only `docker container inspect` is
        // unambiguous.
        return None;
    }
    let rules = match command {
        "logs" => OptionRules {
            long_with_value: &["tail", "since", "until"],
            long_flags: &["follow", "timestamps", "details"],
            short_with_value: &['n'],
            short_flags: &['f', 't'],
            ..OptionRules::default()
        },
        "inspect" => OptionRules {
            long_with_value: &["format"],
            long_flags: &["size"],
            short_with_value: &['f'],
            short_flags: &['s'],
            ..OptionRules::default()
        },
        "stats" => OptionRules {
            long_with_value: &["format"],
            long_flags: &["no-stream", "no-trunc", "all"],
            short_flags: &['a'],
            ..OptionRules::default()
        },
        "port" | "top" => OptionRules::default(),
        _ => return None,
    };
    let scanned = scan_arguments(rest.get(1..)?, &rules, false)?;
    let [container] = scanned.operands.as_slice() else {
        return None;
    };
    validate_container_id(container).ok()?;
    Some((KIND_DOCKER_CONTAINER, container.clone()))
}

/// Applies systemd's own suffix rule, then the Control Room unit allowlist.
/// A template unit with no instance (`getty@.service`) names no single unit.
fn normalize_unit(value: &str) -> Option<String> {
    if value.is_empty() || value.starts_with('.') {
        return None;
    }
    let candidate = if UNIT_SUFFIXES.iter().any(|suffix| value.ends_with(suffix)) {
        value.to_string()
    } else {
        format!("{value}.service")
    };
    if candidate.split('.').next()?.ends_with('@') {
        return None;
    }
    validate_systemd_unit_id(&candidate).ok()?;
    Some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(command: &str) -> (String, String) {
        let reference = parse_terminal_context(command)
            .unwrap_or_else(|| panic!("expected context for {command}"));
        assert_eq!(reference.source_command, command.trim());
        (reference.kind, reference.id)
    }

    fn unit(command: &str) -> String {
        let (kind, id) = parsed(command);
        assert_eq!(kind, KIND_SYSTEMD_UNIT);
        id
    }

    fn container(command: &str) -> String {
        let (kind, id) = parsed(command);
        assert_eq!(kind, KIND_DOCKER_CONTAINER);
        id
    }

    fn none(command: &str) {
        assert!(
            parse_terminal_context(command).is_none(),
            "expected no context for {command}"
        );
    }

    #[test]
    fn systemctl_read_verbs_name_one_unit() {
        assert_eq!(unit("systemctl status nginx"), "nginx.service");
        assert_eq!(unit("systemctl status nginx.service"), "nginx.service");
        assert_eq!(unit("systemctl is-active ssh.socket"), "ssh.socket");
        assert_eq!(unit("systemctl cat backup.timer"), "backup.timer");
        assert_eq!(
            unit("systemctl --no-pager -l status nginx"),
            "nginx.service"
        );
        assert_eq!(unit("systemctl show -p Requires nginx"), "nginx.service");
        assert_eq!(unit("/usr/bin/systemctl status nginx"), "nginx.service");
        assert_eq!(unit("sudo systemctl status nginx"), "nginx.service");
    }

    #[test]
    fn systemctl_write_verbs_and_extra_units_give_no_context() {
        none("systemctl restart nginx");
        none("systemctl stop nginx");
        none("systemctl status nginx postgresql");
        none("systemctl status");
        none("systemctl daemon-reload");
    }

    #[test]
    fn options_that_change_the_target_give_no_context() {
        none("systemctl --user status pipewire");
        none("systemctl -H other-host status nginx");
        none("systemctl --machine=container status nginx");
        none("systemctl --root=/mnt status nginx");
        none("journalctl --user-unit pipewire");
        none("journalctl -M container -u nginx");
        none("docker -H tcp://other:2375 logs api");
        none("docker --context remote logs api");
        none("sudo -u www-data systemctl status nginx");
    }

    #[test]
    fn quoting_variants_resolve_to_the_same_unit() {
        assert_eq!(unit("systemctl status 'nginx.service'"), "nginx.service");
        assert_eq!(unit(r#"systemctl status "nginx.service""#), "nginx.service");
        assert_eq!(unit(r"systemctl status nginx\.service"), "nginx.service");
        assert_eq!(
            unit(r"systemctl status 'srv-data\x2darchive.mount'"),
            r"srv-data\x2darchive.mount"
        );
    }

    #[test]
    fn shell_syntax_and_expansion_give_no_context() {
        none("systemctl status nginx | less");
        none("systemctl status nginx && systemctl status ssh");
        none("systemctl status $(cat unit)");
        none(r#"systemctl status "$UNIT""#);
        none("systemctl status nginx > out.txt");
        none("systemctl status ngin*");
        none("systemctl status 'nginx");
        none("SYSTEMD_PAGER= systemctl status nginx");
        none("docker logs api; rm -rf /");
    }

    #[test]
    fn unsupported_unit_types_and_templates_give_no_context() {
        none("systemctl status multi-user.target");
        none("systemctl status dev-sda.device");
        none("systemctl status getty@.service");
        assert_eq!(
            unit("systemctl status getty@tty1.service"),
            "getty@tty1.service"
        );
    }

    #[test]
    fn journalctl_reads_exactly_one_unit_option() {
        assert_eq!(unit("journalctl -u nginx"), "nginx.service");
        assert_eq!(unit("journalctl -fu nginx"), "nginx.service");
        assert_eq!(unit("journalctl --unit=nginx.service -f"), "nginx.service");
        assert_eq!(unit("journalctl -n 100 -u nginx"), "nginx.service");
        assert_eq!(unit("journalctl -n -u nginx"), "nginx.service");
        assert_eq!(unit("journalctl -b -u nginx"), "nginx.service");
        assert_eq!(
            unit("journalctl -u nginx --since '2026-01-01 00:00'"),
            "nginx.service"
        );
        none("journalctl -u nginx -u ssh");
        none("journalctl -f");
        none("journalctl -u nginx _PID=1");
    }

    #[test]
    fn docker_read_subcommands_name_one_container() {
        assert_eq!(container("docker logs api"), "api");
        assert_eq!(container("docker logs -f --tail 200 api"), "api");
        assert_eq!(container("docker logs --tail=200 api"), "api");
        assert_eq!(container("docker container logs api"), "api");
        assert_eq!(container("docker container inspect api"), "api");
        assert_eq!(container("docker port api"), "api");
        assert_eq!(container("docker top api"), "api");
        assert_eq!(container("docker stats --no-stream api"), "api");
        assert_eq!(container("sudo docker logs api"), "api");
    }

    #[test]
    fn ambiguous_or_writing_docker_commands_give_no_context() {
        none("docker inspect api");
        none("docker logs");
        none("docker logs api web");
        none("docker ps");
        none("docker exec -it api bash");
        none("docker rm api");
        none("docker top api aux");
    }

    #[test]
    fn unrelated_and_oversized_commands_give_no_context() {
        none("ls -la");
        none("");
        none("   ");
        none("vim /etc/nginx/nginx.conf");
        none(&format!(
            "systemctl status {}",
            "a".repeat(MAX_COMMAND_BYTES)
        ));
    }

    #[test]
    fn detection_never_builds_a_remote_command() {
        // Split so the assertion text itself is not what the scan finds.
        let source = include_str!("terminal_context.rs");
        assert!(!source.contains(concat!("Remote", "CommandExecutor")));
        assert!(!source.contains(concat!("background", "_command")));
        assert!(!source.contains(concat!("std::process", "::Command")));
    }
}
