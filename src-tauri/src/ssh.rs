use std::{
    env,
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use regex::Regex;
use wait_timeout::ChildExt;

use chrono::Utc;

use crate::models::{EffectiveSshConfiguration, EffectiveSshField, SavedConnection};

const SSH_INSPECTION_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_EFFECTIVE_CONFIG_BYTES: usize = 256 * 1024;
const MAX_SSH_DIAGNOSTIC_BYTES: usize = 16 * 1024;
const MAX_IDENTITY_FILES: usize = 32;

pub fn background_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub fn detect_ssh_path() -> Option<PathBuf> {
    let system = PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe");
    if system.is_file() {
        return Some(system);
    }
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|path| path.join("ssh.exe"))
            .find(|path| path.is_file())
    })
}

pub fn ssh_agent_available(ssh_path: Option<&Path>) -> bool {
    let Some(ssh_path) = ssh_path else {
        return false;
    };
    let ssh_add = ssh_path.with_file_name("ssh-add.exe");
    if !ssh_add.is_file() {
        return false;
    }
    let Ok(mut child) = background_command(ssh_add)
        .arg("-l")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    match child.wait_timeout(Duration::from_secs(2)) {
        Ok(Some(status)) => status.success(),
        Ok(None) | Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            false
        }
    }
}

pub fn ssh_config_path() -> String {
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".ssh")
        .join("config")
        .to_string_lossy()
        .to_string()
}

pub fn connection_arguments(connection: &SavedConnection, terminal: bool) -> Vec<String> {
    let mut arguments = Vec::new();
    if terminal {
        arguments.push("-tt".into());
    } else {
        arguments.extend([
            "-T".into(),
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "ConnectTimeout=10".into(),
        ]);
    }
    arguments.extend(saved_connection_target_arguments(connection));
    arguments
}

fn saved_connection_target_arguments(connection: &SavedConnection) -> Vec<String> {
    let mut arguments = Vec::new();
    if let Some(username) = &connection.username {
        arguments.extend(["-l".into(), username.clone()]);
    }
    if let Some(port) = connection.port {
        arguments.extend(["-p".into(), port.to_string()]);
    }
    if let Some(identity_file) = &connection.identity_file {
        arguments.extend(["-i".into(), identity_file.clone()]);
    }
    arguments.push(connection.destination.clone());
    arguments
}

pub fn effective_configuration_arguments(connection: &SavedConnection) -> Vec<String> {
    let mut arguments = vec!["-G".into()];
    arguments.extend(saved_connection_target_arguments(connection));
    arguments
}

pub fn inspect_effective_configuration(
    connection: &SavedConnection,
) -> Result<EffectiveSshConfiguration, String> {
    let ssh_path = detect_ssh_path().ok_or_else(|| {
        "Windows OpenSSH client was not found. Install the OpenSSH Client optional feature."
            .to_string()
    })?;
    inspect_effective_configuration_with(&ssh_path, connection)
}

fn inspect_effective_configuration_with(
    ssh_path: &Path,
    connection: &SavedConnection,
) -> Result<EffectiveSshConfiguration, String> {
    let version_output = run_capped_process(
        ssh_path,
        &["-V".into()],
        SSH_INSPECTION_TIMEOUT,
        4 * 1024,
        4 * 1024,
    )?;
    let ssh_version = parse_ssh_version(&version_output.stdout)
        .or_else(|| parse_ssh_version(&version_output.stderr));
    let output = run_capped_process(
        ssh_path,
        &effective_configuration_arguments(connection),
        SSH_INSPECTION_TIMEOUT,
        MAX_EFFECTIVE_CONFIG_BYTES,
        MAX_SSH_DIAGNOSTIC_BYTES,
    )?;
    let mut result = empty_effective_configuration(connection, ssh_version, output.status);
    if version_output.timed_out {
        result
            .parse_limitations
            .push("OpenSSH version detection timed out.".into());
    } else if result.ssh_version.is_none() {
        result
            .parse_limitations
            .push("OpenSSH did not return a recognizable version string.".into());
    }
    if output.timed_out {
        result.diagnostic = Some("OpenSSH effective configuration inspection timed out.".into());
        return Ok(result);
    }
    if output.status != Some(0) {
        result.diagnostic = Some(classify_effective_config_failure(&output.stderr));
        return Ok(result);
    }
    if output.stdout_truncated {
        result.diagnostic = Some(
            "OpenSSH effective configuration exceeded the safe output limit and was not displayed."
                .into(),
        );
        return Ok(result);
    }
    parse_effective_configuration(&output.stdout, connection, &mut result);
    if output.stderr_truncated {
        result
            .parse_limitations
            .push("OpenSSH diagnostic output was truncated and not displayed.".into());
    }
    Ok(result)
}

fn empty_effective_configuration(
    connection: &SavedConnection,
    ssh_version: Option<String>,
    exit_status: Option<i32>,
) -> EffectiveSshConfiguration {
    EffectiveSshConfiguration {
        connection_id: connection.id.clone(),
        ssh_version,
        exit_status,
        diagnostic: None,
        hostname: None,
        user: None,
        port: None,
        address_family: None,
        identity_files: Vec::new(),
        identities_only: None,
        proxy_jump: None,
        proxy_command_configured: false,
        canonicalize_hostname: None,
        server_alive_interval: None,
        server_alive_count_max: None,
        tcp_keep_alive: None,
        connect_timeout: None,
        parse_limitations: vec![
            "OpenSSH does not expose reliable source-file provenance or distinguish config values from built-in defaults."
                .into(),
            "OpenSSH may evaluate local Match exec rules while resolving configuration.".into(),
        ],
        collected_at: Utc::now().to_rfc3339(),
    }
}

fn parse_effective_configuration(
    output: &[u8],
    connection: &SavedConnection,
    result: &mut EffectiveSshConfiguration,
) {
    let decoded = String::from_utf8_lossy(output);
    if matches!(decoded, std::borrow::Cow::Owned(_)) {
        result
            .parse_limitations
            .push("Invalid UTF-8 bytes in OpenSSH output were replaced.".into());
    }
    let mut ignored = 0usize;
    let mut duplicates = 0usize;
    for line in decoded.lines() {
        let Some((key, value)) = line.split_once(char::is_whitespace) else {
            ignored += 1;
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        if value.is_empty() || value.chars().any(char::is_control) {
            ignored += 1;
            continue;
        }
        match key.as_str() {
            "hostname" if value.len() <= 1_024 => assign_field(
                &mut result.hostname,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "user" if value.len() <= 256 => assign_field(
                &mut result.user,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "port" if value.parse::<u16>().is_ok() => assign_field(
                &mut result.port,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "addressfamily" if matches!(value, "any" | "inet" | "inet6") => assign_field(
                &mut result.address_family,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "identityfile" if value != "none" => {
                if result.identity_files.len() < MAX_IDENTITY_FILES && value.len() <= 32_767 {
                    result
                        .identity_files
                        .push(effective_field(key.as_str(), value, connection));
                } else {
                    ignored += 1;
                }
            }
            "identitiesonly" if is_yes_no(value) => assign_field(
                &mut result.identities_only,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "proxyjump" if value != "none" && value.len() <= 2_048 => assign_field(
                &mut result.proxy_jump,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "proxycommand" => {
                result.proxy_command_configured |= value != "none";
            }
            "canonicalizehostname"
                if matches!(value, "yes" | "no" | "true" | "false" | "always") =>
            {
                assign_field(
                    &mut result.canonicalize_hostname,
                    effective_field(key.as_str(), value, connection),
                    &mut duplicates,
                )
            }
            "serveraliveinterval" if value.parse::<u32>().is_ok() => assign_field(
                &mut result.server_alive_interval,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "serveralivecountmax" if value.parse::<u32>().is_ok() => assign_field(
                &mut result.server_alive_count_max,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "tcpkeepalive" if is_yes_no(value) => assign_field(
                &mut result.tcp_keep_alive,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            "connecttimeout" if value == "none" || value.parse::<u32>().is_ok() => assign_field(
                &mut result.connect_timeout,
                effective_field(key.as_str(), value, connection),
                &mut duplicates,
            ),
            _ if is_exposed_effective_key(&key) => ignored += 1,
            _ => {}
        }
    }
    if result.proxy_command_configured {
        result
            .parse_limitations
            .push("ProxyCommand is configured, but its command text is redacted.".into());
    }
    if ignored > 0 {
        result.parse_limitations.push(format!(
            "{ignored} malformed or over-limit OpenSSH output line(s) were ignored."
        ));
    }
    if duplicates > 0 {
        result.parse_limitations.push(format!(
            "{duplicates} duplicate single-value field(s) were ignored after the first value."
        ));
    }
}

fn effective_field(key: &str, value: &str, connection: &SavedConnection) -> EffectiveSshField {
    let saved_override = match key {
        "user" => connection.username.as_deref() == Some(value),
        "port" => connection
            .port
            .is_some_and(|port| port.to_string() == value),
        "identityfile" => connection
            .identity_file
            .as_deref()
            .is_some_and(|path| path.eq_ignore_ascii_case(value)),
        _ => false,
    };
    EffectiveSshField {
        value: value.to_string(),
        origin: if saved_override {
            "savedConnectionOverride".into()
        } else {
            "openSshResolved".into()
        },
    }
}

fn assign_field(
    target: &mut Option<EffectiveSshField>,
    value: EffectiveSshField,
    duplicates: &mut usize,
) {
    if target.is_some() {
        *duplicates += 1;
    } else {
        *target = Some(value);
    }
}

fn is_yes_no(value: &str) -> bool {
    matches!(value, "yes" | "no" | "true" | "false")
}

fn is_exposed_effective_key(key: &str) -> bool {
    matches!(
        key,
        "hostname"
            | "user"
            | "port"
            | "addressfamily"
            | "identityfile"
            | "identitiesonly"
            | "proxyjump"
            | "proxycommand"
            | "canonicalizehostname"
            | "serveraliveinterval"
            | "serveralivecountmax"
            | "tcpkeepalive"
            | "connecttimeout"
    )
}

fn parse_ssh_version(output: &[u8]) -> Option<String> {
    let decoded = String::from_utf8_lossy(output);
    let line = decoded.lines().next()?.trim();
    if line.len() > 160
        || !line.starts_with("OpenSSH_")
        || !line
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.,+ -".contains(character))
    {
        return None;
    }
    Some(line.to_string())
}

fn classify_effective_config_failure(stderr: &[u8]) -> String {
    let diagnostic = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if diagnostic.contains("bad configuration option")
        || diagnostic.contains("terminating, 1 bad configuration options")
        || diagnostic.contains("invalid")
    {
        "OpenSSH could not parse the local configuration.".into()
    } else if diagnostic.contains("unknown option")
        || diagnostic.contains("illegal option")
        || diagnostic.contains("usage:")
    {
        "OpenSSH rejected an effective-configuration argument.".into()
    } else {
        "OpenSSH effective configuration inspection failed.".into()
    }
}

struct CappedProcessOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    timed_out: bool,
}

fn run_capped_process(
    program: &Path,
    arguments: &[String],
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<CappedProcessOutput, String> {
    let mut child = background_command(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("OpenSSH inspection could not start: {error}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("OpenSSH inspection output could not be opened".into());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("OpenSSH inspection diagnostics could not be opened".into());
    };
    let stdout_reader = thread::spawn(move || read_capped(stdout, stdout_limit));
    let stderr_reader = thread::spawn(move || read_capped(stderr, stderr_limit));
    let status = match child.wait_timeout(timeout) {
        Ok(status) => status,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!("OpenSSH inspection wait failed: {error}"));
        }
    };
    let timed_out = status.is_none();
    let status = if let Some(status) = status {
        status
    } else {
        let _ = child.kill();
        child
            .wait()
            .map_err(|error| format!("OpenSSH inspection cleanup failed: {error}"))?
    };
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| "OpenSSH inspection output reader failed".to_string())?
        .map_err(|error| format!("OpenSSH inspection output read failed: {error}"))?;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| "OpenSSH inspection diagnostic reader failed".to_string())?
        .map_err(|error| format!("OpenSSH inspection diagnostic read failed: {error}"))?;
    Ok(CappedProcessOutput {
        status: status.code(),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        timed_out,
    })
}

fn read_capped(mut reader: impl Read, limit: usize) -> Result<(Vec<u8>, bool), std::io::Error> {
    let mut retained = Vec::with_capacity(limit.min(8 * 1024));
    let mut truncated = false;
    let mut buffer = [0u8; 8 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let available = limit.saturating_sub(retained.len());
        let keep = count.min(available);
        retained.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    Ok((retained, truncated))
}

pub fn validate_systemd_unit_id(value: &str) -> Result<&str, String> {
    let supported_suffix = [".service", ".timer", ".mount", ".socket"]
        .iter()
        .any(|suffix| value.ends_with(suffix));
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' {
            if index + 3 >= bytes.len()
                || bytes[index + 1] != b'x'
                || !bytes[index + 2].is_ascii_hexdigit()
                || !bytes[index + 3].is_ascii_hexdigit()
            {
                return Err("Invalid systemd unit identifier".into());
            }
            index += 4;
            continue;
        }
        if !(byte.is_ascii_alphanumeric() || b"@_.:-".contains(&byte)) {
            return Err("Invalid systemd unit identifier".into());
        }
        index += 1;
    }
    if value.is_empty() || value.len() > 255 || !supported_suffix {
        return Err("Invalid systemd unit identifier".into());
    }
    Ok(value)
}

pub fn validate_container_id(value: &str) -> Result<&str, String> {
    validate_remote_identifier(
        value,
        r"^[A-Za-z0-9][A-Za-z0-9_.-]*$",
        "container identifier",
    )
}

fn validate_remote_identifier<'a>(
    value: &'a str,
    pattern: &str,
    label: &str,
) -> Result<&'a str, String> {
    if Regex::new(pattern).expect("constant regex").is_match(value) {
        Ok(value)
    } else {
        Err(format!("Invalid {label}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noninteractive_processes_use_the_background_command_factory() {
        let remote = include_str!("remote.rs");
        let commands = include_str!("commands.rs");
        let ssh = include_str!("ssh.rs");
        assert!(!remote.contains("Command::new("));
        assert!(!commands.contains("Command::new("));
        assert!(remote.matches("background_command(").count() >= 2);
        assert!(ssh.contains("background_command(ssh_add)"));
    }

    #[test]
    fn missing_ssh_path_cannot_probe_an_unrelated_path_entry() {
        assert!(!ssh_agent_available(None));
    }

    fn saved() -> SavedConnection {
        SavedConnection {
            id: "id".into(),
            display_name: "Laptop".into(),
            destination: "laptop".into(),
            username: None,
            port: None,
            identity_file: None,
            history_enabled: true,
            group_id: None,
            tags: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        }
    }

    #[test]
    fn open_ssh_defaults_are_not_overridden() {
        assert_eq!(connection_arguments(&saved(), true), vec!["-tt", "laptop"]);
    }

    #[test]
    fn explicit_overrides_are_separate_arguments() {
        let mut connection = saved();
        connection.username = Some("root".into());
        connection.port = Some(2222);
        connection.identity_file = Some(r"C:\keys\home key".into());
        assert_eq!(
            connection_arguments(&connection, true),
            vec![
                "-tt",
                "-l",
                "root",
                "-p",
                "2222",
                "-i",
                r"C:\keys\home key",
                "laptop"
            ]
        );
    }

    #[test]
    fn effective_config_reuses_the_saved_connection_target_arguments_without_connecting() {
        let mut connection = saved();
        connection.username = Some("root".into());
        connection.port = Some(2222);
        connection.identity_file = Some(r"C:\keys\home key".into());
        let effective = effective_configuration_arguments(&connection);
        let terminal = connection_arguments(&connection, true);
        assert_eq!(effective[0], "-G");
        assert_eq!(&effective[1..], &terminal[1..]);
        assert!(!effective.contains(&"-tt".to_string()));
        assert!(!effective.contains(&"-T".to_string()));
    }

    #[test]
    fn effective_config_parser_keeps_repeatable_fields_and_redacts_commands() {
        let mut connection = saved();
        connection.username = Some("root".into());
        connection.port = Some(2222);
        connection.identity_file = Some(r"C:\keys\id_ed25519".into());
        let output = br#"host laptop
hostname 192.0.2.10
user root
port 2222
addressfamily any
identityfile C:\keys\id_ed25519
identityfile ~/.ssh/id_rsa
identitiesonly yes
proxyjump bastion.example
proxycommand secret-token --connect %h
canonicalizehostname no
serveraliveinterval 30
serveralivecountmax 4
tcpkeepalive yes
connecttimeout none
unknownfield ignored
"#;
        let mut result =
            empty_effective_configuration(&connection, Some("OpenSSH_9.9".into()), Some(0));
        parse_effective_configuration(output, &connection, &mut result);

        assert_eq!(
            result.user,
            Some(EffectiveSshField {
                value: "root".into(),
                origin: "savedConnectionOverride".into()
            })
        );
        assert_eq!(result.identity_files.len(), 2);
        assert_eq!(result.identity_files[0].origin, "savedConnectionOverride");
        assert_eq!(result.proxy_jump.as_ref().unwrap().value, "bastion.example");
        assert!(result.proxy_command_configured);
        assert!(
            result
                .parse_limitations
                .iter()
                .any(|limitation| limitation.contains("ProxyCommand"))
        );
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("secret-token"));
    }

    #[test]
    fn effective_config_parser_ignores_invalid_typed_values_and_duplicate_scalars() {
        let connection = saved();
        let output = b"hostname first.example\nhostname second.example\nport nope\ntcpkeepalive maybe\nidentityfile one\nidentityfile two\n";
        let mut result = empty_effective_configuration(&connection, None, Some(0));
        parse_effective_configuration(output, &connection, &mut result);

        assert_eq!(result.hostname.unwrap().value, "first.example");
        assert!(result.port.is_none());
        assert!(result.tcp_keep_alive.is_none());
        assert_eq!(result.identity_files.len(), 2);
        assert!(
            result
                .parse_limitations
                .iter()
                .any(|limitation| limitation.contains("duplicate"))
        );
    }

    #[test]
    fn effective_config_failures_never_return_raw_diagnostics() {
        let raw =
            b"C:\\Users\\private\\.ssh\\config line 4: Bad configuration option: token-secret";
        let classified = classify_effective_config_failure(raw);
        assert_eq!(
            classified,
            "OpenSSH could not parse the local configuration."
        );
        assert!(!classified.contains("private"));
        assert!(!classified.contains("token-secret"));
    }

    #[test]
    fn capped_reader_drains_but_retains_only_the_limit() {
        let input = vec![b'x'; 32 * 1024];
        let (retained, truncated) = read_capped(input.as_slice(), 1024).unwrap();
        assert_eq!(retained.len(), 1024);
        assert!(truncated);
    }

    #[cfg(windows)]
    #[test]
    fn installed_openssh_supports_bounded_nonconnecting_effective_inspection() {
        let Some(ssh_path) = detect_ssh_path() else {
            return;
        };
        let output = run_capped_process(
            &ssh_path,
            &[
                "-G".into(),
                "-F".into(),
                "NUL".into(),
                "-l".into(),
                "control-room-test".into(),
                "-p".into(),
                "2222".into(),
                "example.invalid".into(),
            ],
            SSH_INSPECTION_TIMEOUT,
            MAX_EFFECTIVE_CONFIG_BYTES,
            MAX_SSH_DIAGNOSTIC_BYTES,
        )
        .unwrap();
        assert_eq!(output.status, Some(0));
        assert!(!output.timed_out);
        assert!(!output.stdout_truncated);
        let mut result = empty_effective_configuration(&saved(), None, output.status);
        parse_effective_configuration(&output.stdout, &saved(), &mut result);
        assert_eq!(result.hostname.unwrap().value, "example.invalid");
        assert_eq!(result.user.unwrap().value, "control-room-test");
        assert_eq!(result.port.unwrap().value, "2222");
    }

    #[test]
    fn identifiers_reject_shell_syntax() {
        assert!(validate_systemd_unit_id("nginx.service").is_ok());
        assert!(validate_systemd_unit_id(r"srv-data\x2darchive.mount").is_ok());
        assert!(validate_systemd_unit_id("nginx; reboot.service").is_err());
        assert!(validate_systemd_unit_id(r"broken\xZZ.mount").is_err());
        assert!(validate_systemd_unit_id("multi-user.target").is_err());
        assert!(validate_container_id("npm-plus_1").is_ok());
        assert!(validate_container_id("$(whoami)").is_err());
    }
}
