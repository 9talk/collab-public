use serde::Serialize;
use std::path::Path;
use tauri::Manager;

/// Open external URL in system browser
#[tauri::command]
pub fn shell_open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct SessionMeta {
    pub shell: String,
    pub cwd: String,
    pub created_at: String,
    pub target: Option<String>,
    pub backend: Option<String>,
}

#[tauri::command]
pub fn pty_read_meta(
    state: tauri::State<crate::pty::PtyManagerWrapper>,
    id: String,
) -> Result<Option<SessionMeta>, String> {
    let manager = state.0.lock().unwrap();
    let session = manager.get_session(&id);
    match session {
        Some(s) => {
            let now = std::time::SystemTime::now();
            Ok(Some(SessionMeta {
                shell: "/bin/zsh".to_string(),
                cwd: s.cwd.clone(),
                created_at: chrono::DateTime::from_timestamp(
                    now.elapsed().unwrap_or_default().as_secs() as i64, 0,
                ).unwrap_or_default().to_rfc3339(),
                target: Some("local".to_string()),
                backend: None,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn pty_send_raw_keys(
    state: tauri::State<crate::pty::PtyManagerWrapper>,
    id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.0.lock().unwrap();
    manager.write_to_session(&id, &data).map_err(|e| e.to_string())
}

/// Terminal targets (for now, just local shell)
#[tauri::command]
pub fn terminal_list_targets() -> Result<Vec<serde_json::Value>, String> {
    let shell = if cfg!(windows) { "cmd" } else { "zsh" };
    Ok(vec![serde_json::json!({
        "id": "local",
        "label": format!("Local ({})", shell),
        "isDefault": true,
    })])
}

/// Theme setting
#[tauri::command]
pub fn theme_set(mode: String, app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match mode.as_str() {
            "dark" => { let _ = window.set_theme(Some(tauri::Theme::Dark)); }
            "light" => { let _ = window.set_theme(Some(tauri::Theme::Light)); }
            _ => { let _ = window.set_theme(None); }
        }
    }
}

/// Context menu (simple implementation - returns selected item ID)
#[tauri::command]
pub fn context_menu_show(
    items: Vec<serde_json::Value>,
    _app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    // For now, context menu is handled differently in Tauri
    // This is a placeholder that can be enhanced later
    log::info!("context_menu_show: {:?}", items);
    Ok(None)
}

/// Nav open in terminal
#[tauri::command]
pub fn nav_open_in_terminal(path: String) -> Result<(), String> {
    // Open a new terminal window at the given path
    open::that_detached(&path).map_err(|e| e.to_string())
}

/// Nav create graph tile
#[tauri::command]
pub fn nav_create_graph_tile(folder_path: String) -> Result<(), String> {
    // Emit an event to the frontend to create a graph tile
    log::info!("nav_create_graph_tile: {}", folder_path);
    Ok(())
}

/// Workspace pref get/set (simplified)
#[tauri::command]
pub fn workspace_pref_get(key: String, workspace_path: String) -> Result<serde_json::Value, String> {
    let prefs_file = Path::new(&workspace_path).join(".collaborator/prefs.json");
    if prefs_file.exists() {
        let content = std::fs::read_to_string(&prefs_file).map_err(|e| e.to_string())?;
        let prefs: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
        Ok(prefs.get(&key).cloned().unwrap_or(serde_json::Value::Null))
    } else {
        Ok(serde_json::Value::Null)
    }
}

#[tauri::command]
pub fn workspace_pref_set(key: String, value: serde_json::Value, workspace_path: String) -> Result<(), String> {
    let prefs_dir = Path::new(&workspace_path).join(".collaborator");
    std::fs::create_dir_all(&prefs_dir).ok();
    let prefs_file = prefs_dir.join("prefs.json");

    let mut prefs = if prefs_file.exists() {
        let content = std::fs::read_to_string(&prefs_file).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    prefs[key] = value;
    let content = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    std::fs::write(&prefs_file, content).map_err(|e| e.to_string())?;
    Ok(())
}
