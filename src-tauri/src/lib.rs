mod baselines;
mod commands;
mod database;
mod history;
mod models;
mod remote;
mod session;
mod ssh;

use baselines::BaselineCaptureRegistry;
use database::Database;
use remote::{RemoteOperationLimiter, StreamManager};
use session::SessionManager;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::default())
        .manage(StreamManager::default())
        .manage(RemoteOperationLimiter::default())
        .manage(BaselineCaptureRegistry::default())
        .setup(|app| {
            let database_path = app.path().app_data_dir()?.join("control-room.db");
            let database = Database::open(&database_path).map_err(std::io::Error::other)?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_environment_info,
            commands::list_connections,
            commands::create_connection,
            commands::update_connection,
            commands::test_connection,
            commands::delete_connection,
            commands::list_connection_groups,
            commands::list_connection_tags,
            commands::create_connection_tag,
            commands::rename_connection_tag,
            commands::delete_connection_tag,
            commands::set_connection_tag_color,
            commands::create_connection_group,
            commands::rename_connection_group,
            commands::delete_connection_group,
            commands::set_connection_group_collapsed,
            commands::move_connection_group,
            commands::start_session,
            commands::write_session,
            commands::resize_session,
            commands::acknowledge_session_output,
            commands::close_session,
            commands::get_cached_capabilities,
            commands::refresh_capabilities,
            commands::sample_host_resources,
            commands::list_services,
            commands::list_containers,
            commands::list_ports,
            commands::inspect_firewall,
            commands::inspect_connections,
            commands::inspect_container,
            commands::collect_boot_diagnostics,
            commands::start_journal_stream,
            commands::start_docker_log_stream,
            commands::stop_log_stream,
            commands::capture_host_baseline,
            commands::cancel_host_baseline,
            commands::list_host_baselines,
            commands::get_host_baseline,
            commands::rename_host_baseline,
            commands::set_host_baseline_pinned,
            commands::delete_host_baseline,
            commands::trace_host_baseline_entry,
            commands::export_text_file,
            commands::compare_host_baselines,
            commands::compare_host_baseline_with_live,
            commands::get_history,
            commands::add_history_entry,
            commands::delete_history_entry,
            commands::clear_history,
            commands::set_connection_history_enabled,
            commands::get_settings_contract,
            commands::save_settings,
            commands::get_workspace_state,
            commands::save_workspace_state,
            commands::get_scratchpad_note,
            commands::save_scratchpad_note,
            commands::delete_scratchpad_note,
            commands::get_history_integration_status,
            commands::install_history_integration,
            commands::uninstall_history_integration,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<SessionManager>().close_all();
                window.state::<StreamManager>().stop_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Control Room");
}
