// Reference shell: not compiled in CI. One plugin, `opener`; the capability file grants it
// `opener:allow-open-url` for https only. The Rust bridge to the SDK is not shipped.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Tidewater Studio");
}
