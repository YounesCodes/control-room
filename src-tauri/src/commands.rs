use chrono::Utc;
use tauri::{AppHandle, State, ipc::Channel, ipc::Response};

use crate::{
    database::{Database, validate_connection_input},
    history,
    models::{
        AppSettings, ConnectionGroup, ConnectionTag, DockerContainer, DockerContainerDetails,
        EnvironmentInfo, EstablishedConnections, FirewallStatus, HistoryEntry, HistoryInput,
        HostCapabilities, LOG_TAIL_OPTIONS, ListeningSocket, PersistedWorkspaceState,
        SavedConnection, SavedConnectionInput, ScratchpadNote, ScratchpadNoteInput, SessionStarted,
        SettingsContract, StreamStarted, SystemdUnit,
    },
    remote::{self, LogStreamOptions, RemoteOperationLimiter, StreamManager},
    session::SessionManager,
    ssh::{detect_ssh_path, ssh_agent_available, ssh_config_path},
};

#[tauri::command(async)]
pub fn get_environment_info() -> EnvironmentInfo {
    let ssh_path = detect_ssh_path();
    let agent_available = ssh_agent_available(ssh_path.as_deref());
    EnvironmentInfo {
        ssh_path: ssh_path.map(|path| path.to_string_lossy().to_string()),
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

fn validated_test_connection(input: SavedConnectionInput) -> Result<SavedConnection, String> {
    validate_connection_input(&input)?;
    let now = Utc::now().to_rfc3339();
    Ok(SavedConnection {
        id: "connection-test".into(),
        display_name: input.display_name.trim().into(),
        destination: input.destination.trim().into(),
        username: input
            .username
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        port: input.port,
        identity_file: input
            .identity_file
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        history_enabled: false,
        group_id: None,
        tags: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
        last_connected_at: None,
    })
}

#[tauri::command(async)]
pub fn test_connection(
    limiter: State<'_, RemoteOperationLimiter>,
    input: SavedConnectionInput,
) -> Result<HostCapabilities, String> {
    let connection = validated_test_connection(input)?;
    let _permit = limiter.acquire("connection-test")?;
    remote::discover_capabilities(&connection)
}

#[tauri::command]
pub fn delete_connection(database: State<'_, Database>, id: String) -> Result<(), String> {
    database.delete_connection(&id)
}

#[tauri::command]
pub fn list_connection_groups(
    database: State<'_, Database>,
) -> Result<Vec<ConnectionGroup>, String> {
    database.list_connection_groups()
}

#[tauri::command]
pub fn list_connection_tags(database: State<'_, Database>) -> Result<Vec<ConnectionTag>, String> {
    database.list_connection_tags()
}

#[tauri::command]
pub fn create_connection_tag(
    database: State<'_, Database>,
    name: String,
    color: String,
) -> Result<ConnectionTag, String> {
    database.create_connection_tag(&name, &color)
}

#[tauri::command]
pub fn rename_connection_tag(
    database: State<'_, Database>,
    id: String,
    name: String,
) -> Result<ConnectionTag, String> {
    database.rename_connection_tag(&id, &name)
}

#[tauri::command]
pub fn delete_connection_tag(database: State<'_, Database>, id: String) -> Result<(), String> {
    database.delete_connection_tag(&id)
}

#[tauri::command]
pub fn set_connection_tag_color(
    database: State<'_, Database>,
    id: String,
    color: String,
) -> Result<ConnectionTag, String> {
    database.set_connection_tag_color(&id, &color)
}

#[tauri::command]
pub fn create_connection_group(
    database: State<'_, Database>,
    name: String,
) -> Result<ConnectionGroup, String> {
    database.create_connection_group(&name)
}

#[tauri::command]
pub fn rename_connection_group(
    database: State<'_, Database>,
    id: String,
    name: String,
) -> Result<ConnectionGroup, String> {
    database.rename_connection_group(&id, &name)
}

#[tauri::command]
pub fn delete_connection_group(database: State<'_, Database>, id: String) -> Result<(), String> {
    database.delete_connection_group(&id)
}

#[tauri::command]
pub fn set_connection_group_collapsed(
    database: State<'_, Database>,
    id: String,
    collapsed: bool,
) -> Result<(), String> {
    database.set_connection_group_collapsed(&id, collapsed)
}

#[tauri::command]
pub fn move_connection_group(
    database: State<'_, Database>,
    id: String,
    direction: String,
) -> Result<Vec<ConnectionGroup>, String> {
    database.move_connection_group(&id, &direction)
}

#[tauri::command(async)]
pub fn start_session(
    app: AppHandle,
    database: State<'_, Database>,
    sessions: State<'_, SessionManager>,
    connection_id: String,
    cols: u16,
    rows: u16,
    output: Channel<Response>,
) -> Result<SessionStarted, String> {
    let mut connection = database.get_connection(&connection_id)?;
    validate_connection_input(&SavedConnectionInput {
        display_name: connection.display_name.clone(),
        destination: connection.destination.clone(),
        username: connection.username.clone(),
        port: connection.port,
        identity_file: connection.identity_file.clone(),
        history_enabled: connection.history_enabled,
        group_id: connection.group_id.clone(),
        tag_names: connection.tags.iter().map(|tag| tag.name.clone()).collect(),
    })?;
    if !database.get_settings()?.global_history_enabled {
        connection.history_enabled = false;
    }
    let started = sessions.start(app, &connection, cols, rows, output)?;
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
pub fn acknowledge_session_output(
    sessions: State<'_, SessionManager>,
    session_id: String,
    bytes: u32,
) {
    sessions.acknowledge_output(&session_id, bytes as usize);
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

#[tauri::command(async)]
pub fn refresh_capabilities(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<HostCapabilities, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    let capabilities = remote::discover_capabilities(&connection)?;
    database.save_capabilities(&capabilities)?;
    Ok(capabilities)
}

#[tauri::command(async)]
pub fn list_services(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<Vec<SystemdUnit>, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    remote::list_services(&connection)
}

#[tauri::command(async)]
pub fn list_containers(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    sudo_password: Option<String>,
) -> Result<Vec<DockerContainer>, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    remote::list_containers(&connection, sudo_password)
}

#[tauri::command(async)]
pub fn list_ports(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    sudo_password: Option<String>,
) -> Result<Vec<ListeningSocket>, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    remote::list_ports(&connection, sudo_password)
}

#[tauri::command(async)]
pub fn inspect_firewall(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    sudo_password: Option<String>,
) -> Result<FirewallStatus, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    remote::list_firewall(&connection, sudo_password)
}

#[tauri::command(async)]
pub fn inspect_connections(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<EstablishedConnections, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    remote::list_connections(&connection)
}

#[tauri::command(async)]
pub fn inspect_container(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    container_id: String,
    sudo_password: Option<String>,
) -> Result<DockerContainerDetails, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    remote::inspect_container(&connection, &container_id, sudo_password)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn start_journal_stream(
    app: AppHandle,
    database: State<'_, Database>,
    streams: State<'_, StreamManager>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    service: String,
    lines: u16,
    follow: bool,
    sudo_password: Option<String>,
    output: Channel<Response>,
) -> Result<StreamStarted, String> {
    let _permit = limiter.acquire(&connection_id)?;
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

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn start_docker_log_stream(
    app: AppHandle,
    database: State<'_, Database>,
    streams: State<'_, StreamManager>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    container: String,
    lines: u16,
    follow: bool,
    sudo_password: Option<String>,
    output: Channel<Response>,
) -> Result<StreamStarted, String> {
    let _permit = limiter.acquire(&connection_id)?;
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
pub fn set_connection_history_enabled(
    database: State<'_, Database>,
    connection_id: String,
    enabled: bool,
) -> Result<SavedConnection, String> {
    database.set_history_enabled(&connection_id, enabled)?;
    database.get_connection(&connection_id)
}

#[tauri::command]
pub fn get_settings_contract(database: State<'_, Database>) -> Result<SettingsContract, String> {
    Ok(SettingsContract {
        current: database.get_settings()?,
        defaults: AppSettings::default(),
        log_tail_options: LOG_TAIL_OPTIONS.to_vec(),
    })
}

#[tauri::command]
pub fn save_settings(database: State<'_, Database>, settings: AppSettings) -> Result<(), String> {
    database.save_settings(&settings)
}

#[tauri::command]
pub fn get_workspace_state(
    database: State<'_, Database>,
) -> Result<PersistedWorkspaceState, String> {
    database.get_workspace_state()
}

#[tauri::command]
pub fn save_workspace_state(
    database: State<'_, Database>,
    state: PersistedWorkspaceState,
) -> Result<(), String> {
    database.save_workspace_state(&state)
}

#[tauri::command]
pub fn get_scratchpad_note(
    database: State<'_, Database>,
    scope: String,
    owner_id: String,
    connection_id: Option<String>,
) -> Result<Option<ScratchpadNote>, String> {
    database.get_scratchpad_note(&scope, &owner_id, connection_id.as_deref())
}

#[tauri::command]
pub fn save_scratchpad_note(
    database: State<'_, Database>,
    input: ScratchpadNoteInput,
) -> Result<ScratchpadNote, String> {
    database.save_scratchpad_note(input)
}

#[tauri::command]
pub fn delete_scratchpad_note(
    database: State<'_, Database>,
    scope: String,
    owner_id: String,
    connection_id: Option<String>,
) -> Result<(), String> {
    database.delete_scratchpad_note(&scope, &owner_id, connection_id.as_deref())
}

#[tauri::command(async)]
pub fn get_history_integration_status(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<bool, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    history::integration_status(&connection)
}

#[tauri::command(async)]
pub fn install_history_integration(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<SavedConnection, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    history::install_integration(&connection)?;
    database.set_history_enabled(&connection_id, true)?;
    database.get_connection(&connection_id)
}

#[tauri::command(async)]
pub fn uninstall_history_integration(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<SavedConnection, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    history::uninstall_integration(&connection)?;
    database.set_history_enabled(&connection_id, false)?;
    database.get_connection(&connection_id)
}

#[cfg(test)]
mod tests {
    use super::validated_test_connection;
    use crate::models::SavedConnectionInput;

    #[test]
    fn ssh_backed_commands_are_dispatched_asynchronously() {
        let source = include_str!("commands.rs");
        for command in [
            "get_environment_info",
            "start_session",
            "refresh_capabilities",
            "list_services",
            "list_containers",
            "list_ports",
            "inspect_firewall",
            "inspect_connections",
            "inspect_container",
            "start_journal_stream",
            "start_docker_log_stream",
            "get_history_integration_status",
            "install_history_integration",
            "uninstall_history_integration",
        ] {
            let declaration = format!("#[tauri::command(async)]\npub fn {command}");
            assert!(
                source.contains(&declaration),
                "{command} must stay asynchronous"
            );
        }
    }

    #[test]
    fn terminal_start_loads_the_saved_connection_by_id() {
        let source = include_str!("commands.rs");
        let start = source
            .split("pub fn start_session")
            .nth(1)
            .expect("start_session exists")
            .split("#[tauri::command]")
            .next()
            .expect("start_session body exists");
        assert!(start.contains("connection_id: String"));
        assert!(start.contains("database.get_connection(&connection_id)"));
        assert!(!start.contains("connection: SavedConnection"));
    }

    #[test]
    fn structured_access_tests_validate_and_normalize_unsaved_details() {
        let connection = validated_test_connection(SavedConnectionInput {
            display_name: " Test host ".into(),
            destination: " host-alias ".into(),
            username: Some(" user ".into()),
            port: Some(22),
            identity_file: None,
            history_enabled: true,
            group_id: None,
            tag_names: Vec::new(),
        })
        .unwrap();

        assert_eq!(connection.display_name, "Test host");
        assert_eq!(connection.destination, "host-alias");
        assert_eq!(connection.username.as_deref(), Some("user"));
        assert!(!connection.history_enabled);
    }

    #[test]
    fn connection_organization_commands_are_local_only() {
        let source = include_str!("commands.rs");
        for command in [
            "list_connection_groups",
            "list_connection_tags",
            "create_connection_tag",
            "rename_connection_tag",
            "delete_connection_tag",
            "set_connection_tag_color",
            "create_connection_group",
            "rename_connection_group",
            "delete_connection_group",
            "set_connection_group_collapsed",
            "move_connection_group",
        ] {
            let body = source
                .split(&format!("pub fn {command}"))
                .nth(1)
                .expect("organization command exists")
                .split("#[tauri::command")
                .next()
                .expect("organization command body exists");
            assert!(body.contains("database."));
            assert!(!body.contains("remote::"));
            assert!(!body.contains("SessionManager"));
        }
    }

    #[test]
    fn scratchpad_commands_only_use_local_persistence() {
        let source = include_str!("commands.rs");
        for command in [
            "get_scratchpad_note",
            "save_scratchpad_note",
            "delete_scratchpad_note",
        ] {
            let body = source
                .split(&format!("pub fn {command}"))
                .nth(1)
                .expect("scratchpad command exists")
                .split("#[tauri::command")
                .next()
                .expect("scratchpad command body exists");
            assert!(body.contains("database."));
            assert!(!body.contains("remote::"));
            assert!(!body.contains("RemoteOperationLimiter"));
        }
    }
}
