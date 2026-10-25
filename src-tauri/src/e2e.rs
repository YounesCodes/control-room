//! Read-only diagnostics and isolated startup for debug desktop tests.
#[cfg(any(windows, test))]
use std::ffi::OsStr;
use std::path::PathBuf;

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

#[cfg(target_os = "macos")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowButtonBounds {
    name: &'static str,
    left: f64,
    center_y: f64,
    width: f64,
    height: f64,
}

/// Measure the real AppKit controls in the same logical coordinates as the
/// overlay webview. DOM-only layout checks cannot detect native-button drift.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn e2e_window_buttons(window: tauri::Window) -> Result<Vec<WindowButtonBounds>, String> {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let _main_thread = objc2::MainThreadMarker::new().ok_or("AppKit requires the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri owns this live NSWindow; this synchronous command is on the
    // main thread, and the reference does not outlive the command's Window.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let content = native.contentView().ok_or("Missing native content view")?;
    let content_bounds = content.bounds();
    [
        ("close", NSWindowButton::CloseButton),
        ("minimize", NSWindowButton::MiniaturizeButton),
        ("fullscreen", NSWindowButton::ZoomButton),
    ]
    .into_iter()
    .map(|(name, kind)| {
        let button = native
            .standardWindowButton(kind)
            .ok_or("Missing native button")?;
        let bounds = button.convertRect_toView(button.bounds(), Some(&content));
        let middle = bounds.origin.y + bounds.size.height / 2.0;
        Ok(WindowButtonBounds {
            name,
            left: bounds.origin.x - content_bounds.origin.x,
            center_y: if content.isFlipped() {
                middle - content_bounds.origin.y
            } else {
                content_bounds.origin.y + content_bounds.size.height - middle
            },
            width: bounds.size.width,
            height: bounds.size.height,
        })
    })
    .collect()
}

#[cfg(any(windows, test))]
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

#[cfg(any(windows, test))]
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
