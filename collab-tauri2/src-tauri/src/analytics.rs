use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct Analytics {
    client: Client,
    api_key: String,
    device_id: String,
}

impl Analytics {
    pub fn new(api_key: &str, device_id: &str) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
            device_id: device_id.to_string(),
        }
    }

    pub async fn track(&self, event: &str, properties: Option<serde_json::Value>) {
        let payload = json!({
            "api_key": self.api_key,
            "event": event,
            "distinct_id": self.device_id,
            "properties": properties.unwrap_or_default(),
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        self.client
            .post("https://app.posthog.com/capture/")
            .json(&payload)
            .send()
            .await
            .ok();
    }
}

#[tauri::command]
pub async fn analytics_track(
    state: tauri::State<'_, Arc<Mutex<Analytics>>>,
    event: String,
    properties: Option<serde_json::Value>,
) -> Result<(), String> {
    let analytics = state.lock().await;
    analytics.track(&event, properties).await;
    Ok(())
}

pub fn register_analytics_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![analytics_track])
}
