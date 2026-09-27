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

/// Removes a file if it is there. Missing is success.
fn remove_if_present(path: &Path, what: &str) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Cannot clear {what}: {e}"))?;
    }
    Ok(())
}

/// Wipes the on-disk caches (downloaded PDFs, the citation cache and the
/// user's notes) while leaving every user setting, provider and API key
/// untouched. Called from the Settings "Clear cache and saved data"
/// action — notes are authored user data, but the button explicitly
/// clears saved data too.
///
/// Every step is attempted even if an earlier one fails, and the first error
/// is reported at the end. Chaining `?` meant one locked directory aborted
/// the rest, so a single unreadable PDF cache silently left the user's notes
/// and history on disk after they asked for them to be cleared.
#[tauri::command]
pub fn clear_app_cache(app: AppHandle) -> Result<(), String> {
    let mut first_error: Option<String> = None;
    let mut record = |r: Result<(), String>| {
        if let Err(e) = r
            && first_error.is_none()
        {
            first_error = Some(e);
        }
    };

    match app.path().app_data_dir() {
        Ok(dir) => record(clear_dir(&dir.join(crate::pdf::PDF_CACHE_DIR))),
        Err(e) => record(Err(format!("App data directory unavailable: {e}"))),
    }

    // The process-global citation cache is separate from the file: without
    // this, counts kept being served from memory until the app restarted, so
    // "cleared" did not mean cleared.
    record(crate::citations::clear_memory_cache());
    record(remove_if_present(
        &crate::citations::cache_path(Some(&app)),
        "the citation cache",
    ));
    record(remove_if_present(
        &crate::notes::notes_path(Some(&app)),
        "the notes",
    ));
    // Reading history is saved data like notes: the big clear wipes it,
    // while Settings also offers a dedicated history-only clear.
    record(remove_if_present(
        &crate::history::history_path(Some(&app)),
        "the history",
    ));

    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
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
