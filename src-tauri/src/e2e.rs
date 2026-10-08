//! Read-only diagnostics and isolated startup for debug desktop tests.
use std::{ffi::OsStr, path::PathBuf};

use serde::Serialize;
use tauri::State;

use crate::{remote::StreamManager, session::SessionManager};

pub fn data_directory() -> Result<PathBuf, String> {
    let root = PathBuf::from(
        std::env::var_os("CONTROL_ROOM_E2E_DATA_DIR")
            .ok_or("CONTROL_ROOM_E2E_DATA_DIR is required for desktop-e2e")?,
    );
    let args: Vec<_> = std::env::args_os().collect();
    let directory = args
        .iter()
        .find_map(|arg| {
            arg.to_str()?
                .strip_prefix("--e2e-data-dir=")
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| root.clone());
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !directory.starts_with(root) {
        return Err("E2E data directory must be inside the runner directory".into());
    }
    Ok(directory)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    app_pid: u32,
    session_ids: Vec<String>,
    stream_ids: Vec<String>,
}

#[tauri::command]
pub fn e2e_runtime_status(
    sessions: State<'_, SessionManager>,
    streams: State<'_, StreamManager>,
) -> RuntimeStatus {
    RuntimeStatus {
        app_pid: std::process::id(),
        session_ids: sessions.e2e_ids(),
        stream_ids: streams.e2e_ids(),
    }
}

pub fn automation_browser_args(arguments: &str) -> Option<String> {
    let port = arguments
        .split_ascii_whitespace()
        .find_map(|argument| argument.strip_prefix("--remote-debugging-port="))?
        .parse::<u16>()
        .ok()?;
    // Preserve Wry's default switches while forwarding only the driver's debugging port.
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
    ))
}

pub fn webview_data_directory(folder: Option<&OsStr>, fallback: PathBuf) -> PathBuf {
    folder
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_passes_only_the_driver_debugging_port_to_webview2() {
        let arguments = automation_browser_args(
            "--disable-web-security --remote-debugging-port=9222 --some-other-flag",
        )
        .unwrap();
        assert!(arguments.contains("--remote-debugging-port=9222"));
        assert!(!arguments.contains("--disable-web-security"));
        assert!(!arguments.contains("--some-other-flag"));
        assert!(automation_browser_args("--remote-debugging-port=0").is_some());
        for invalid in [
            "",
            "--remote-debugging-port=invalid",
            "--remote-debugging-port=65536",
            "--remote-debugging-port=-1",
        ] {
            assert!(automation_browser_args(invalid).is_none());
        }
    }

    #[test]
    fn automation_uses_the_driver_profile_and_rejects_relative_overrides() {
        let fallback = std::env::temp_dir().join("runner-webview");
        let driver_profile = std::env::temp_dir().join("webdriver-profile");
        assert_eq!(
            webview_data_directory(Some(driver_profile.as_os_str()), fallback.clone()),
            driver_profile,
        );
        for folder in [
            None,
            Some(OsStr::new("")),
            Some(OsStr::new("relative-profile")),
        ] {
            assert_eq!(webview_data_directory(folder, fallback.clone()), fallback);
        }
    }
}
