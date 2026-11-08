mod commands;
mod database;
mod documentation;
mod fonts;
mod header_metrics;
mod history;
mod local_shell;
mod models;
mod remote;
mod session;
mod ssh;
mod systemd;
mod updater;
mod windows_inspection;
mod windows_ssh;

#[cfg(feature = "desktop-e2e")]
mod e2e;

#[cfg(all(feature = "desktop-e2e", not(debug_assertions)))]
compile_error!("desktop-e2e is only for debug test builds");

use database::Database;
use remote::{RemoteOperationLimiter, StreamManager};
use session::SessionManager;
use tauri::Manager;

#[cfg(any(not(feature = "desktop-e2e"), test))]
fn database_path(app_data_directory: &std::path::Path, development: bool) -> std::path::PathBuf {
    let directory = if development {
        app_data_directory.join("development")
    } else {
        app_data_directory.to_path_buf()
    };
    directory.join("control-room.db")
}

// Debug windows wear the checkout's branch as their title so parallel dev
// builds are distinguishable in the taskbar; an unnamed branch falls back
// to "dev".
#[cfg(any(debug_assertions, test))]
fn dev_window_title(branch: &str) -> String {
    let branch = branch.trim();
    if branch.is_empty() {
        "dev".to_string()
    } else {
        branch.to_string()
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(feature = "desktop-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio::init());
    builder
        .manage(header_metrics::HeaderMetricsState::default())
        .manage(SessionManager::default())
        .manage(fonts::FontState::default())
        .manage(updater::UpdaterState::default())
        .manage(StreamManager::default())
        .manage(RemoteOperationLimiter::default())
        .setup(|app| {
            #[cfg(all(debug_assertions, not(feature = "desktop-e2e")))]
            if let Some(window) = app.get_webview_window("main") {
                window.set_title(&dev_window_title(env!("CONTROL_ROOM_BRANCH")))?;
            }

            #[cfg(feature = "desktop-e2e")]
            let data_directory = e2e::data_directory()?;
            #[cfg(feature = "desktop-e2e")]
            let database_path = data_directory.join("control-room.db");
            #[cfg(not(feature = "desktop-e2e"))]
            let database_path = database_path(&app.path().app_data_dir()?, cfg!(debug_assertions));
            #[cfg(feature = "desktop-e2e")]
            let fresh = !database_path.exists();
            let database = Database::open(&database_path).map_err(std::io::Error::other)?;
            #[cfg(feature = "desktop-e2e")]
            if fresh {
                let mut settings = database.get_settings()?;
                settings.automatic_update_checks = false;
                database.save_settings(&settings)?;
            }
            app.manage(database);
            #[cfg(feature = "desktop-e2e")]
            {
                // Elevated WebView2 ignores environment overrides. Pass the driver's
                // port and profile through the API in this debug-only test build.
                let driver_profile = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER");
                let mut window =
                    tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                        .data_directory(e2e::webview_data_directory(
                            driver_profile.as_deref(),
                            data_directory.join("webview"),
                        ));
                if let Some(arguments) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
                    .ok()
                    .and_then(|arguments| e2e::automation_browser_args(&arguments))
                {
                    window = window.additional_browser_args(&arguments);
                }
                window.build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(feature = "desktop-e2e")]
            e2e::e2e_runtime_status,
            commands::get_environment_info,
            documentation::open_documentation,
            fonts::list_catalog_fonts,
            fonts::preview_catalog_font,
            fonts::install_catalog_font,
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
            commands::discover_remote_shells,
            commands::list_local_shells,
            commands::start_local_session,
            commands::write_session,
            commands::resize_session,
            commands::acknowledge_session_output,
            commands::close_session,
            commands::get_cached_capabilities,
            commands::refresh_capabilities,
            commands::sample_host_resources,
            commands::sample_header_metrics,
            commands::list_services,
            commands::inspect_systemd_unit,
            commands::list_windows_services,
            commands::list_containers,
            commands::list_ports,
            commands::inspect_firewall,
            commands::inspect_connections,
            commands::inspect_container,
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
            commands::get_scratchpad_note,
            commands::save_scratchpad_note,
            commands::delete_scratchpad_note,
            commands::get_history_integration_status,
            commands::install_history_integration,
            commands::uninstall_history_integration,
            updater::check_for_update,
            updater::download_update,
            updater::install_update,
            updater::pending_update_notice,
            updater::dismiss_update_notice,
            updater::current_app_version,
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

#[cfg(test)]
mod startup_tests {
    use super::*;

    #[test]
    fn development_startup_preserves_the_installed_database() {
        let directory = tempfile::tempdir().unwrap();
        let installed_path = database_path(directory.path(), false);
        // An incompatible database makes accidental reuse fail at the real startup seam.
        let installed = rusqlite::Connection::open(&installed_path).unwrap();
        installed
            .execute_batch("PRAGMA user_version = 999;")
            .unwrap();
        drop(installed);
        let before = std::fs::read(&installed_path).unwrap();

        let development_path = database_path(directory.path(), true);
        let development = Database::open(&development_path)
            .expect("development startup must not open the installed database");
        assert!(development.list_connections().unwrap().is_empty());
        drop(development);

        assert_ne!(development_path, installed_path);
        assert_eq!(std::fs::read(installed_path).unwrap(), before);
    }

    #[test]
    fn installed_startup_keeps_the_existing_database_location() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            database_path(directory.path(), false),
            directory.path().join("control-room.db")
        );
    }
}

#[cfg(test)]
mod dev_window_title_tests {
    use super::*;

    #[test]
    fn uses_the_checked_out_branch() {
        assert_eq!(
            dev_window_title("vibe/dev-window-identity"),
            "vibe/dev-window-identity"
        );
    }

    #[test]
    fn trims_git_output() {
        assert_eq!(
            dev_window_title("  remove-unneeded-capability\n"),
            "remove-unneeded-capability"
        );
    }

    #[test]
    fn falls_back_to_dev_when_the_branch_is_unnamed() {
        assert_eq!(dev_window_title(""), "dev");
        assert_eq!(dev_window_title("   "), "dev");
    }
}
