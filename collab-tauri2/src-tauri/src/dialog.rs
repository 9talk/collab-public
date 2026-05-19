use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn open_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app.dialog().file().blocking_pick_folder();
    Ok(result.map(|p| path_to_string(p)))
}

#[tauri::command]
pub fn open_file_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app.dialog().file().blocking_pick_file();
    Ok(result.map(|p| path_to_string(p)))
}

#[tauri::command]
pub fn open_image_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app.dialog().file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"])
        .blocking_pick_file();
    Ok(result.map(|p| path_to_string(p)))
}

fn path_to_string(path: tauri_plugin_dialog::FilePath) -> String {
    match path {
        tauri_plugin_dialog::FilePath::Path(p) => p.to_string_lossy().to_string(),
        tauri_plugin_dialog::FilePath::Url(u) => u.to_string(),
    }
}

#[tauri::command]
pub fn show_notification(title: String, body: String) {
    log::info!("[notification] {}: {}", title, body);
}

pub fn register_dialog_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        open_folder_dialog,
        open_file_dialog,
        open_image_dialog,
        show_notification,
    ])
}
