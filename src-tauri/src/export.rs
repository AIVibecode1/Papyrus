//! Data export: writes the user's saved data (favorites, chat transcripts)
//! to a timestamped JSON file in the Documents folder. The payload comes
//! from the frontend but is validated as JSON here — it is never eval'd,
//! and the destination path is server-chosen (the frontend cannot write
//! anywhere).

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Where exports land. Test hook: PAPYRUS_EXPORT_DIR overrides the
/// Documents folder (tests cannot construct an AppHandle).
fn export_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PAPYRUS_EXPORT_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return PathBuf::from(profile).join("Documents");
    }
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Documents")
}

/// Writes an export payload to `Documents/papyrus-export-<ms>.json` and
/// returns the absolute path. The payload must be valid JSON.
#[tauri::command]
pub fn export_data(payload: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|e| format!("Invalid export payload: {e}"))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = export_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the export folder: {e}"))?;
    let path = dir.join(format!("papyrus-export-{stamp}.json"));
    fs::write(&path, payload).map_err(|e| format!("Cannot write the export file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_writes_a_timestamped_json_file() {
        let dir = std::env::temp_dir().join(format!("papyrus-export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        unsafe {
            std::env::set_var("PAPYRUS_EXPORT_DIR", &dir);
        }

        let path = export_data(r#"{"app":"papyrus","favorites":[]}"#.into()).expect("export ok");

        assert!(path.starts_with(dir.to_string_lossy().as_ref()));
        let written = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(value["app"], "papyrus");
        assert_eq!(value["favorites"].as_array().unwrap().len(), 0);

        let _ = fs::remove_dir_all(&dir);
        unsafe {
            std::env::remove_var("PAPYRUS_EXPORT_DIR");
        }
    }

    #[test]
    fn export_rejects_invalid_json() {
        let err = export_data("not json {{".into()).expect_err("invalid payload");
        assert!(err.contains("Invalid export payload"), "got: {err}");
    }
}
