use std::process::Command;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct AgentProcess {
    pub handle: std::process::Child,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.handle.kill();
    }
}

#[tauri::command]
pub fn agent_start(
    state: tauri::State<Arc<Mutex<Option<AgentProcess>>>>,
    executable: String,
    workspace: String,
) -> Result<String, String> {
    let child = Command::new(&executable)
        .arg("--workspace")
        .arg(&workspace)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let pid = child.id();
    let mut proc_state = state.inner().blocking_lock();
    *proc_state = Some(AgentProcess { handle: child });
    Ok(format!("Agent started with PID {}", pid))
}

#[tauri::command]
pub fn agent_stop(
    state: tauri::State<Arc<Mutex<Option<AgentProcess>>>>,
) -> Result<(), String> {
    let mut proc_state = state.inner().blocking_lock();
    if let Some(proc) = proc_state.take() {
        drop(proc); // Drop impl kills the process
    }
    Ok(())
}

#[tauri::command]
pub fn agent_running(
    state: tauri::State<Arc<Mutex<Option<AgentProcess>>>>,
) -> bool {
    let proc_state = state.inner().blocking_lock();
    proc_state.is_some()
}

pub fn register_acp_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        agent_start,
        agent_stop,
        agent_running,
    ])
}
