use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn workspaces_file() -> PathBuf {
    let dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.join("collaborator/workspaces.json")
}

#[tauri::command]
pub fn workspace_list() -> Result<Vec<WorkspaceConfig>, String> {
    let path = workspaces_file();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let workspaces: Vec<WorkspaceConfig> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(workspaces)
}

#[tauri::command]
pub fn workspace_add(
    name: String,
    path: String,
) -> Result<WorkspaceConfig, String> {
    let mut workspaces = workspace_list()?;
    let id = format!("ws_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    let workspace = WorkspaceConfig {
        id,
        name,
        path,
        created_at: now.clone(),
        updated_at: now,
    };
    workspaces.push(workspace.clone());
    let content = serde_json::to_string_pretty(&workspaces).map_err(|e| e.to_string())?;
    fs::write(workspaces_file(), content).map_err(|e| e.to_string())?;
    Ok(workspace)
}

#[tauri::command]
pub fn workspace_remove(id: String) -> Result<(), String> {
    let mut workspaces = workspace_list()?;
    workspaces.retain(|w| w.id != id);
    let content = serde_json::to_string_pretty(&workspaces).map_err(|e| e.to_string())?;
    fs::write(workspaces_file(), content).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn register_workspace_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        workspace_list,
        workspace_add,
        workspace_remove,
    ])
}
