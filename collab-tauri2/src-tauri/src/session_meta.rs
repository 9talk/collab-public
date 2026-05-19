use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub shell: String,
    pub cwd: String,
    pub created_at: String,
    pub target: Option<String>,
    pub display_name: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd_host_path: Option<String>,
    pub cwd_guest_path: Option<String>,
    pub backend: Option<String>,
}

pub fn session_dir() -> PathBuf {
    let dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.join("collaborator/terminal-sessions")
}

pub fn write_session_meta(session_id: &str, meta: &SessionMeta) -> Result<(), String> {
    let dir = session_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", session_id));
    let content = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn read_session_meta(session_id: &str) -> Result<SessionMeta, String> {
    let path = session_dir().join(format!("{}.json", session_id));
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

pub fn list_session_metas() -> Result<Vec<(String, SessionMeta)>, String> {
    let dir = session_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let meta: SessionMeta = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            let id = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            sessions.push((id, meta));
        }
    }
    Ok(sessions)
}

pub fn remove_session_meta(session_id: &str) -> Result<(), String> {
    let path = session_dir().join(format!("{}.json", session_id));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn session_meta_read(session_id: String) -> Result<SessionMeta, String> {
    read_session_meta(&session_id)
}

#[tauri::command]
pub fn session_meta_write(
    session_id: String,
    meta: SessionMeta,
) -> Result<(), String> {
    write_session_meta(&session_id, &meta)
}

#[tauri::command]
pub fn session_meta_list() -> Result<Vec<serde_json::Value>, String> {
    let sessions = list_session_metas()?;
    Ok(sessions.into_iter().map(|(id, meta)| {
        serde_json::json!({
            "id": id,
            "meta": meta,
        })
    }).collect())
}

pub fn register_session_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        session_meta_read,
        session_meta_write,
        session_meta_list,
    ])
}
