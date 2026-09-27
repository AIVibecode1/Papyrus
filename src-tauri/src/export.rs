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
    if let Some(dir) = crate::test_hooks::test_env("PAPYRUS_EXPORT_DIR") {
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
/// report "imported N papers, M chats and K notes".
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub app: String,
    pub favorites: usize,
    pub chats: usize,
    pub notes: usize,
    pub reading_history: usize,
}

/// Plan 072: hard cap for import payloads (5 MiB). Import parses only
/// bounded input so a multi-hundred-MB paste cannot freeze the UI or
/// spike memory; exports stay well below this in practice.
const MAX_IMPORT_BYTES: usize = 5 * 1024 * 1024;

/// The import policy is fail-whole-file: a malformed section rejects the
/// entire import with a message naming the offending field, so partially
/// valid data can never be applied as trusted. Missing sections are
/// treated as empty (older exports remain importable).
fn require_string(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("Invalid import payload: {key} must be a string"))
}

fn validate_favorites(value: &serde_json::Value) -> Result<usize, String> {
    let arr = value
        .as_array()
        .ok_or("Invalid import payload: favorites must be an array")?;
    for item in arr {
        let obj = item
            .as_object()
            .ok_or("Invalid import payload: favorites entries must be objects")?;
        require_string(obj, "id")?;
        require_string(obj, "title")?;
    }
    Ok(arr.len())
}

fn validate_notes(value: &serde_json::Value) -> Result<usize, String> {
    let arr = value
        .as_array()
        .ok_or("Invalid import payload: notes must be an array")?;
    for item in arr {
        let obj = item
            .as_object()
            .ok_or("Invalid import payload: notes entries must be objects")?;
        require_string(obj, "id")?;
        require_string(obj, "paperId")?;
        require_string(obj, "updatedAt")?;
    }
    Ok(arr.len())
}

fn validate_reading_history(value: &serde_json::Value) -> Result<usize, String> {
    let arr = value
        .as_array()
        .ok_or("Invalid import payload: readingHistory must be an array")?;
    for item in arr {
        let obj = item
            .as_object()
            .ok_or("Invalid import payload: readingHistory entries must be objects")?;
        require_string(obj, "paperId")?;
        require_string(obj, "title")?;
        require_string(obj, "lastOpenedAt")?;
    }
    Ok(arr.len())
}

fn validate_chat(value: &serde_json::Value) -> Result<usize, String> {
    let obj = value
        .as_object()
        .ok_or("Invalid import payload: chat must be an object")?;
    for (paper_id, turns) in obj {
        let arr = turns
            .as_array()
            .ok_or_else(|| format!("Invalid import payload: chat[{paper_id}] must be an array"))?;
        for turn in arr {
            let t = turn.as_object().ok_or_else(|| {
                format!("Invalid import payload: chat[{paper_id}] entries must be objects")
            })?;
            let role = require_string(t, "role")?;
            if role != "user" && role != "assistant" {
                return Err(format!(
                    "Invalid import payload: chat[{paper_id}] role must be user or assistant"
                ));
            }
            require_string(t, "content")?;
        }
    }
    Ok(obj.len())
}

/// Validates a Papyrus export payload and reports its contents. The
/// payload is parsed as data only — never executed — and must carry the
/// `app: "papyrus"` marker. Keys are never part of an export, so there
/// is nothing secret to restore here.
#[tauri::command]
pub fn import_data(payload: String) -> Result<ImportSummary, String> {
    if payload.len() > MAX_IMPORT_BYTES {
        return Err("Import payload is too large (max 5 MB)".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("Invalid import payload: {e}"))?;
    if value.get("app").and_then(|v| v.as_str()) != Some("papyrus") {
        return Err("Not a Papyrus export file".into());
    }
    let favorites = match value.get("favorites") {
        Some(v) => validate_favorites(v)?,
        None => 0,
    };
    let chats = match value.get("chat") {
        Some(v) => validate_chat(v)?,
        None => 0,
    };
    let notes = match value.get("notes") {
        Some(v) => validate_notes(v)?,
        None => 0,
    };
    let reading_history = match value.get("readingHistory") {
        Some(v) => validate_reading_history(v)?,
        None => 0,
    };
    Ok(ImportSummary {
        app: "papyrus".into(),
        favorites,
        chats,
        notes,
        reading_history,
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
        let payload = r#"{"app":"papyrus","exportedAt":"2026-08-04T00:00:00Z","favorites":[{"id":"a1","title":"One"},{"id":"a2","title":"Two"}],"chat":{"p1":[]},"notes":[{"id":"n1","paperId":"p1","updatedAt":"2026-08-04T00:00:00Z"},{"id":"n2","paperId":"p1","updatedAt":"2026-08-04T00:00:01Z"},{"id":"n3","paperId":"p2","updatedAt":"2026-08-04T00:00:02Z"}],"readingHistory":[{"paperId":"a1","title":"One","lastOpenedAt":"2026-08-04T00:00:00Z"}]}"#;
        let summary = import_data(payload.into()).expect("valid payload imports");
        assert_eq!(summary.app, "papyrus");
        assert_eq!(summary.favorites, 2);
        assert_eq!(summary.chats, 1);
        assert_eq!(summary.notes, 3);
        assert_eq!(summary.reading_history, 1);
    }

    #[test]
    fn import_rejects_non_papyrus_and_invalid_json() {
        let err = import_data(r#"{"app":"other"}"#.into()).expect_err("wrong app marker");
        assert!(err.contains("Not a Papyrus export"), "got: {err}");

        let err = import_data("garbage {{".into()).expect_err("invalid json");
        assert!(err.contains("Invalid import payload"), "got: {err}");
    }

    #[test]
    fn import_rejects_oversize_payloads() {
        // A valid JSON body padded past the 5 MiB cap (plan 072).
        let mut payload = String::from(r#"{"app":"papyrus","favorites":["#);
        payload.push_str(&"\"x\",".repeat(MAX_IMPORT_BYTES / 4));
        payload.push_str("\"y\"]}");
        let err = import_data(payload).expect_err("oversize payload must fail");
        assert!(err.contains("too large"), "got: {err}");
    }

    #[test]
    fn import_rejects_non_array_favorites() {
        let err = import_data(r#"{"app":"papyrus","favorites":{}}"#.into())
            .expect_err("favorites must be an array");
        assert!(err.contains("favorites must be an array"), "got: {err}");
    }

    #[test]
    fn import_rejects_favorites_missing_id_or_title() {
        let err = import_data(r#"{"app":"papyrus","favorites":[{"id":"a1"}]}"#.into())
            .expect_err("title missing");
        assert!(err.contains("title must be a string"), "got: {err}");

        let err = import_data(r#"{"app":"papyrus","favorites":[{"title":"One"}]}"#.into())
            .expect_err("id missing");
        assert!(err.contains("id must be a string"), "got: {err}");
    }

    #[test]
    fn import_rejects_malformed_notes_and_history() {
        let err = import_data(r#"{"app":"papyrus","notes":[{"id":"n1","paperId":"p1"}]}"#.into())
            .expect_err("note updatedAt missing");
        assert!(err.contains("updatedAt must be a string"), "got: {err}");

        let err = import_data(
            r#"{"app":"papyrus","readingHistory":[{"paperId":"a1","title":"One"}]}"#.into(),
        )
        .expect_err("history lastOpenedAt missing");
        assert!(err.contains("lastOpenedAt must be a string"), "got: {err}");
    }

    #[test]
    fn import_rejects_bad_chat_roles_and_shapes() {
        let err = import_data(
            r#"{"app":"papyrus","chat":{"p1":[{"role":"system","content":"x"}]}}"#.into(),
        )
        .expect_err("role must be user or assistant");
        assert!(err.contains("role must be user or assistant"), "got: {err}");

        let err = import_data(r#"{"app":"papyrus","chat":{"p1":{}}}"#.into())
            .expect_err("chat value must be an array");
        assert!(err.contains("chat[p1] must be an array"), "got: {err}");
    }

    #[test]
    fn import_accepts_missing_sections_as_empty() {
        let summary = import_data(r#"{"app":"papyrus"}"#.into()).expect("minimal export imports");
        assert_eq!(summary.favorites, 0);
        assert_eq!(summary.chats, 0);
        assert_eq!(summary.notes, 0);
        assert_eq!(summary.reading_history, 0);
    }
}
