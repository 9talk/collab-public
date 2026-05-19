use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct FileStat {
    pub ctime: String,
    pub mtime: String,
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_file_binary(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<FileInfo>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let path = entry.path();

        files.push(FileInfo {
            path: path.to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    Ok(files)
}

#[tauri::command]
pub fn get_home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

#[tauri::command]
pub fn count_files(path: String) -> Result<u64, String> {
    let path = PathBuf::from(&path);
    let mut count: u64 = 0;
    for entry in walkdir(&path) {
        if entry.path().is_file() {
            count += 1;
        }
    }
    Ok(count)
}

fn walkdir(dir: &PathBuf) -> Vec<std::fs::DirEntry> {
    let mut entries = Vec::new();
    if let Ok(read_dir) = fs::read_dir(dir) {
        for entry in read_dir {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_dir() && entry.file_name() != ".git" && entry.file_name() != "node_modules" {
                    entries.extend(walkdir(&path));
                }
                if path.is_file() {
                    entries.push(entry);
                }
            }
        }
    }
    entries
}

#[tauri::command]
pub fn is_directory(path: String) -> bool {
    PathBuf::from(&path).is_dir()
}

#[tauri::command]
pub fn file_stat(path: String) -> Result<FileStat, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    let ctime = metadata.created().unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();
    let mtime = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();
    Ok(FileStat {
        ctime: chrono::DateTime::from_timestamp(ctime as i64, 0)
            .unwrap_or_default().to_rfc3339(),
        mtime: chrono::DateTime::from_timestamp(mtime as i64, 0)
            .unwrap_or_default().to_rfc3339(),
    })
}

#[tauri::command]
pub fn rename_file(old_path: String, new_title: String) -> Result<String, String> {
    let old = PathBuf::from(&old_path);
    if !old.exists() {
        return Err(format!("File not found: {}", old_path));
    }
    let parent = old.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let ext = old.extension().and_then(|e| e.to_str()).unwrap_or("");
    let sanitized: String = new_title
        .chars()
        .filter(|c| {
            !['<', '>', ':', '"', '/', '\\', '|', '?', '*'].contains(c) && *c as u32 > 0x1f
        })
        .collect::<String>()
        .trim_end_matches(|c: char| c.is_whitespace() || c == '.')
        .to_string();
    if sanitized.is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    let new_path = if ext.is_empty() {
        parent.join(&sanitized)
    } else {
        parent.join(format!("{}.{}", sanitized, ext))
    };
    fs::rename(&old, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn trash_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or("Home dir not found")?;
        let trash_dir = home.join(".Trash");
        let file_name = PathBuf::from(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let dest = trash_dir.join(&file_name);
        if dest.exists() {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let dest = trash_dir.join(format!("{}_{}", timestamp, file_name));
            fs::rename(&path, &dest).map_err(|e| e.to_string())?;
        } else {
            fs::rename(&path, &dest).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        fs::remove_file(&path)
            .or_else(|_| fs::remove_dir_all(&path))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn make_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn register_fs_commands(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        read_file,
        read_file_binary,
        write_file,
        list_dir,
        get_home_dir,
        exists,
        count_files,
        is_directory,
        file_stat,
        rename_file,
        trash_file,
        make_directory,
        get_app_version,
    ])
}
