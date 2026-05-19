use tauri_plugin_updater::UpdaterExt;

pub async fn check_and_install(app: tauri::AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    if let Some(update) = update {
        let mut downloaded = 0;
        update
            .download_and_install(
                |chunk_length, content_length| {
                    downloaded += chunk_length;
                    if let Some(total) = content_length {
                        log::info!("Downloaded {downloaded}/{total}");
                    }
                },
                || {
                    log::info!("Download finished, installing update...");
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        return Ok(true);
    }

    Ok(false)
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    if let Some(update) = update {
        Ok(Some(format!(
            "v{} available ({})",
            update.version, update.body.as_deref().unwrap_or("No details")
        )))
    } else {
        Ok(None)
    }
}

pub fn register_updater_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![check_for_updates])
}
