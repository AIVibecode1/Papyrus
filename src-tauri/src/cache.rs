use std::fs;
use std::path::Path;

use tauri::{AppHandle, Manager};

/// Empties a cache directory, recreating it so later writes keep working.
/// A missing directory is not an error.
fn clear_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| format!("Cannot clear the cache directory: {e}"))?;
    }
    fs::create_dir_all(dir).map_err(|e| format!("Cannot recreate the cache directory: {e}"))
}

/// Wipes the on-disk caches (downloaded PDFs, the citation cache and the
/// user's notes) while leaving every user setting, provider and API key
/// untouched. Called from the Settings "Clear cache and saved data"
/// action — notes are authored user data, but the button explicitly
/// clears saved data too.
#[tauri::command]
pub fn clear_app_cache(app: AppHandle) -> Result<(), String> {
    let pdf_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data directory unavailable: {e}"))?
        .join(crate::pdf::PDF_CACHE_DIR);
    clear_dir(&pdf_dir)?;

    let citation_file = crate::citations::cache_path(Some(&app));
    if citation_file.exists() {
        fs::remove_file(&citation_file)
            .map_err(|e| format!("Cannot clear the citation cache: {e}"))?;
    }

    let notes_file = crate::notes::notes_path(Some(&app));
    if notes_file.exists() {
        fs::remove_file(&notes_file).map_err(|e| format!("Cannot clear the notes: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "papyrus-clear-cache-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn clear_dir_removes_files_recursively_and_recreates() {
        let dir = temp_dir();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.pdf"), b"x").unwrap();
        fs::write(dir.join("sub/b.pdf"), b"y").unwrap();

        clear_dir(&dir).unwrap();

        assert!(dir.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        // The cache keeps working after the wipe.
        fs::write(dir.join("new.pdf"), b"z").unwrap();
        assert!(dir.join("new.pdf").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_dir_tolerates_a_missing_directory() {
        let dir = temp_dir().join("does-not-exist");
        clear_dir(&dir).unwrap();
        assert!(dir.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
