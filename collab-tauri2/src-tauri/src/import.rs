use reqwest::Client;
use scraper::{Html, Selector};

#[tauri::command]
pub async fn import_web_article(url: String) -> Result<serde_json::Value, String> {
    let client = Client::new();
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let html = response.text().await.map_err(|e| e.to_string())?;

    let document = Html::parse_document(&html);
    let title_selector = Selector::parse("title").unwrap();
    let body_selector = Selector::parse("body").unwrap();

    let title = document
        .select(&title_selector)
        .next()
        .map(|el| el.text().collect::<String>())
        .unwrap_or_default();

    let body = document
        .select(&body_selector)
        .next()
        .map(|el| el.text().collect::<String>())
        .unwrap_or_default();

    // Simple text extraction - remove excessive whitespace
    let cleaned = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    Ok(serde_json::json!({
        "title": title,
        "content": cleaned,
        "url": url,
    }))
}

pub fn register_import_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![import_web_article])
}
