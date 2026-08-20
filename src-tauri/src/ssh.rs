use std::{env, path::PathBuf};

use regex::Regex;

use crate::models::SavedConnection;

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

pub fn validate_service_name(value: &str) -> Result<&str, String> {
    validate_remote_identifier(value, r"^[A-Za-z0-9@_.:-]+$", "service name")
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
        assert!(validate_service_name("nginx.service").is_ok());
        assert!(validate_service_name("nginx; reboot").is_err());
        assert!(validate_container_id("npm-plus_1").is_ok());
        assert!(validate_container_id("$(whoami)").is_err());
    }
}
