mod ai;
mod cache;
mod citations;
mod export;
mod history;
mod notes;
mod papers;
mod pdf;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            papers::fetch_papers,
            citations::fetch_citations,
            ai::commands::explain_paper,
            ai::commands::explain_section,
            ai::commands::explain_synthesis,
            ai::commands::ask_about_paper,
            ai::commands::test_provider,
            ai::commands::stop_explaining,
            ai::commands::save_api_key,
            ai::commands::delete_api_key,
            ai::commands::has_api_key,
            pdf::fetch_pdf,
            cache::clear_app_cache,
            export::export_data,
            export::import_data,
            notes::list_notes,
            notes::upsert_note,
            notes::delete_note,
            history::list_history,
            history::record_history,
            history::remove_history_entry,
            history::clear_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
