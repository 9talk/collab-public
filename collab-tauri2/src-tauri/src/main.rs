#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use collaborator_lib::analytics;
use collaborator_lib::config;
use collaborator_lib::fs;
use collaborator_lib::menu;
use collaborator_lib::pty;
use collaborator_lib::watcher;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri::menu::MenuEvent;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            // PTY
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_discover,
            // File system
            fs::read_file,
            fs::write_file,
            fs::list_dir,
            fs::get_home_dir,
            fs::exists,
            // Config
            config::pref_get,
            config::pref_set,
            // Watcher
            watcher::watch_start,
            // Analytics
            analytics::analytics_track,
        ])
        .setup(|app| {
            let app_menu = menu::build_menu(app)?;
            app.set_menu(app_menu).ok();

            let config_path = config::config_path();
            let config_path_clone = config_path.clone();
            let cfg = config::load_config(&config_path).unwrap_or_default();

            let window = app.get_webview_window("main").unwrap();
            window.set_title("Collaborator").ok();

            // Restore window position and size
            if cfg.window_width > 0 && cfg.window_height > 0 {
                window.set_size(
                    tauri::Size::Physical(tauri::PhysicalSize {
                        width: cfg.window_width,
                        height: cfg.window_height,
                    })
                ).ok();
            }
            if cfg.window_x != 0 || cfg.window_y != 0 {
                window.set_position(
                    tauri::PhysicalPosition::new(cfg.window_x, cfg.window_y)
                ).ok();
            }

            apply_theme(&window, &cfg.theme);

            let config_state = Arc::new(Mutex::new(cfg));
            app.manage(config_state);
            app.manage(config_path.clone());

            let analytics_state = Arc::new(Mutex::new(
                collaborator_lib::analytics::Analytics::new("", "unknown-device"),
            ));
            app.manage(analytics_state);

            // Save window state on close
            let config_path_clone = config_path.clone();
            let app_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let _ = api;
                    let app = app_handle.clone();
                    let path = config_path_clone.clone();
                    std::thread::spawn(move || {
                        if let Some(win) = app.get_webview_window("main") {
                            if let Ok(bounds) = win.outer_position() {
                                if let Ok(size) = win.inner_size() {
                                    let mut cfg = config::load_config(&path).unwrap_or_default();
                                    cfg.window_x = bounds.x;
                                    cfg.window_y = bounds.y;
                                    cfg.window_width = size.width;
                                    cfg.window_height = size.height;
                                    let _ = config::save_config(&path, &cfg);
                                }
                            }
                        }
                    });
                }
            });

            Ok(())
        })
        .on_menu_event(handle_menu_event)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn handle_menu_event(app: &tauri::AppHandle, event: MenuEvent) {
    let menu_id = event.id().as_ref();
    let _ = match menu_id {
        "new-tile" => app.emit("menu:action", "new-tile"),
        "close-tile" => app.emit("menu:action", "close-tile"),
        "open-workspace" => app.emit("menu:action", "open-workspace"),
        "toggle-files" => app.emit("menu:action", "toggle-files"),
        "toggle-agent" => app.emit("menu:action", "toggle-agent"),
        _ => Ok(()),
    };
}

fn apply_theme(window: &tauri::WebviewWindow, theme: &str) {
    match theme {
        "dark" => {
            let _ = window.set_theme(Some(tauri::Theme::Dark));
        }
        "light" => {
            let _ = window.set_theme(Some(tauri::Theme::Light));
        }
        _ => {
            let _ = window.set_theme(None);
        }
    }
}
