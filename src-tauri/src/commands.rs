use tauri::{AppHandle, State, ipc::Channel, ipc::Response};

use crate::{
    database::Database,
    history,
    models::{
        AppSettings, DockerContainer, EnvironmentInfo, HistoryEntry, HistoryInput,
        HostCapabilities, SavedConnection, SavedConnectionInput, SessionStarted, StreamStarted,
        SystemdService,
    },
    remote::{self, LogStreamOptions, StreamManager},
    session::SessionManager,
    ssh::{background_command, detect_ssh_path, ssh_config_path},
};

#[tauri::command]
pub fn get_environment_info() -> EnvironmentInfo {
    let agent_available = background_command("ssh-add")
        .arg("-l")
        .output()
        .is_ok_and(|output| output.status.success());
    EnvironmentInfo {
        ssh_path: detect_ssh_path().map(|path| path.to_string_lossy().to_string()),
        ssh_config_path: ssh_config_path(),
        ssh_agent_available: agent_available,
        platform_supported: cfg!(all(windows, target_arch = "x86_64")),
    }
}

#[tauri::command]
pub fn list_connections(database: State<'_, Database>) -> Result<Vec<SavedConnection>, String> {
    database.list_connections()
}

#[tauri::command]
pub fn create_connection(
    database: State<'_, Database>,
    input: SavedConnectionInput,
) -> Result<SavedConnection, String> {
    database.create_connection(input)
}

#[tauri::command]
pub fn update_connection(
    database: State<'_, Database>,
    id: String,
    input: SavedConnectionInput,
) -> Result<SavedConnection, String> {
    database.update_connection(&id, input)
}

#[tauri::command]
pub fn delete_connection(database: State<'_, Database>, id: String) -> Result<(), String> {
    database.delete_connection(&id)
}

#[tauri::command]
pub fn start_session(
    app: AppHandle,
    database: State<'_, Database>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    cols: u16,
    rows: u16,
    output: Channel<Response>,
) -> Result<SessionStarted, String> {
    let connection = database.get_connection(&connection_id)?;
    let started = sessions.start(app, &connection, cols, rows, output)?;
    database.mark_connected(&connection_id)?;
    Ok(started)
}

#[tauri::command]
pub fn write_session(
    sessions: State<'_, SessionManager>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    sessions.write(&session_id, &data)
}

#[tauri::command]
pub fn resize_session(
    sessions: State<'_, SessionManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    sessions.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn close_session(
    sessions: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    sessions.close(&session_id)
}

#[tauri::command]
pub fn get_cached_capabilities(
    database: State<'_, Database>,
    connection_id: String,
) -> Result<Option<HostCapabilities>, String> {
    database.get_capabilities(&connection_id)
}

#[tauri::command]
pub fn refresh_capabilities(
    database: State<'_, Database>,
    connection_id: String,
) -> Result<HostCapabilities, String> {
    let connection = database.get_connection(&connection_id)?;
    let capabilities = remote::discover_capabilities(&connection)?;
    database.save_capabilities(&capabilities)?;
    Ok(capabilities)
}

#[tauri::command]
pub fn list_services(
    database: State<'_, Database>,
    connection_id: String,
) -> Result<Vec<SystemdService>, String> {
    let connection = database.get_connection(&connection_id)?;
    remote::list_services(&connection)
}

#[tauri::command]
pub fn get_service(
    database: State<'_, Database>,
    connection_id: String,
    service_name: String,
) -> Result<SystemdService, String> {
    let connection = database.get_connection(&connection_id)?;
    remote::get_service(&connection, &service_name)
}

#[tauri::command]
pub fn list_containers(
    database: State<'_, Database>,
    connection_id: String,
    sudo_password: Option<String>,
) -> Result<Vec<DockerContainer>, String> {
    let connection = database.get_connection(&connection_id)?;
    remote::list_containers(&connection, sudo_password)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_journal_stream(
    app: AppHandle,
    database: State<'_, Database>,
    streams: State<'_, StreamManager>,
    connection_id: String,
    service: String,
    lines: u16,
    follow: bool,
    sudo_password: Option<String>,
    output: Channel<Response>,
) -> Result<StreamStarted, String> {
    let connection = database.get_connection(&connection_id)?;
    streams.start_journal(
        app,
        &connection,
        &service,
        LogStreamOptions {
            lines,
            follow,
            sudo_password,
            output,
        },
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_docker_log_stream(
    app: AppHandle,
    database: State<'_, Database>,
    streams: State<'_, StreamManager>,
    connection_id: String,
    container: String,
    lines: u16,
    follow: bool,
    sudo_password: Option<String>,
    output: Channel<Response>,
) -> Result<StreamStarted, String> {
    let connection = database.get_connection(&connection_id)?;
    streams.start_docker_logs(
        app,
        &connection,
        &container,
        LogStreamOptions {
            lines,
            follow,
            sudo_password,
            output,
        },
    )
}

#[tauri::command]
pub fn stop_log_stream(streams: State<'_, StreamManager>, stream_id: String) -> Result<(), String> {
    streams.stop(&stream_id)
}

#[tauri::command]
pub fn get_history(
    database: State<'_, Database>,
    connection_id: String,
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    database.list_history(&connection_id, search.as_deref(), limit.unwrap_or(500))
}

#[tauri::command]
pub fn add_history_entry(
    database: State<'_, Database>,
    input: HistoryInput,
) -> Result<HistoryEntry, String> {
    let settings = database.get_settings()?;
    let connection = database.get_connection(&input.connection_id)?;
    if !settings.global_history_enabled || !connection.history_enabled {
        return Err("Enhanced History is paused or disabled".into());
    }
    database.add_history(input)
}

#[tauri::command]
pub fn delete_history_entry(database: State<'_, Database>, id: String) -> Result<(), String> {
    database.delete_history(&id)
}

#[tauri::command]
pub fn clear_history(database: State<'_, Database>, connection_id: String) -> Result<(), String> {
    database.clear_history(&connection_id)
}

#[tauri::command]
pub fn get_settings(database: State<'_, Database>) -> Result<AppSettings, String> {
    database.get_settings()
}

#[tauri::command]
pub fn save_settings(database: State<'_, Database>, settings: AppSettings) -> Result<(), String> {
    database.save_settings(&settings)
}

#[tauri::command]
pub fn get_history_integration_status(
    database: State<'_, Database>,
    connection_id: String,
) -> Result<bool, String> {
    let connection = database.get_connection(&connection_id)?;
    history::integration_status(&connection)
}

#[tauri::command]
pub fn install_history_integration(
    database: State<'_, Database>,
    connection_id: String,
) -> Result<(), String> {
    let connection = database.get_connection(&connection_id)?;
    history::install_integration(&connection)?;
    database.set_history_enabled(&connection_id, true)
}

#[tauri::command]
pub fn uninstall_history_integration(
    database: State<'_, Database>,
    connection_id: String,
) -> Result<(), String> {
    let connection = database.get_connection(&connection_id)?;
    history::uninstall_integration(&connection)?;
    database.set_history_enabled(&connection_id, false)
}
