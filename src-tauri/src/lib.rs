mod ai;
mod citations;
mod papers;
mod pdf;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            papers::fetch_papers,
            citations::fetch_citations,
            ai::explain_paper,
            ai::explain_section,
            ai::explain_synthesis,
            ai::ask_about_paper,
            ai::test_provider,
            ai::stop_explaining,
            ai::save_api_key,
            ai::delete_api_key,
            ai::has_api_key,
            pdf::fetch_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
