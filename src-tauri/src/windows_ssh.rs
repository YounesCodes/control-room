use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    models::{HostCapabilities, SavedConnection},
    remote::RemoteCommandExecutor,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteShellProfile {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteShellCatalog {
    pub platform: String,
    pub shells: Vec<RemoteShellProfile>,
    pub windows_terminal_available: bool,
    pub wsl_error: Option<String>,
    pub capabilities: Option<HostCapabilities>,
    pub profile_error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ResolvedShell {
    id: String,
    label: String,
    executable: String,
    arguments: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsHost {
    pub capabilities: HostCapabilities,
    shells: Vec<ResolvedShell>,
    windows_terminal_available: bool,
    wsl_error: Option<String>,
    profile_error: Option<String>,
}

// EncodedCommand uses UTF-16LE. Encoding the complete script avoids passing
// executable paths or distribution names through cmd or the SSH default shell.
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
    Ok(host)
}

pub fn discover(connection: &SavedConnection) -> Result<RemoteShellCatalog, String> {
    // A tiny probe keeps Linux connections on their existing launch path.
    if let Ok(output) =
        RemoteCommandExecutor::execute(connection, "detect_host_platform", "uname -s; uname -r")
        && let Ok(text) = output.success_text()
        && matches!(
            text.lines().next().unwrap_or("").trim(),
            "Linux" | "Darwin" | "FreeBSD" | "OpenBSD" | "NetBSD"
        )
        && !text.to_ascii_lowercase().contains("microsoft")
    {
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
    Ok(RemoteShellCatalog {
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
    })
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
    // Resolve again at launch. The caller supplies only an ID, never a command,
    // and an uninstalled shell fails instead of silently selecting another one.
    let host = discover_windows(connection)?;
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
    let host = discover_windows(connection)?;
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
