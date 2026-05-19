#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use collaborator_lib::config;
use collaborator_lib::fs;
use collaborator_lib::pty;
use tauri::Manager;

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    let builder = pty::register_pty_commands(builder);
    let builder = fs::register_fs_commands(builder);

    builder
        .setup(|app| {
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
