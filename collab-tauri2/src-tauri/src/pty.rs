use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    pub id: String,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub cwd: String,
}

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
    counter: u64,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            counter: 0,
        }
    }

    pub fn create_session(
        &mut self,
        shell: &str,
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<String, Box<dyn std::error::Error>> {
        self.counter += 1;
        let id = format!("session_{}", self.counter);

        let pty_system = NativePtySystem::default();
        let mut cb = CommandBuilder::new(shell);
        cb.env("TERM", "xterm-256color");
        if let Some(c) = cwd {
            cb.cwd(c);
        }

        let pair = pty_system.openpty(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let child = pair.slave.spawn_command(cb)?;
        let writer = pair.master.take_writer()?;

        let session = PtySession {
            id: id.clone(),
            master: Arc::new(Mutex::new(pair.master)),
            child: Arc::new(Mutex::new(child)),
            writer: Arc::new(Mutex::new(writer)),
            cwd: cwd.unwrap_or(".").to_string(),
        };

        self.sessions.insert(id.clone(), session);
        Ok(id)
    }

    pub fn kill_session(&mut self, id: &str) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(session) = self.sessions.remove(id) {
            let mut child = session.child.lock().unwrap();
            let _ = child.kill();
        }
        Ok(())
    }

    pub fn write_to_session(&self, id: &str, data: &str) -> Result<(), Box<dyn std::error::Error>> {
        let session = self.sessions.get(id)
            .ok_or_else(|| format!("Session {} not found", id))?;
        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data.as_bytes())?;
        Ok(())
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> Result<(), Box<dyn std::error::Error>> {
        let session = self.sessions.get(id)
            .ok_or_else(|| format!("Session {} not found", id))?;
        let master = session.master.lock().unwrap();
        master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Option<&PtySession> {
        self.sessions.get(id)
    }

    pub fn discover_sessions(&self) -> Vec<serde_json::Value> {
        self.sessions.values().map(|s| {
            serde_json::json!({
                "id": s.id,
                "cwd": s.cwd,
            })
        }).collect()
    }
}

pub fn start_reader_thread(
    session: &PtySession,
    app: AppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    let session_id = session.id.clone();
    let master = Arc::clone(&session.master);

    thread::spawn(move || {
        let reader = {
            let m = master.lock().unwrap();
            match m.try_clone_reader() {
                Ok(r) => r,
                Err(_) => return,
            }
        };
        let mut reader = BufReader::new(reader);
        let mut buf = String::new();

        loop {
            buf.clear();
            match reader.read_line(&mut buf) {
                Ok(0) => {
                    app.emit("pty:exit", serde_json::json!({ "id": session_id })).ok();
                    break;
                }
                Ok(_) => {
                    app.emit("pty:data", serde_json::json!({
                        "id": session_id,
                        "data": buf.clone()
                    })).ok();
                }
                Err(_) => {
                    app.emit("pty:error", serde_json::json!({
                        "id": session_id,
                        "message": "Read error"
                    })).ok();
                    break;
                }
            }
        }
    });

    Ok(())
}

// Tauri commands
use serde::Deserialize;

#[derive(Deserialize)]
pub struct CreatePtyParams {
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

pub struct PtyManagerWrapper(pub Arc<Mutex<PtyManager>>);

#[tauri::command]
pub fn pty_create(
    app: AppHandle,
    state: tauri::State<PtyManagerWrapper>,
    params: CreatePtyParams,
) -> Result<String, String> {
    let mut manager = state.0.lock().unwrap();
    let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/zsh" };
    let id = manager.create_session(
        shell,
        params.cwd.as_deref(),
        params.cols.unwrap_or(80),
        params.rows.unwrap_or(24),
    ).map_err(|e| e.to_string())?;

    if let Some(session) = manager.get_session(&id) {
        let session_for_thread = PtySession {
            id: session.id.clone(),
            master: Arc::clone(&session.master),
            child: Arc::clone(&session.child),
            writer: Arc::clone(&session.writer),
            cwd: session.cwd.clone(),
        };
        start_reader_thread(&session_for_thread, app).map_err(|e| e.to_string())?;
    }

    Ok(id)
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<PtyManagerWrapper>,
    id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.0.lock().unwrap();
    manager.write_to_session(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyManagerWrapper>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = state.0.lock().unwrap();
    manager.resize_session(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(
    state: tauri::State<PtyManagerWrapper>,
    id: String,
) -> Result<(), String> {
    let mut manager = state.0.lock().unwrap();
    manager.kill_session(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_discover(
    state: tauri::State<PtyManagerWrapper>,
) -> Vec<serde_json::Value> {
    let manager = state.0.lock().unwrap();
    manager.discover_sessions()
}

pub fn register_pty_commands(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(PtyManagerWrapper(Arc::new(Mutex::new(PtyManager::new()))))
        .invoke_handler(tauri::generate_handler![
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
            pty_discover,
        ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_kill_session() {
        let mut manager = PtyManager::new();
        let id = manager.create_session("/bin/bash", None, 80, 24).unwrap();
        assert!(manager.get_session(&id).is_some());
        manager.kill_session(&id).unwrap();
        assert!(manager.get_session(&id).is_none());
    }

    #[test]
    fn test_write_to_nonexistent_session() {
        let manager = PtyManager::new();
        let result = manager.write_to_session("nonexistent", "ls\n");
        assert!(result.is_err());
    }
}
