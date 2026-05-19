use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("Path does not exist: {}", path_buf.display()));
    }

    let (tx, rx) = mpsc::channel();

    let mut watcher: RecommendedWatcher =
        Watcher::new(tx, Config::default()).map_err(|e| e.to_string())?;

    watcher
        .watch(
            &path_buf,
            if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        )
        .map_err(|e| e.to_string())?;

    thread::spawn(move || {
        for event in rx {
            match event {
                Ok(event) => {
                    for event_path in event.paths {
                        let kind = match event.kind {
                            notify::EventKind::Create(_) => "created",
                            notify::EventKind::Modify(_) => "modified",
                            notify::EventKind::Remove(_) => "deleted",
                            _ => "other",
                        };
                        app.emit(
                            "file:changed",
                            serde_json::json!({
                                "path": event_path.to_string_lossy(),
                                "kind": kind,
                            }),
                        )
                        .ok();
                    }
                }
                Err(e) => {
                    app.emit(
                        "file:error",
                        serde_json::json!({
                            "message": e.to_string()
                        }),
                    )
                    .ok();
                }
            }
        }
    });

    Ok(())
}

pub fn register_watcher_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![watch_start])
}
