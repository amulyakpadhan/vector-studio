// Bare shell for now — wraps the same apps/web build the browser gets, with no Rust-side
// commands yet. Per ARCHITECTURE.md's Phase 3 plan, this is where the local HTTP proxy (no
// CORS constraints, replacing the separate `pnpm bridge` process the web app needs today) and
// OS-keychain credential storage will be added as `#[tauri::command]`s.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
