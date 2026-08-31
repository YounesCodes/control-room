mod commands;
mod database;
mod history;
mod models;
mod remote;
mod session;
mod ssh;

use database::Database;
use remote::{RemoteOperationLimiter, ResourceOperationManager, StreamManager};
use session::SessionManager;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::default())
        .manage(StreamManager::default())
        .manage(RemoteOperationLimiter::default())
        .manage(ResourceOperationManager::default())
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
            commands::start_session,
            commands::write_session,
            commands::resize_session,
            commands::acknowledge_session_output,
            commands::close_session,
            commands::get_cached_capabilities,
            commands::refresh_capabilities,
            commands::list_services,
            commands::list_containers,
            commands::begin_resource_collection,
            commands::collect_resources,
            commands::cancel_resource_collection,
            commands::start_journal_stream,
            commands::start_docker_log_stream,
            commands::stop_log_stream,
            commands::get_history,
            commands::add_history_entry,
            commands::delete_history_entry,
            commands::clear_history,
            commands::set_connection_history_enabled,
            commands::get_settings_contract,
            commands::save_settings,
            commands::get_workspace_state,
            commands::save_workspace_state,
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
