// Desktop shell entry point.
//
// For now this just boots the window and serves the studio's static export
// (apps/web/out) as the frontend — no bridge or keychain wiring yet. Those
// are the next slices: porting the local bridge's proxy logic here (or
// running it as a sidecar) so self-hosted/CORS-restricted DBs work without a
// second terminal, and swapping localStorage credentials for the OS keychain.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Vyn Studio desktop");
}
