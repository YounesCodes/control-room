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
    // Accept every canonical systemd unit type. `systemd-analyze blame` and
    // `journalctl -u` legitimately reference `.device`, `.swap`, `.target`,
    // `.scope`, etc.; the character-class check below is what guards against
    // injection, not the suffix set.
    let supported_suffix = [
        ".service",
        ".socket",
        ".device",
        ".mount",
        ".automount",
        ".swap",
        ".target",
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
            sudo_enabled: false,
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

    /// A Structured Operation must not inherit the interactive session's
    /// settings. It runs unattended, so it asks for no tty, refuses to prompt,
    /// and gives up rather than hanging on an unreachable host.
    #[test]
    fn a_noninteractive_connection_never_waits_for_a_prompt() {
        let arguments = connection_arguments(&saved(), false);
        assert_eq!(
            arguments,
            vec![
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "laptop"
            ]
        );
        assert!(
            !arguments.iter().any(|argument| argument == "-tt"),
            "a background read must not allocate a tty"
        );
    }

    /// The one invariant that matters in here: nothing the user types into the
    /// connection editor may reach ssh as an option.
    ///
    /// Two things enforce it together, so they are checked together. Username
    /// and identity file are the arguments of flags this builder chose, and
    /// getopt consumes those whatever they look like. The destination is the
    /// only positional, so it is the only field ssh would read as an option,
    /// and validation is what stops one that starts with a hyphen from ever
    /// being stored.
    ///
    /// Each value is therefore required to be either refused outright or laid
    /// out safely. Neither half can be dropped without failing this.
    ///
    /// "Safely" is getopt's own rule rather than "contains no hyphen": a flag
    /// that takes an argument consumes the next argv entry whatever it looks
    /// like, so `-l -F` sets the login name to `-F` and does not read a second
    /// option. What must never happen is a value landing where getopt is
    /// looking for an option, or in the positional slot ssh reads as the
    /// destination.
    #[test]
    fn no_storable_connection_field_reaches_ssh_as_an_option() {
        // Options the builder emits, and which of them consume the next entry.
        const FLAGS: [&str; 6] = ["-tt", "-T", "-o", "-l", "-p", "-i"];
        const TAKES_A_VALUE: [&str; 4] = ["-o", "-l", "-p", "-i"];

        let hostile = [
            "-oProxyCommand=calc.exe",
            "-o",
            "-F",
            "--",
            "-",
            "; id",
            "$(id)",
            "`id`",
            "a b",
            "a\tb",
            "a\nb",
            "a\rb",
            "a|b",
            "&& reboot",
            "*",
            "?",
            "$HOME",
            "'",
            "\"",
            "../../etc/hosts",
        ];

        for value in hostile {
            for field in ["destination", "username"] {
                let mut input = valid_input("laptop", "root");
                let mut connection = saved();
                match field {
                    "destination" => {
                        input.destination = value.into();
                        connection.destination = value.into();
                    }
                    _ => {
                        input.username = Some(value.into());
                        connection.username = Some(value.into());
                    }
                }

                if crate::database::validate_connection_input(&input).is_err() {
                    continue;
                }

                for terminal in [true, false] {
                    let arguments = connection_arguments(&connection, terminal);
                    let mut expects_a_value = false;
                    for argument in &arguments {
                        if !expects_a_value && argument.starts_with('-') {
                            assert!(
                                FLAGS.contains(&argument.as_str()),
                                "a storable {field} {value:?} became the option {argument:?} in {arguments:?}"
                            );
                        }
                        expects_a_value =
                            !expects_a_value && TAKES_A_VALUE.contains(&argument.as_str());
                    }

                    // ssh reads the first entry that is not an option, or an
                    // option's value, as the destination.
                    assert_eq!(
                        arguments.last().map(String::as_str),
                        Some(connection.destination.as_str()),
                        "the destination is the only positional"
                    );
                    assert!(
                        !connection.destination.starts_with('-'),
                        "a positional starting with a hyphen is read as an option"
                    );
                    assert!(
                        arguments.iter().any(|argument| argument == value),
                        "the value has to survive intact as its own argv entry"
                    );
                }
            }
        }
    }

    /// Windows key paths hold spaces and non-ASCII characters routinely. The
    /// path is one argv entry, so neither needs quoting and neither may split
    /// it: a path that arrived as two arguments would make ssh read the tail as
    /// the destination.
    #[test]
    fn an_identity_path_with_spaces_stays_a_single_argument() {
        for path in [
            r"C:\Users\Ana María\.ssh\id ed25519",
            r"C:\keys\-leading-hyphen",
            r"C:\keys\ключ",
            r"C:\keys\key with 'quotes' and spaces",
        ] {
            let mut connection = saved();
            connection.identity_file = Some(path.into());
            let arguments = connection_arguments(&connection, true);

            assert_eq!(arguments, vec!["-tt", "-i", path, "laptop"]);
            assert_eq!(
                arguments
                    .iter()
                    .filter(|argument| *argument == path)
                    .count(),
                1,
                "the path is one entry, not split on its spaces"
            );
        }
    }

    /// Which of those the editor refuses, so the destination never reaches the
    /// argv position where a leading hyphen would be read as an option.
    #[test]
    fn destinations_that_ssh_would_read_as_options_are_refused() {
        for rejected in [
            "-oProxyCommand=calc.exe",
            "--",
            "-F",
            "-",
            "host name",
            "host\tname",
            "host\nname",
            "host\rname",
            "host\u{0}name",
            "",
            "   ",
        ] {
            assert!(
                connection_input(rejected, "root").is_err(),
                "{rejected:?} must not be storable as a destination"
            );
        }

        // Strange but legitimate destinations still work. Rejecting these would
        // make the validator the problem instead of the guard.
        for accepted in [
            "laptop",
            "192.168.1.10",
            "2001:db8::1",
            "::1",
            "build-server.internal.example.com",
            "my-ssh-config-alias",
            "root@jump.example.com",
            "host-with-trailing-hyphen-",
            "xn--bcher-kva.example.com",
        ] {
            assert!(
                connection_input(accepted, "root").is_ok(),
                "{accepted:?} is a destination OpenSSH accepts"
            );
        }
    }

    /// The username lands after `-l`, so getopt consumes it whatever it holds.
    /// It is still restricted, because a username is a POSIX account name and a
    /// value that could not name one is a typo worth catching at save time.
    #[test]
    fn usernames_are_account_names_and_nothing_else() {
        for accepted in ["root", "deploy", "web.admin", "svc_backup", "user-1", "u"] {
            assert!(
                connection_input("laptop", accepted).is_ok(),
                "{accepted:?} is an ordinary account name"
            );
        }
        for rejected in [
            "-oProxyCommand=calc.exe",
            "root user",
            "root;id",
            "root$(id)",
            "root\nid",
            "root\rid",
            "root@host",
            "rööt",
            "",
            "  ",
        ] {
            assert!(
                connection_input("laptop", rejected).is_err(),
                "{rejected:?} is not an account name"
            );
        }
    }

    /// Port zero is representable in a `u16` and means nothing to ssh, so it is
    /// the one port value validation has to refuse. The rest of the range is
    /// bounded by the type.
    #[test]
    fn only_the_unusable_port_is_refused() {
        for (port, valid) in [(Some(0), false), (Some(1), true), (Some(65_535), true)] {
            let mut input = valid_input("laptop", "root");
            input.port = port;
            assert_eq!(
                crate::database::validate_connection_input(&input).is_ok(),
                valid,
                "port {port:?}"
            );
        }

        let mut connection = saved();
        connection.port = Some(65_535);
        assert_eq!(
            connection_arguments(&connection, true),
            vec!["-tt", "-p", "65535", "laptop"]
        );
    }

    fn valid_input(destination: &str, username: &str) -> crate::models::SavedConnectionInput {
        crate::models::SavedConnectionInput {
            display_name: "Laptop".into(),
            destination: destination.into(),
            username: Some(username.into()),
            port: None,
            identity_file: None,
            history_enabled: false,
            sudo_enabled: false,
            group_id: None,
            tag_names: Vec::new(),
        }
    }

    fn connection_input(destination: &str, username: &str) -> Result<(), String> {
        crate::database::validate_connection_input(&valid_input(destination, username))
    }

    #[test]
    fn identifiers_reject_shell_syntax() {
        assert!(validate_systemd_unit_id("nginx.service").is_ok());
        assert!(validate_systemd_unit_id(r"srv-data\x2darchive.mount").is_ok());
        // Every canonical systemd unit type is a valid identifier; these appear
        // in `systemd-analyze blame` and are addressable by `journalctl -u`.
        assert!(validate_systemd_unit_id("multi-user.target").is_ok());
        assert!(validate_systemd_unit_id("dev-sda1.device").is_ok());
        assert!(validate_systemd_unit_id("swapfile.swap").is_ok());
        assert!(validate_systemd_unit_id("user@1000.service").is_ok());
        assert!(validate_systemd_unit_id("nginx; reboot.service").is_err());
        assert!(validate_systemd_unit_id(r"broken\xZZ.mount").is_err());
        assert!(validate_systemd_unit_id("plain-name").is_err());
        assert!(validate_systemd_unit_id("bogus.unknown").is_err());
        assert!(validate_container_id("npm-plus_1").is_ok());
        assert!(validate_container_id("$(whoami)").is_err());
    }
}
