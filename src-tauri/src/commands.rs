use chrono::Utc;
use tauri::{AppHandle, State, ipc::Channel, ipc::Response};

use crate::{
    baselines::{self, BaselineCaptureRegistry, SectionReporter},
    database::{Database, validate_connection_input},
    history, local_shell,
    models::{
        AppSettings, BaselineCaptureRequest, BaselineComparison, BaselineProgress, BaselineSection,
        BaselineTrace, BootDiagnostics, ConnectionGroup, ConnectionTag, DockerContainer,
        DockerContainerDetails, EnvironmentInfo, EstablishedConnections, FirewallStatus,
        HistoryEntry, HistoryInput, HostBaseline, HostBaselineSummary, HostCapabilities,
        HostResources, LOG_TAIL_OPTIONS, ListeningSocket, LocalSessionStarted, LocalShellProfile,
        PersistedWorkspaceState, SavedConnection, SavedConnectionInput, ScratchpadNote,
        ScratchpadNoteInput, SessionStarted, SettingsContract, StreamStarted, SystemdUnit,
    },
    remote::{self, Elevation, LogStreamOptions, RemoteOperationLimiter, StreamManager},
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
        sudo_enabled: connection.sudo_enabled,
        group_id: connection.group_id.clone(),
        tag_names: connection.tags.iter().map(|tag| tag.name.clone()).collect(),
    })?;
    if !database.get_settings()?.global_history_enabled {
        connection.history_enabled = false;
    }
    let started = sessions.start(app, &connection, cols, rows, output)?;
    Ok(started)
}

/// The local shells this machine actually has. An uninstalled shell is never
/// offered, so the frontend cannot ask for one.
#[tauri::command(async)]
pub fn list_local_shells() -> Vec<LocalShellProfile> {
    local_shell::installed_shells()
}

/// Starts a local Windows shell. `shell_id` is a Local Shell Profile id and
/// nothing else: the executable, its arguments, and its working directory are
/// resolved in Rust, so there is no way to ask for an arbitrary process here.
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
    let elevation = elevation_for(&database, &connection, sudo_password)?;
    remote::inspect_container(&connection, &container_id, elevation)
}

#[tauri::command(async)]
pub fn collect_boot_diagnostics(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    connection_id: String,
    boot_id: Option<String>,
    sudo_password: Option<String>,
) -> Result<BootDiagnostics, String> {
    let _permit = limiter.acquire(&connection_id)?;
    let connection = database.get_connection(&connection_id)?;
    let elevation = elevation_for(&database, &connection, sudo_password)?;
    remote::collect_boot_diagnostics(&connection, boot_id.as_deref(), elevation)
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

struct ChannelSectionReporter<'a> {
    capture_id: &'a str,
    channel: Channel<BaselineProgress>,
}

impl SectionReporter for ChannelSectionReporter<'_> {
    fn report(&self, section: &BaselineSection, completed: u32, total: u32) {
        let _ = self.channel.send(BaselineProgress {
            capture_id: self.capture_id.to_string(),
            kind: section.kind.clone(),
            status: section.status.clone(),
            message: section.message.clone(),
            completed,
            total,
        });
    }
}

/// Captures one baseline. Nothing here runs on a timer: the command exists only
/// because the user chose Capture baseline.
#[tauri::command(async)]
pub fn capture_host_baseline(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    captures: State<'_, BaselineCaptureRegistry>,
    request: BaselineCaptureRequest,
    progress: Channel<BaselineProgress>,
) -> Result<HostBaselineSummary, String> {
    let connection = database.get_connection(&request.connection_id)?;
    let _permit = limiter.acquire(&request.connection_id)?;
    let reporter = ChannelSectionReporter {
        capture_id: &request.capture_id,
        channel: progress,
    };
    // A capture honours the sudo permission the user granted for this host, so
    // sections that need root are collected rather than recorded as partial.
    // It still never prompts: without passwordless sudo the reads run
    // unelevated and say so.
    let elevation = elevation_for(&database, &connection, None)?;
    let baseline = baselines::capture(
        &connection,
        &request.capture_id,
        request.label,
        request.sections.as_deref(),
        &elevation,
        &captures,
        &reporter,
    )?;
    database.save_host_baseline(&baseline)
}

#[tauri::command]
pub fn cancel_host_baseline(
    captures: State<'_, BaselineCaptureRegistry>,
    capture_id: String,
) -> Result<(), String> {
    captures.cancel(&capture_id)
}

#[tauri::command]
pub fn list_host_baselines(
    database: State<'_, Database>,
    connection_id: String,
) -> Result<Vec<HostBaselineSummary>, String> {
    database.list_host_baselines(&connection_id)
}

#[tauri::command]
pub fn get_host_baseline(
    database: State<'_, Database>,
    id: String,
) -> Result<HostBaseline, String> {
    database.get_host_baseline(&id)
}

#[tauri::command]
pub fn rename_host_baseline(
    database: State<'_, Database>,
    id: String,
    label: Option<String>,
) -> Result<HostBaselineSummary, String> {
    database.rename_host_baseline(&id, label)
}

/// Pins or unpins one capture. A pinned capture survives the per-connection
/// retention limit, so a named baseline is not evicted by routine captures.
#[tauri::command]
pub fn set_host_baseline_pinned(
    database: State<'_, Database>,
    id: String,
    pinned: bool,
) -> Result<HostBaselineSummary, String> {
    database.set_host_baseline_pinned(&id, pinned)
}

#[tauri::command]
pub fn delete_host_baseline(database: State<'_, Database>, id: String) -> Result<(), String> {
    database.delete_host_baseline(&id)
}

/// Reads one entry across every stored capture of a connection, newest first.
#[tauri::command]
pub fn trace_host_baseline_entry(
    database: State<'_, Database>,
    connection_id: String,
    kind: String,
    identity: String,
) -> Result<BaselineTrace, String> {
    database.trace_host_baseline_entry(&connection_id, &kind, &identity)
}

/// Writes text the user already sees to a path the user already chose in the
/// system save dialog. Nothing here reaches a host or the network.
#[tauri::command]
pub fn export_text_file(path: String, contents: String) -> Result<(), String> {
    let extension = std::path::Path::new(&path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("md") | Some("json")) {
        return Err("Exports are written as .md or .json only".into());
    }
    if contents.len() > 8 * 1024 * 1024 {
        return Err("That export is too large to write".into());
    }
    std::fs::write(&path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn compare_host_baselines(
    database: State<'_, Database>,
    base_id: String,
    target_id: String,
) -> Result<BaselineComparison, String> {
    if base_id == target_id {
        return Err("Choose two different baselines to compare".into());
    }
    let base = database.get_host_baseline(&base_id)?;
    let target = database.get_host_baseline(&target_id)?;
    if base.connection_id != target.connection_id {
        return Err("Baselines from different Saved Connections cannot be compared".into());
    }
    Ok(baselines::compare(&base, &target))
}

/// Compares a saved capture against the host as it is right now. The live read
/// happens only because the user asked for this comparison and is never stored,
/// so the baseline list still only grows from Capture baseline.
#[tauri::command(async)]
pub fn compare_host_baseline_with_live(
    database: State<'_, Database>,
    limiter: State<'_, RemoteOperationLimiter>,
    captures: State<'_, BaselineCaptureRegistry>,
    base_id: String,
    capture_id: String,
    progress: Channel<BaselineProgress>,
) -> Result<BaselineComparison, String> {
    let base = database.get_host_baseline(&base_id)?;
    let connection = database.get_connection(&base.connection_id)?;
    let _permit = limiter.acquire(&connection.id)?;
    let reporter = ChannelSectionReporter {
        capture_id: &capture_id,
        channel: progress,
    };
    let elevation = elevation_for(&database, &connection, None)?;
    let live = baselines::capture(
        &connection,
        &capture_id,
        None,
        None,
        &elevation,
        &captures,
        &reporter,
    )?;
    Ok(baselines::compare_with_live(&base, &live))
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
    use super::{elevation_for, validated_test_connection};
    use crate::database::Database;
    use crate::models::SavedConnectionInput;
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
            "list_local_shells",
            "start_local_session",
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
