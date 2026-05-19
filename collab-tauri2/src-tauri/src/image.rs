use image::GenericImageView;
use std::path::PathBuf;

#[tauri::command]
pub fn image_info(path: String) -> Result<serde_json::Value, String> {
    let img = image::open(&path).map_err(|e| e.to_string())?;
    let (width, height) = img.dimensions();
    Ok(serde_json::json!({
        "width": width,
        "height": height,
    }))
}

#[tauri::command]
pub fn resize_image(
    path: String,
    output: String,
    max_width: u32,
    max_height: u32,
) -> Result<(), String> {
    let img = image::open(&path).map_err(|e| e.to_string())?;
    let (w, h) = img.dimensions();
    let ratio = (w as f64 / h as f64).min(1.0);
    let new_w = (max_width as f64 * ratio).min(w as f64) as u32;
    let new_h = (max_height as f64 * ratio).min(h as f64) as u32;
    let resized = img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3);
    resized.save(&output).map_err(|e| e.to_string())
}

pub fn register_image_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        image_info,
        resize_image,
    ])
}
