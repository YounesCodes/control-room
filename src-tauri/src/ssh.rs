use std::{
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use regex::Regex;
use wait_timeout::ChildExt;

use crate::models::SavedConnection;

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

pub fn validate_systemd_unit_id(value: &str) -> Result<&str, String> {
    let supported_suffix = [
        ".service",
        ".socket",
        ".target",
        ".device",
        ".mount",
        ".automount",
        ".swap",
        ".path",
        ".timer",
        ".slice",
        ".scope",
    ]
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
    fn identifiers_reject_shell_syntax() {
        assert!(validate_systemd_unit_id("nginx.service").is_ok());
        assert!(validate_systemd_unit_id(r"srv-data\x2darchive.mount").is_ok());
        assert!(validate_systemd_unit_id("nginx; reboot.service").is_err());
        assert!(validate_systemd_unit_id(r"broken\xZZ.mount").is_err());
        assert!(validate_systemd_unit_id("multi-user.target").is_ok());
        assert!(validate_systemd_unit_id("system.slice").is_ok());
        assert!(validate_container_id("npm-plus_1").is_ok());
        assert!(validate_container_id("$(whoami)").is_err());
    }
}
