use chrono::Utc;
use tauri::{AppHandle, State, ipc::Channel, ipc::Response};

use crate::{
    database::{Database, normalize_optional, validate_connection_input},
    header_metrics, history, local_shell,
    models::{
        AppSettings, ConnectionGroup, ConnectionTag, DockerContainer, DockerContainerDetails,
        EnvironmentInfo, EstablishedConnections, FirewallStatus, HeaderMetric, HeaderMetrics,
        HistoryEntry, HistoryInput, HostCapabilities, HostResources, LOG_TAIL_OPTIONS,
        ListeningSocket, LocalSessionStarted, LocalShellCatalog, PersistedWorkspaceState,
        SavedConnection, SavedConnectionInput, ScratchpadNote, ScratchpadNoteInput, SessionStarted,
        SettingsContract, StreamStarted, SystemdUnit,
    },
    platform,
    remote::{self, Elevation, LogStreamOptions, RemoteOperationLimiter, StreamManager},
    session::SessionManager,
    ssh::{detect_ssh_path, ssh_agent_available, ssh_config_path},
    windows_inspection,
    windows_ssh::{self, RemoteShellCatalog},
};

#[tauri::command(async)]
pub fn get_environment_info() -> EnvironmentInfo {
    let ssh_path = detect_ssh_path();
    let agent_available = ssh_agent_available(ssh_path.as_deref());
    EnvironmentInfo {
        platform: platform::client_id().into(),
        ssh_path: ssh_path.map(|path| path.to_string_lossy().to_string()),
        ssh_config_path: ssh_config_path(),
        ssh_agent_available: agent_available,
        platform_supported: platform::is_supported(),
        desktop_os: std::env::consts::OS,
        in_app_updates: crate::updater::in_app_updates(),
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
        username: normalize_optional(input.username),
        port: input.port,
        identity_file: normalize_optional(input.identity_file),
        history_enabled: false,
        sudo_enabled: false,
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

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn start_session(
    app: AppHandle,
    database: State<'_, Database>,
    sessions: State<'_, SessionManager>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    remote_shell_id: Option<String>,
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
        sudo_enabled: connection.sudo_enabled,
        group_id: connection.group_id.clone(),
        tag_names: connection.tags.iter().map(|tag| tag.name.clone()).collect(),
    })?;
    if !database.get_settings()?.global_history_enabled {
        connection.history_enabled = false;
    }
    let windows = database
        .get_capabilities(&connection_id)?
        .is_some_and(|caps| caps.os_id.as_deref() == Some("windows"));
    let _permit = if remote_shell_id.is_some() || windows {
        Some(limiter.acquire(&connection_id)?)
    } else {
        None
    };
    let remote_command = match remote_shell_id {
        Some(id) if id.starts_with("macos:") => {
            if !crate::macos_remote::is_host(&connection)? {
                return Err("macOS shells require a detected macOS host".into());
            }
            Some(crate::macos_remote::shell_command(
                &id,
                connection.history_enabled,
            )?)
        }
        Some(id) => Some(windows_ssh::selected_command(&connection, &id)?),
        None if windows => Some(windows_ssh::default_command(&connection)?),
        None => None,
    };
    let started = sessions.start(app, &connection, remote_command, cols, rows, output)?;
    Ok(started)
}

#[tauri::command(async)]
pub fn discover_remote_shells(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    refresh: Option<bool>,
) -> Result<RemoteShellCatalog, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    let catalog = windows_ssh::discover(&connection, refresh.unwrap_or(false))?;
    if let Some(capabilities) = &catalog.capabilities {
        database.save_capabilities(&connection, capabilities)?;
    }
    Ok(catalog)
}

/// The local shells this machine actually has, plus whether administrator
/// terminals can stay attached to Control Room. An uninstalled or unsupported
/// profile is never offered, so the frontend cannot ask for one.
#[tauri::command(async)]
pub fn list_local_shells() -> LocalShellCatalog {
    local_shell::installed_shells()
}

/// Starts a local shell. `shell_id` is a Local Shell Profile id and
/// nothing else: the executable, its arguments, privilege mode, and working
/// directory are resolved in Rust, so there is no way to ask for an arbitrary
/// process here.
#[tauri::command(async)]
pub fn start_local_session(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    shell_id: String,
    cols: u16,
    rows: u16,
    output: Channel<Response>,
) -> Result<LocalSessionStarted, String> {
    let shell = local_shell::resolve_installed(&shell_id)?;
    sessions.start_local(app, &shell, cols, rows, output)
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

fn windows_host(database: &Database, connection_id: &str) -> Result<bool, String> {
    Ok(database
        .get_capabilities(connection_id)?
        .is_some_and(|caps| caps.os_id.as_deref() == Some("windows")))
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
    database.save_capabilities(&connection, &capabilities)?;
    Ok(capabilities)
}

#[tauri::command]
pub async fn sample_header_metrics(
    app: AppHandle,
    connection_id: Option<String>,
    metrics: Vec<HeaderMetric>,
) -> Result<HeaderMetrics, String> {
    if metrics.len() > 6
        || metrics
            .iter()
            .enumerate()
            .any(|(index, metric)| metrics[..index].contains(metric))
    {
        return Err("Header metrics must be unique, with at most six selections".into());
    }
    if metrics.is_empty() {
        return Ok(header_metrics::empty_sample());
    }
    // SSH, limiter waits and native counter snapshots are blocking operations.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<header_metrics::HeaderMetricsState>();
        let _reading = state.begin(connection_id.as_deref())?;
        match connection_id {
            Some(id) => {
                let limiter = app.state::<RemoteOperationLimiter>();
                let _permit = limiter.acquire(&id)?;
                if windows_host(&app.state::<Database>(), &id)? {
                    return windows_inspection::metrics(
                        &app.state::<Database>().get_connection(&id)?,
                        &metrics,
                    );
                }
                header_metrics::collect_remote(
                    &app.state::<Database>().get_connection(&id)?,
                    &metrics,
                )
            }
            None => header_metrics::collect_local(&metrics),
        }
    })
    .await
    .map_err(|error| format!("Host metrics worker failed: {error}"))?
}

/// Samples current load. Deliberately not saved anywhere: unlike capabilities,
/// which are cached so a Workspace can open without a round trip, a load sample
/// is only true for the instant it was taken, and keeping a history of them
/// would turn an on-demand read into monitoring.
#[tauri::command(async)]
pub fn sample_host_resources(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<HostResources, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    remote::collect_host_resources(&connection)
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
pub fn inspect_systemd_unit(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    unit: String,
    section: crate::systemd::UnitReadSection,
) -> Result<crate::systemd::UnitInspection, String> {
    crate::ssh::validate_systemd_unit_id(&unit)?;
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    crate::systemd::inspect(&connection, &unit, section)
}

#[tauri::command(async)]
pub fn list_windows_services(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<Vec<windows_inspection::WindowsService>, String> {
    let _permit = limiter.acquire(&connection_id)?;
    if !windows_host(&database, &connection_id)? {
        return Err("Windows service inspection requires a detected Windows host".into());
    }
    windows_inspection::services(&database.get_connection(&connection_id)?)
}

/// Decides how one Structured Operation should run on one host. The global
/// setting is an override, not a default: while it is on, a connection that
/// never opted in is still elevated, which is what "allow sudo everywhere"
/// means. A password the user just typed always takes precedence.
fn elevation_for(
    database: &Database,
    connection: &SavedConnection,
    sudo_password: Option<String>,
) -> Result<Elevation, String> {
    let allowed = database.get_settings()?.global_sudo_enabled || connection.sudo_enabled;
    Ok(Elevation::resolve(allowed, sudo_password))
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
    if windows_host(&database, &connection_id)? {
        return windows_inspection::containers(&connection);
    }
    let elevation = elevation_for(&database, &connection, sudo_password)?;
    remote::list_containers(&connection, elevation)
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
    if windows_host(&database, &connection_id)? {
        return windows_inspection::ports(&connection);
    }
    let elevation = elevation_for(&database, &connection, sudo_password)?;
    remote::list_ports(&connection, elevation)
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
    if windows_host(&database, &connection_id)? {
        return windows_inspection::firewall(&connection);
    }
    let elevation = elevation_for(&database, &connection, sudo_password)?;
    remote::list_firewall(&connection, elevation)
}

#[tauri::command(async)]
pub fn inspect_connections(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
) -> Result<EstablishedConnections, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    if windows_host(&database, &connection_id)? {
        return windows_inspection::connections(&connection);
    }
    // Peer ownership is only visible for the caller's own processes without
    // privilege, so this read benefits from an allowance even though it has no
    // password retry of its own.
    let elevation = elevation_for(&database, &connection, None)?;
    remote::list_connections(&connection, elevation)
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
    if windows_host(&database, &connection_id)? {
        return windows_inspection::container(&connection, &container_id);
    }
    let elevation = elevation_for(&database, &connection, sudo_password)?;
    remote::inspect_container(&connection, &container_id, elevation)
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
    let elevation = elevation_for(&database, &connection, sudo_password)?;
    streams.start_journal(
        app,
        &connection,
        &service,
        LogStreamOptions {
            lines,
            follow,
            elevation,
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
    if windows_host(&database, &connection_id)? {
        return streams.start_windows_docker_logs(
            app,
            &connection,
            &container,
            LogStreamOptions {
                lines,
                follow,
                elevation: Elevation::None,
                output,
            },
        );
    }
    let elevation = elevation_for(&database, &connection, sudo_password)?;
    streams.start_docker_logs(
        app,
        &connection,
        &container,
        LogStreamOptions {
            lines,
            follow,
            elevation,
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
) -> Result<history::IntegrationStatus, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    history::integration_status(&connection)
}

#[tauri::command(async)]
pub fn install_history_integration(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    enable_capture: Option<bool>,
) -> Result<SavedConnection, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    history::install_integration(&connection)?;
    if enable_capture.unwrap_or(true) {
        database.set_history_enabled(&connection_id, true)?;
    }
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
    use super::{elevation_for, get_environment_info, validated_test_connection};
    use crate::database::Database;
    use crate::models::SavedConnectionInput;

    #[test]
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    fn environment_reports_the_compiled_client_platform() {
        let environment = get_environment_info();
        assert_eq!(
            environment.platform,
            if cfg!(target_os = "windows") {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            }
        );
        assert!(environment.platform_supported);
    }
    use crate::remote::Elevation;

    fn connection_input(sudo_enabled: bool) -> SavedConnectionInput {
        SavedConnectionInput {
            display_name: "Laptop".into(),
            destination: "laptop".into(),
            username: Some("test-user".into()),
            port: None,
            identity_file: None,
            history_enabled: false,
            sudo_enabled,
            group_id: None,
            tag_names: Vec::new(),
        }
    }

    #[test]
    fn the_global_setting_elevates_hosts_that_never_opted_in() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let connection = database.create_connection(connection_input(false)).unwrap();

        assert!(matches!(
            elevation_for(&database, &connection, None).unwrap(),
            Elevation::None
        ));

        let mut settings = database.get_settings().unwrap();
        settings.global_sudo_enabled = true;
        database.save_settings(&settings).unwrap();

        assert!(matches!(
            elevation_for(&database, &connection, None).unwrap(),
            Elevation::Allowed
        ));
    }

    #[test]
    fn one_host_can_be_elevated_while_the_global_setting_is_off() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let elevated = database.create_connection(connection_input(true)).unwrap();
        let plain = database
            .create_connection(SavedConnectionInput {
                display_name: "Server".into(),
                ..connection_input(false)
            })
            .unwrap();

        assert!(!database.get_settings().unwrap().global_sudo_enabled);
        assert!(matches!(
            elevation_for(&database, &elevated, None).unwrap(),
            Elevation::Allowed
        ));
        assert!(matches!(
            elevation_for(&database, &plain, None).unwrap(),
            Elevation::None
        ));
    }

    #[test]
    fn a_one_shot_password_elevates_a_host_that_never_opted_in() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let connection = database.create_connection(connection_input(false)).unwrap();
        assert!(matches!(
            elevation_for(&database, &connection, Some("hunter2".into())).unwrap(),
            Elevation::Password(_)
        ));
    }

    #[test]
    fn ssh_backed_commands_are_dispatched_asynchronously() {
        let source = include_str!("commands.rs");
        for command in [
            "get_environment_info",
            "start_session",
            "discover_remote_shells",
            "list_local_shells",
            "start_local_session",
            "refresh_capabilities",
            "sample_header_metrics",
            "list_services",
            "inspect_systemd_unit",
            "list_windows_services",
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
                source.contains(&declaration)
                    || source.contains(&format!("#[tauri::command]\npub async fn {command}")),
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
    fn a_local_session_starts_from_a_profile_id_and_nothing_else() {
        let source = include_str!("commands.rs");
        let start = source
            .split("pub fn start_local_session")
            .nth(1)
            .expect("start_local_session exists")
            .split("#[tauri::command")
            .next()
            .expect("start_local_session body exists");

        assert!(start.contains("shell_id: String"));
        assert!(start.contains("local_shell::resolve_installed(&shell_id)"));
        // Nothing about the process may come from the frontend: no path, no
        // arguments, no environment, no working directory.
        for rejected in [
            "program",
            "executable",
            "arguments",
            "args:",
            "command:",
            "Vec<String>",
            "PathBuf",
            "cwd",
            "env",
        ] {
            assert!(
                !start.contains(rejected),
                "start_local_session must not accept {rejected:?} from the frontend"
            );
        }
    }

    /// No command writes a file the frontend named. Everything writes to paths
    /// Rust chose, so a writer taking a path from a command would be a new
    /// trust boundary rather than a new feature, and deserves the extension
    /// and size checks a user-picked path needs.
    #[test]
    fn no_command_writes_a_frontend_named_path() {
        let sources = [
            include_str!("commands.rs"),
            include_str!("database.rs"),
            include_str!("remote.rs"),
            include_str!("session.rs"),
            include_str!("history.rs"),
            include_str!("updater.rs"),
            include_str!("local_shell.rs"),
            include_str!("ssh.rs"),
        ];
        let writes: usize = sources
            .iter()
            .map(|source| {
                // The test module of this file names these while asserting
                // about them, so only the code above `mod tests` counts.
                let production = source.split("#[cfg(test)]").next().unwrap_or(source);
                production.matches("fs::write(").count()
                    + production.matches("File::create(").count()
                    + production.matches("OpenOptions::").count()
            })
            .sum();

        assert_eq!(
            writes, 0,
            "a command writes a frontend-chosen path; it is a new trust \
             boundary and needs its own extension and size checks"
        );
    }

    #[test]
    fn there_is_no_arbitrary_process_execution_command() {
        // Only the commands themselves, not this test module, which names the
        // very identifiers it forbids.
        let commands = include_str!("commands.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("command definitions precede the tests");
        let handlers = include_str!("lib.rs");

        for forbidden in [
            "run_command",
            "spawn_process",
            "run_shell",
            "execute_command",
            "run_local_command",
            // Control Room is the terminal emulator; it never launches another.
            "wt.exe",
        ] {
            assert!(!commands.contains(forbidden), "{forbidden} must not exist");
            assert!(
                !handlers.contains(forbidden),
                "{forbidden} must not be registered"
            );
        }

        // No command takes a program, a script, or an argument list from the
        // frontend. The interactive terminal is the execution surface, and Rust
        // owns what runs on it.
        for block in commands.split("#[tauri::command").skip(1) {
            let signature = block
                .split(" {")
                .next()
                .expect("a command signature precedes its body");
            for rejected in [
                "program:",
                "executable:",
                "script:",
                "arguments:",
                "argv",
                "command_line",
            ] {
                assert!(
                    !signature.contains(rejected),
                    "a command accepts {rejected:?}: {signature}"
                );
            }
        }
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
            sudo_enabled: false,
            group_id: None,
            tag_names: Vec::new(),
        })
        .unwrap();

        assert_eq!(connection.display_name, "Test host");
        assert_eq!(connection.destination, "host-alias");
        assert_eq!(connection.username.as_deref(), Some("user"));
        assert!(!connection.history_enabled);
    }

    /// Testing an unsaved connection has to normalize exactly the way saving
    /// one does, or the destination the user tested is not the destination
    /// stored a moment later. Blank optional fields collapse to `None` rather
    /// than to an empty string that would reach SSH argument construction.
    #[test]
    fn testing_a_connection_blanks_optional_fields_the_way_saving_does() {
        let connection = validated_test_connection(SavedConnectionInput {
            display_name: "Test host".into(),
            destination: "host-alias".into(),
            username: Some("user".into()),
            port: None,
            identity_file: Some("   ".into()),
            history_enabled: false,
            sudo_enabled: false,
            group_id: None,
            tag_names: Vec::new(),
        })
        .unwrap();

        assert_eq!(connection.identity_file, None);
        assert_eq!(connection.port, None);
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
