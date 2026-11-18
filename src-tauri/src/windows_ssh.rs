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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ResolvedShell {
    id: String,
    label: String,
    executable: String,
    arguments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    validate_host(&host)?;
    host.capabilities.connection_id = connection.id.clone();
    host.capabilities.detected_at = Utc::now().to_rfc3339();
    remember(connection, &host);
    Ok(host)
}

fn validate_host(host: &WindowsHost) -> Result<(), String> {
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
    Ok(())
}

fn remember(connection: &SavedConnection, host: &WindowsHost) {
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
}

/// The form a discovered Windows host is saved in, read back by [`restore`].
pub fn stored_form(host: &WindowsHost) -> String {
    serde_json::to_string(host).expect("a Windows host serializes")
}

/// Makes a saved Windows host the current one for `connection`, unless a
/// fresher discovery is already known. A saved host that no longer passes
/// validation is ignored, so the caller falls back to discovering it again.
pub fn restore(connection: &SavedConnection, stored: &str) -> Option<WindowsHost> {
    if let Some(host) = cached_host(connection) {
        return Some(host);
    }
    let mut host: WindowsHost = serde_json::from_str(stored).ok()?;
    validate_host(&host).ok()?;
    host.capabilities.connection_id = connection.id.clone();
    remember(connection, &host);
    Some(host)
}

pub struct Discovery {
    pub catalog: RemoteShellCatalog,
    /// A Windows host that was just read from the remote machine and should be saved.
    pub discovered: Option<WindowsHost>,
    /// The catalog came from storage and should be refreshed in the background.
    pub from_storage: bool,
}

impl Discovery {
    fn known(catalog: RemoteShellCatalog) -> Self {
        Self {
            catalog,
            discovered: None,
            from_storage: false,
        }
    }

    fn discovered(host: WindowsHost) -> Self {
        Self {
            catalog: catalog(host.clone()),
            discovered: Some(host),
            from_storage: false,
        }
    }
}

pub fn discover(
    connection: &SavedConnection,
    refresh: bool,
    saved_os_id: Option<&str>,
    stored: Option<&str>,
) -> Result<Discovery, String> {
    if !refresh && let Some(host) = cached_host(connection) {
        return Ok(Discovery::known(catalog(host)));
    }
    if saved_os_id == Some("windows") {
        if !refresh && let Some(host) = stored.and_then(|stored| restore(connection, stored)) {
            return Ok(Discovery {
                catalog: catalog(host),
                discovered: None,
                from_storage: true,
            });
        }
        return discover_windows(connection).map(Discovery::discovered);
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
            return crate::macos_remote::shells(connection).map(Discovery::known);
        }
        return Ok(Discovery::known(RemoteShellCatalog {
            platform: "linux".into(),
            shells: vec![],
            windows_terminal_available: false,
            wsl_error: None,
            capabilities: None,
            profile_error: None,
        }));
    }
    discover_windows(connection).map(Discovery::discovered)
}

static BACKGROUND_REFRESHES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Held while one background shell refresh runs for a connection, so a second
/// dialog opening does not start a second probe of the same host.
pub struct BackgroundRefresh(String);

impl BackgroundRefresh {
    pub fn claim(connection: &SavedConnection) -> Option<Self> {
        let key = connection_key(connection);
        let mut running = BACKGROUND_REFRESHES.lock();
        if running.contains(&key) {
            return None;
        }
        running.push(key.clone());
        Some(Self(key))
    }
}

impl Drop for BackgroundRefresh {
    fn drop(&mut self) {
        BACKGROUND_REFRESHES.lock().retain(|key| key != &self.0);
    }
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

fn launch(shell: &ResolvedShell) -> Result<String, String> {
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
    let command = powershell_command(&format!(
        "$ErrorActionPreference='Stop'; {git_environment}$exe={executable}; if (!(Test-Path -LiteralPath $exe -PathType Leaf)) {{ throw 'The selected shell is no longer installed' }}; $arguments=@({arguments}); [Console]::Write([char]27 + ']633;ControlRoom;connected' + [char]7); & $exe @arguments; exit $LASTEXITCODE"
    ));
    if command.len() > 7500 {
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
    launch(shell)
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
    launch(shell)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unreachable(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            display_name: "Fixture".into(),
            destination: "control-room-unreachable.invalid".into(),
            username: Some("fixture".into()),
            port: Some(1),
            identity_file: None,
            history_enabled: false,
            sudo_enabled: false,
            group_id: None,
            tags: vec![],
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        }
    }

    fn saved_host(label: &str) -> WindowsHost {
        serde_json::from_value(serde_json::json!({
            "capabilities": { "connectionId": "elsewhere", "osId": "windows", "defaultShell": "C:\\Windows\\cmd.exe" },
            "shells": [
                { "id": "cmd", "label": label, "executable": "C:\\Windows\\cmd.exe", "arguments": [] },
                { "id": "wsl:Ubuntu", "label": "WSL: Ubuntu", "executable": "C:\\Windows\\System32\\wsl.exe", "arguments": ["--distribution", "Ubuntu"] }
            ],
            "windowsTerminalAvailable": true,
            "wslError": null,
            "profileError": null
        }))
        .unwrap()
    }

    #[test]
    fn a_saved_windows_catalog_is_shown_without_contacting_the_host() {
        let connection = unreachable("stored-catalog");
        let stored = stored_form(&saved_host("Command Prompt"));
        let started = Instant::now();
        let discovery = discover(&connection, false, Some("windows"), Some(&stored)).unwrap();
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(discovery.from_storage);
        assert!(discovery.discovered.is_none());
        assert_eq!(discovery.catalog.platform, "windows");
        assert!(discovery.catalog.windows_terminal_available);
        assert_eq!(
            discovery
                .catalog
                .shells
                .iter()
                .map(|shell| shell.id.as_str())
                .collect::<Vec<_>>(),
            ["cmd", "wsl:Ubuntu"]
        );
        assert_eq!(
            discovery.catalog.capabilities.unwrap().connection_id,
            "stored-catalog"
        );
        shell_cache().lock().remove(&connection_key(&connection));
    }

    #[test]
    fn a_restored_catalog_launches_its_saved_shells_without_a_second_probe() {
        let connection = unreachable("restored-launch");
        restore(&connection, &stored_form(&saved_host("Command Prompt"))).unwrap();
        let started = Instant::now();
        assert!(selected_command(&connection, "wsl:Ubuntu").is_ok());
        assert!(default_command(&connection).is_ok());
        assert!(started.elapsed() < Duration::from_millis(250));
        shell_cache().lock().remove(&connection_key(&connection));
    }

    #[test]
    fn a_saved_catalog_that_fails_validation_is_not_trusted() {
        let connection = unreachable("invalid-stored-catalog");
        let mut linux = saved_host("Command Prompt");
        linux.capabilities.os_id = Some("ubuntu".into());
        for stored in [
            "not json".to_string(),
            stored_form(&saved_host("Command\nPrompt")),
            stored_form(&linux),
        ] {
            assert!(restore(&connection, &stored).is_none(), "{stored}");
        }
        assert!(cached_host(&connection).is_none());
    }

    #[test]
    fn a_fresher_discovery_outranks_the_saved_catalog() {
        let connection = unreachable("fresher-than-stored");
        remember(&connection, &saved_host("Fresh"));
        let restored = restore(&connection, &stored_form(&saved_host("Saved"))).unwrap();
        assert_eq!(restored.shells[0].label, "Fresh");
        shell_cache().lock().remove(&connection_key(&connection));
    }

    #[test]
    fn one_background_refresh_runs_per_host_at_a_time() {
        let connection = unreachable("background-refresh");
        let claim = BackgroundRefresh::claim(&connection).unwrap();
        assert!(BackgroundRefresh::claim(&connection).is_none());
        assert!(BackgroundRefresh::claim(&unreachable("another-host")).is_some());
        drop(claim);
        assert!(BackgroundRefresh::claim(&connection).is_some());
    }

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
        let command = launch(&ResolvedShell {
            id: "wsl:x".into(),
            label: "WSL".into(),
            executable: r"C:\Windows\System32\wsl.exe".into(),
            arguments: vec![
                "--distribution".into(),
                "Ubuntu's $(touch x); & whoami".into(),
            ],
        })
        .unwrap();
        assert!(!command.contains("touch"));
        assert!(!command.contains('&'));
        assert!(literal("line\ncommand").is_err());
        assert!(literal("").is_err());
    }

    #[test]
    fn oversized_profile_commands_fail_before_starting_ssh() {
        let shell = ResolvedShell {
            id: "terminal:large".into(),
            label: "Large".into(),
            executable: r"C:\shell.exe".into(),
            arguments: vec!["a".repeat(2000); 4],
        };
        assert!(launch(&shell).unwrap_err().contains("length limit"));
    }
}
