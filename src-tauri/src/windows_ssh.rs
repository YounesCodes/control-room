use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::OnceLock,
    time::{Duration, Instant},
};

use crate::{
    models::{HostCapabilities, SavedConnection},
    remote::RemoteCommandExecutor,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteShellProfile {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteShellCatalog {
    #[cfg_attr(test, ts(type = r#""linux" | "windows" | "macos""#))]
    pub platform: String,
    pub shells: Vec<RemoteShellProfile>,
    pub windows_terminal_available: bool,
    pub wsl_error: Option<String>,
    pub capabilities: Option<HostCapabilities>,
    pub profile_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ResolvedShell {
    id: String,
    label: String,
    executable: String,
    arguments: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsHost {
    pub capabilities: HostCapabilities,
    shells: Vec<ResolvedShell>,
    windows_terminal_available: bool,
    wsl_error: Option<String>,
    profile_error: Option<String>,
}

const SHELL_CACHE_TTL: Duration = Duration::from_secs(60);
type ShellCache = Mutex<HashMap<String, (Instant, WindowsHost)>>;
fn shell_cache() -> &'static ShellCache {
    static CACHE: OnceLock<ShellCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn connection_key(connection: &SavedConnection) -> String {
    serde_json::to_string(&(
        &connection.id,
        &connection.destination,
        &connection.username,
        connection.port,
        &connection.identity_file,
    ))
    .expect("connection fields serialize")
}
fn cached_host(connection: &SavedConnection) -> Option<WindowsHost> {
    shell_cache()
        .lock()
        .get(&connection_key(connection))
        .filter(|(time, _)| time.elapsed() < SHELL_CACHE_TTL)
        .map(|(_, host)| host.clone())
}

// -EncodedCommand takes base64 UTF-16LE.
pub fn powershell_command(script: &str) -> String {
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::new();
    for chunk in bytes.chunks(3) {
        let bits = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        encoded.push(alphabet[((bits >> 18) & 63) as usize] as char);
        encoded.push(alphabet[((bits >> 12) & 63) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            alphabet[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            alphabet[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    format!("powershell.exe -NoLogo -NoProfile -EncodedCommand {encoded}")
}

pub fn discover_windows(connection: &SavedConnection) -> Result<WindowsHost, String> {
    let text = RemoteCommandExecutor::execute_with_input(
        connection,
        "discover_windows_shells",
        &powershell_command(
            "$script=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))",
        ),
        include_bytes!("windows_ssh_probe.ps1"),
    )?
    .success_text()?;
    let mut host: WindowsHost = serde_json::from_str(text.trim_start_matches('\u{feff}').trim())
        .map_err(|_| "Windows shell discovery returned an invalid response".to_string())?;
    let mut ids = std::collections::HashSet::new();
    if host.capabilities.os_id.as_deref() != Some("windows")
        || host.shells.len() > 100
        || host.shells.iter().any(|shell| {
            shell.id.is_empty()
                || shell.id.len() > 256
                || shell.label.is_empty()
                || shell.label.len() > 256
                || shell.id.chars().any(char::is_control)
                || shell.label.chars().any(char::is_control)
                || !ids.insert(&shell.id)
                || literal(&shell.executable).is_err()
                || shell
                    .arguments
                    .iter()
                    .any(|argument| literal(argument).is_err())
        })
    {
        return Err("Windows shell discovery returned an invalid host".into());
    }
    host.capabilities.connection_id = connection.id.clone();
    host.capabilities.detected_at = Utc::now().to_rfc3339();
    let mut cache = shell_cache().lock();
    cache.retain(|_, (time, _)| time.elapsed() < SHELL_CACHE_TTL);
    if cache.len() >= 64
        && let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, (time, _))| *time)
            .map(|(key, _)| key.clone())
    {
        cache.remove(&oldest);
    }
    cache.insert(connection_key(connection), (Instant::now(), host.clone()));
    Ok(host)
}

pub fn discover(connection: &SavedConnection, refresh: bool) -> Result<RemoteShellCatalog, String> {
    if !refresh && let Some(host) = cached_host(connection) {
        return Ok(catalog(host));
    }
    if let Ok(output) =
        RemoteCommandExecutor::execute(connection, "detect_host_platform", "uname -s; uname -r")
        && let Ok(text) = output.success_text()
        && matches!(
            text.lines().next().unwrap_or("").trim(),
            "Linux" | "Darwin" | "FreeBSD" | "OpenBSD" | "NetBSD"
        )
        && !text.to_ascii_lowercase().contains("microsoft")
    {
        if text.lines().next().unwrap_or("").trim() == "Darwin" {
            crate::macos_remote::remember(connection, true);
            return crate::macos_remote::shells(connection);
        }
        return Ok(RemoteShellCatalog {
            platform: "linux".into(),
            shells: vec![],
            windows_terminal_available: false,
            wsl_error: None,
            capabilities: None,
            profile_error: None,
        });
    }
    let host = discover_windows(connection)?;
    Ok(catalog(host))
}

fn catalog(host: WindowsHost) -> RemoteShellCatalog {
    RemoteShellCatalog {
        platform: "windows".into(),
        shells: host
            .shells
            .into_iter()
            .map(|shell| RemoteShellProfile {
                id: shell.id,
                label: shell.label,
            })
            .collect(),
        windows_terminal_available: host.windows_terminal_available,
        wsl_error: host.wsl_error,
        capabilities: Some(host.capabilities),
        profile_error: host.profile_error,
    }
}

fn literal(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err("The remote shell contains an invalid path or argument".into());
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

const CONNECTED_MARKER: &str = "\u{1b}]633;ControlRoom;connected\u{7}";
const MISSING_SHELL: &str = "The selected shell is no longer installed";
const SSH_COMMAND_LIMIT: usize = 7500;

fn default_shell_is_cmd(default_shell: Option<&str>) -> bool {
    default_shell
        .and_then(|path| path.rsplit(['\\', '/']).next())
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
}

fn cmd_quoted(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 2048
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '"' | '%' | '!'))
    {
        return None;
    }
    let trailing_backslashes = value.len() - value.trim_end_matches('\\').len();
    Some(format!("\"{value}{}\"", "\\".repeat(trailing_backslashes)))
}

fn cmd_argument(value: &str) -> Option<String> {
    let plain = !value.is_empty()
        && value.len() <= 2048
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | '/' | ':' | '\\' | '+' | '@')
        });
    if plain {
        Some(value.into())
    } else {
        cmd_quoted(value)
    }
}

fn cmd_launch(shell: &ResolvedShell) -> Option<String> {
    let executable = cmd_quoted(&shell.executable)?;
    let mut program = vec![executable.clone()];
    for argument in &shell.arguments {
        program.push(cmd_argument(argument)?);
    }
    let git_environment = if shell.id == "git-bash" {
        "set \"MSYSTEM=MINGW64\" & "
    } else {
        ""
    };
    Some(format!(
        "if exist {executable} (<nul set /p \"={CONNECTED_MARKER}\" & {git_environment}{}) else (>&2 echo {MISSING_SHELL}& exit 1)",
        program.join(" ")
    ))
}

fn powershell_launch(shell: &ResolvedShell) -> Result<String, String> {
    let executable = literal(&shell.executable)?;
    let arguments = shell
        .arguments
        .iter()
        .map(|arg| literal(arg))
        .collect::<Result<Vec<_>, _>>()?
        .join(",");
    let git_environment = if shell.id == "git-bash" {
        "$env:MSYSTEM='MINGW64'; "
    } else {
        ""
    };
    Ok(powershell_command(&format!(
        "$ErrorActionPreference='Stop'; {git_environment}$exe={executable}; if (!(Test-Path -LiteralPath $exe -PathType Leaf)) {{ throw '{MISSING_SHELL}' }}; $arguments=@({arguments}); [Console]::Write([char]27 + ']633;ControlRoom;connected' + [char]7); & $exe @arguments; exit $LASTEXITCODE"
    )))
}

fn launch(shell: &ResolvedShell, default_shell: Option<&str>) -> Result<String, String> {
    let direct = default_shell_is_cmd(default_shell)
        .then(|| cmd_launch(shell))
        .flatten();
    let command = match direct {
        Some(command) => command,
        None => powershell_launch(shell)?,
    };
    if command.len() > SSH_COMMAND_LIMIT {
        return Err(
            "The selected shell command exceeds the Windows SSH command length limit".into(),
        );
    }
    Ok(command)
}

pub fn selected_command(connection: &SavedConnection, shell_id: &str) -> Result<String, String> {
    let host = match cached_host(connection) {
        Some(host) => host,
        None => discover_windows(connection)?,
    };
    let shell = host
        .shells
        .iter()
        .find(|shell| shell.id == shell_id)
        .ok_or_else(|| {
            "The selected remote shell is no longer available. Choose a shell again.".to_string()
        })?;
    launch(shell, host.capabilities.default_shell.as_deref())
}

pub fn default_command(connection: &SavedConnection) -> Result<String, String> {
    let host = match cached_host(connection) {
        Some(host) => host,
        None => discover_windows(connection)?,
    };
    let shell = host
        .shells
        .iter()
        .find(|shell| Some(&shell.executable) == host.capabilities.default_shell.as_ref())
        .or_else(|| host.shells.first())
        .ok_or_else(|| "No remote Windows shells were detected".to_string())?;
    launch(shell, host.capabilities.default_shell.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_shells_are_bound_to_target_and_expire() {
        let mut connection = SavedConnection {
            id: "cache-boundary".into(),
            display_name: "Fixture".into(),
            destination: "host.example".into(),
            username: Some("fixture".into()),
            port: Some(22),
            identity_file: None,
            history_enabled: false,
            sudo_enabled: false,
            group_id: None,
            tags: vec![],
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        };
        let host: WindowsHost = serde_json::from_value(serde_json::json!({ "capabilities": { "osId": "windows" }, "shells": [{"id": "cmd", "label": "Command Prompt", "executable": "C:\\Windows\\cmd.exe", "arguments": []}], "windowsTerminalAvailable": false, "wslError": null, "profileError": null })).unwrap();
        let key = connection_key(&connection);
        shell_cache()
            .lock()
            .insert(key.clone(), (Instant::now(), host.clone()));
        assert!(cached_host(&connection).is_some());
        connection.destination = "different.example".into();
        assert!(cached_host(&connection).is_none());
        connection.destination = "host.example".into();
        connection.username = Some("different-account".into());
        assert!(cached_host(&connection).is_none());
        connection.username = Some("fixture".into());
        shell_cache()
            .lock()
            .insert(key.clone(), (Instant::now() - SHELL_CACHE_TTL, host));
        assert!(cached_host(&connection).is_none());
        shell_cache().lock().remove(&key);
    }

    #[test]
    #[ignore = "requires a configured Windows SSH host"]
    fn fresh_shell_selection_avoids_a_second_discovery_round_trip() {
        let connection = SavedConnection {
            id: "windows-selection-performance".into(),
            display_name: "Windows fixture".into(),
            destination: std::env::var("CONTROL_ROOM_WINDOWS_TEST_HOST")
                .expect("Windows fixture host"),
            username: Some(
                std::env::var("CONTROL_ROOM_WINDOWS_TEST_USER").expect("Windows fixture user"),
            ),
            port: None,
            identity_file: None,
            history_enabled: false,
            sudo_enabled: false,
            group_id: None,
            tags: vec![],
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        };
        discover_windows(&connection).unwrap();
        let started = std::time::Instant::now();
        selected_command(&connection, "powershell").unwrap();
        let elapsed = started.elapsed();
        eprintln!(
            "Fresh shell selection preparation: {} ms",
            elapsed.as_millis()
        );
        assert!(
            elapsed < std::time::Duration::from_millis(250),
            "Freshly detected shell selection repeats a slow discovery call: {elapsed:?}"
        );
    }

    #[test]
    fn encoded_command_uses_utf16_and_does_not_expose_shell_metacharacters() {
        assert_eq!(
            powershell_command("A"),
            "powershell.exe -NoLogo -NoProfile -EncodedCommand QQA="
        );
        assert_eq!(
            literal("Ubuntu's $(touch x); & whoami").unwrap(),
            "'Ubuntu''s $(touch x); & whoami'"
        );
        let hostile = shell(
            "wsl:x",
            r"C:\Windows\System32\wsl.exe",
            &["--distribution", "Ubuntu's $(touch x); & whoami"],
        );
        let command = launch(&hostile, Some(POWERSHELL)).unwrap();
        assert!(!command.contains("touch"));
        assert!(!command.contains('&'));
        assert!(
            launch(&hostile, Some(CMD))
                .unwrap()
                .contains(r#"--distribution "Ubuntu's $(touch x); & whoami")"#)
        );
        assert!(literal("line\ncommand").is_err());
        assert!(literal("").is_err());
    }

    #[test]
    fn oversized_profile_commands_fail_before_starting_ssh() {
        let large = vec!["a".repeat(2000); 4];
        let arguments: Vec<_> = large.iter().map(String::as_str).collect();
        for default_shell in [Some(POWERSHELL), Some(CMD)] {
            assert!(
                launch(
                    &shell("terminal:large", r"C:\shell.exe", &arguments),
                    default_shell
                )
                .unwrap_err()
                .contains("length limit")
            );
        }
    }

    const CMD: &str = r"C:\Windows\System32\cmd.exe";
    const POWERSHELL: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

    fn shell(id: &str, executable: &str, arguments: &[&str]) -> ResolvedShell {
        ResolvedShell {
            id: id.into(),
            label: id.into(),
            executable: executable.into(),
            arguments: arguments
                .iter()
                .map(|argument| (*argument).into())
                .collect(),
        }
    }

    fn direct(executable: &str, program: &str) -> String {
        format!(
            "if exist \"{executable}\" (<nul set /p \"=\u{1b}]633;ControlRoom;connected\u{7}\" & {program}) else (>&2 echo The selected shell is no longer installed& exit 1)"
        )
    }

    #[test]
    fn cmd_default_shell_starts_each_detected_shell_without_a_wrapper() {
        let pwsh = r"C:\Program Files\PowerShell\7\pwsh.exe";
        let bash = r"C:\Program Files\Git\bin\bash.exe";
        let wsl = r"C:\Windows\System32\wsl.exe";
        let cases = [
            (
                shell("powershell", POWERSHELL, &["-NoLogo"]),
                direct(POWERSHELL, &format!("\"{POWERSHELL}\" -NoLogo")),
            ),
            (
                shell("powershell-7", pwsh, &["-NoLogo"]),
                direct(pwsh, &format!("\"{pwsh}\" -NoLogo")),
            ),
            (
                shell("cmd", CMD, &["/Q"]),
                direct(CMD, &format!("\"{CMD}\" /Q")),
            ),
            (
                shell("git-bash", bash, &["--login", "-i"]),
                direct(
                    bash,
                    &format!("set \"MSYSTEM=MINGW64\" & \"{bash}\" --login -i"),
                ),
            ),
            (
                shell("wsl:Ubuntu 24.04", wsl, &["--distribution", "Ubuntu 24.04"]),
                direct(wsl, &format!("\"{wsl}\" --distribution \"Ubuntu 24.04\"")),
            ),
            (
                shell("ssh-default", CMD, &[]),
                direct(CMD, &format!("\"{CMD}\"")),
            ),
        ];
        for (resolved, expected) in cases {
            assert_eq!(launch(&resolved, Some(CMD)).unwrap(), expected);
            assert_eq!(
                launch(&resolved, Some("C:/WINDOWS/system32/CMD.EXE")).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn cmd_arguments_are_quoted_for_the_target_program() {
        assert_eq!(
            launch(
                &shell(
                    "terminal:x",
                    r"C:\Tools\x.exe",
                    &[r"C:\My Dir\", "a&b|c", "(x)"]
                ),
                Some(CMD),
            )
            .unwrap(),
            direct(
                r"C:\Tools\x.exe",
                r#""C:\Tools\x.exe" "C:\My Dir\\" "a&b|c" "(x)""#,
            )
        );
    }

    #[test]
    fn values_cmd_cannot_quote_keep_the_powershell_wrapper() {
        for (executable, arguments) in [
            (r"C:\100%\shell.exe", vec![]),
            (r"C:\Tools\x.exe", vec!["%PATH%"]),
            (r"C:\Tools\x.exe", vec!["say \"hi\""]),
            (r"C:\Tools\x.exe", vec!["wow!"]),
        ] {
            let command = launch(&shell("terminal:x", executable, &arguments), Some(CMD)).unwrap();
            assert!(command.starts_with("powershell.exe -NoLogo -NoProfile -EncodedCommand "));
        }
    }

    #[test]
    fn non_cmd_default_shells_keep_the_powershell_wrapper() {
        let resolved = shell("powershell", POWERSHELL, &["-NoLogo"]);
        for default_shell in [
            None,
            Some(POWERSHELL),
            Some(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            Some(r"C:\Program Files\Git\bin\bash.exe"),
            Some(r"C:\Tools\notcmd.exe"),
        ] {
            assert_eq!(
                launch(&resolved, default_shell).unwrap(),
                powershell_launch(&resolved).unwrap()
            );
        }
    }
}
