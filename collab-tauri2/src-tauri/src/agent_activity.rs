use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInteraction {
    pub file_path: String,
    pub touch_type: String, // "read" or "write"
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub session_id: String,
    pub cwd: String,
    pub started_at: u64,
    pub interactions: Vec<AgentInteraction>,
    pub pty_session_id: Option<String>,
}

pub struct AgentActivityState {
    sessions: HashMap<String, AgentSession>,
}

impl AgentActivityState {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn start_session(&mut self, session_id: String, cwd: String, pty_session_id: Option<String>) {
        self.sessions.insert(session_id.clone(), AgentSession {
            session_id,
            cwd,
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            interactions: Vec::new(),
            pty_session_id,
        });
    }

    pub fn end_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub fn record_interaction(&mut self, session_id: &str, file_path: String, touch_type: String) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.interactions.push(AgentInteraction {
                file_path,
                touch_type,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
        }
    }

    pub fn get_sessions(&self) -> Vec<AgentSession> {
        self.sessions.values().cloned().collect()
    }
}

#[tauri::command]
pub fn agent_session_start(
    state: tauri::State<Mutex<AgentActivityState>>,
    session_id: String,
    cwd: String,
    pty_session_id: Option<String>,
) {
    let mut s = state.lock().unwrap();
    s.start_session(session_id, cwd, pty_session_id);
}

#[tauri::command]
pub fn agent_session_end(
    state: tauri::State<Mutex<AgentActivityState>>,
    session_id: String,
) {
    let mut s = state.lock().unwrap();
    s.end_session(&session_id);
}

#[tauri::command]
pub fn agent_record_interaction(
    state: tauri::State<Mutex<AgentActivityState>>,
    session_id: String,
    file_path: String,
    touch_type: String,
) {
    let mut s = state.lock().unwrap();
    s.record_interaction(&session_id, file_path, touch_type);
}

#[tauri::command]
pub fn agent_get_sessions(
    state: tauri::State<Mutex<AgentActivityState>>,
) -> Vec<AgentSession> {
    let s = state.lock().unwrap();
    s.get_sessions()
}

pub fn register_agent_activity_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        agent_session_start,
        agent_session_end,
        agent_record_interaction,
        agent_get_sessions,
    ])
}
