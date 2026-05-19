use serde::Deserialize;

#[derive(Deserialize)]
pub struct HttpRequest {
    pub url: String,
    pub method: Option<String>,
    pub body: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
}

#[tauri::command]
pub async fn http_request(
    req: HttpRequest,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let method = req.method.as_deref().unwrap_or("GET");
    let mut builder = match method {
        "GET" => client.get(&req.url),
        "POST" => {
            let mut b = client.post(&req.url);
            if let Some(body) = &req.body {
                b = b.body(body.clone());
            }
            b
        }
        "PUT" => {
            let mut b = client.put(&req.url);
            if let Some(body) = &req.body {
                b = b.body(body.clone());
            }
            b
        }
        "DELETE" => client.delete(&req.url),
        _ => return Err(format!("Unsupported method: {}", method)),
    };

    if let Some(headers) = &req.headers {
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
    }

    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "status": status,
        "body": body,
    }))
}

pub fn register_integrations_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![http_request])
}
