// Wraps the same apps/web build the browser gets. The one Rust-side command,
// http_fetch, is the local-bridge replacement promised in ARCHITECTURE.md's
// Phase 3 plan: a native HTTP client has no concept of browser CORS, so
// self-hosted/CORS-restricted vector DBs are reachable directly from here,
// without the separate `pnpm bridge` process the web app needs in a browser.
// OS-keychain credential storage is still unbuilt — that's the other
// Phase 3 piece, tracked separately.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct FetchRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Serialize)]
struct FetchResponse {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    headers: HashMap<String, String>,
    body: String,
}

/// Makes an HTTP request from the Rust process rather than the webview, so it's
/// never subject to a target server's CORS policy. Mirrors just enough of the
/// browser `Response` shape (status/statusText/headers/body) for the frontend
/// to reconstruct a real `Response` object from it.
#[tauri::command]
async fn http_fetch(req: FetchRequest) -> Result<FetchResponse, String> {
    let client = reqwest::Client::new();
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;

    let mut builder = client.request(method, &req.url);
    for (key, value) in &req.headers {
        builder = builder.header(key, value);
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or_default()
        .to_string();

    let mut headers = HashMap::new();
    for (key, value) in resp.headers().iter() {
        if let Ok(v) = value.to_str() {
            headers.insert(key.to_string(), v.to_string());
        }
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(FetchResponse {
        status,
        status_text,
        headers,
        body,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![http_fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
