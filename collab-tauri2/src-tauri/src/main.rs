#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use collaborator_lib::analytics;
use collaborator_lib::config;
use collaborator_lib::fs;
use collaborator_lib::menu;
use collaborator_lib::pty;
use collaborator_lib::watcher;
use tauri::Manager;

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    let builder = pty::register_pty_commands(builder);
    let builder = fs::register_fs_commands(builder);
    let builder = watcher::register_watcher_commands(builder);
    let builder = analytics::register_analytics_commands(builder);

    builder
        .setup(|app| {
            // Set application menu
            let app_menu = menu::build_menu(app)?;
            app.set_menu(app_menu).ok();

            // Load and apply config
            let config_path = config::config_path();
            let cfg = config::load_config(&config_path)?;

            let window = app.get_webview_window("main").unwrap();
            window.set_title("Collaborator").ok();
            window.set_size(
                tauri::Size::Physical(tauri::PhysicalSize {
                    width: cfg.window_width,
                    height: cfg.window_height,
                })
            ).ok();

            app.manage(cfg);
            app.manage(config_path);

            // Initialize analytics state
            use std::sync::Arc;
            use tokio::sync::Mutex;
            let analytics_state = Arc::new(Mutex::new(
                collaborator_lib::analytics::Analytics::new("", "unknown-device"),
            ));
            app.manage(analytics_state);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
