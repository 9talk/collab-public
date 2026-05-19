use std::fs;
use std::path::PathBuf;

#[tauri::command]
pub fn install_cli(cli_path: String, bin_dir: String) -> Result<(), String> {
    let src = PathBuf::from(&cli_path);
    if !src.exists() {
        return Err(format!("CLI source not found at: {}", cli_path));
    }

    let dest_dir = PathBuf::from(&bin_dir);
    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    }

    let dest = dest_dir.join("collab");
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dest)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn cli_installed(bin_dir: String) -> bool {
    PathBuf::from(bin_dir).join("collab").exists()
}

#[tauri::command]
pub fn remove_cli(bin_dir: String) -> Result<(), String> {
    let path = PathBuf::from(bin_dir).join("collab");
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn register_cli_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        install_cli,
        cli_installed,
        remove_cli,
    ])
}
