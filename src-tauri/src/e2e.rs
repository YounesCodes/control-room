//! Read-only diagnostics and isolated startup for debug desktop tests.
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
