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

/// What the import validated and how much data it carries, so the UI can
/// report "imported N papers and M chats".
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub app: String,
    pub favorites: usize,
    pub chats: usize,
}

/// Validates a Papyrus export payload and reports its contents. The
/// payload is parsed as data only — never executed — and must carry the
/// `app: "papyrus"` marker. Keys are never part of an export, so there
/// is nothing secret to restore here.
#[tauri::command]
pub fn import_data(payload: String) -> Result<ImportSummary, String> {
    let value: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("Invalid import payload: {e}"))?;
    if value.get("app").and_then(|v| v.as_str()) != Some("papyrus") {
        return Err("Not a Papyrus export file".into());
    }
    let favorites = value
        .get("favorites")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let chats = value
        .get("chat")
        .and_then(|v| v.as_object())
        .map(|o| o.len())
        .unwrap_or(0);
    Ok(ImportSummary {
        app: "papyrus".into(),
        favorites,
        chats,
    })
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

    #[test]
    fn import_validates_the_payload_and_reports_counts() {
        let payload = r#"{"app":"papyrus","exportedAt":"2026-08-04T00:00:00Z","favorites":[{"id":"a1"},{"id":"a2"}],"chat":{"p1":[]}}"#;
        let summary = import_data(payload.into()).expect("valid payload imports");
        assert_eq!(summary.app, "papyrus");
        assert_eq!(summary.favorites, 2);
        assert_eq!(summary.chats, 1);
    }

    #[test]
    fn import_rejects_non_papyrus_and_invalid_json() {
        let err = import_data(r#"{"app":"other"}"#.into()).expect_err("wrong app marker");
        assert!(err.contains("Not a Papyrus export"), "got: {err}");

        let err = import_data("garbage {{".into()).expect_err("invalid json");
        assert!(err.contains("Invalid import payload"), "got: {err}");
    }
}
