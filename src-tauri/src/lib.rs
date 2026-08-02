mod ai;
mod papers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_keyring::init())
        .invoke_handler(tauri::generate_handler![
            papers::fetch_papers,
            ai::explain_paper,
            ai::test_provider,
            ai::stop_explaining,
            ai::save_api_key,
            ai::delete_api_key,
            ai::has_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
