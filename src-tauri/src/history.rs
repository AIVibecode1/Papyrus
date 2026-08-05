//! Reading history (plan 060): papers the user opened in the reader,
//! persisted as JSON in the app data directory. Recording is automatic
//! (the reader calls record_history after a PDF loads), the list is
//! capped, and it never leaves the device unless the user exports.
//! History is distinct from favorites (explicit saves) and notes.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use tauri::Manager;

const HISTORY_FILE: &str = "history.json";
/// Cap: 200 entries. The list stays small, every write stays fast, and
/// the oldest-opened entries are dropped first (by lastOpenedAt order).
const HISTORY_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHistoryEntry {
    pub paper_id: String,
    /// Denormalized so the list renders without re-fetching papers.
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub published: String,
    pub pdf_url: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub source: Option<String>,
    /// ISO timestamp of the last successful reader open.
    pub last_opened_at: String,
    /// Optional: last known page from position memory (display only).
    #[serde(default)]
    pub last_page: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
struct HistoryFile {
    version: u32,
    entries: Vec<ReadingHistoryEntry>,
}

/// Where history lives. Test hook: PAPYRUS_HISTORY_DIR overrides the app
/// data directory (tests cannot construct an AppHandle — same pattern as
/// notes.rs).
pub(crate) fn history_path(app: Option<&tauri::AppHandle>) -> PathBuf {
    if let Ok(dir) = std::env::var("PAPYRUS_HISTORY_DIR") {
        return PathBuf::from(dir).join(HISTORY_FILE);
    }
    let dir = app
        .and_then(|a| a.path().app_local_data_dir().ok())
        .unwrap_or_else(|| std::env::temp_dir().join("papyrus"));
    dir.join(HISTORY_FILE)
}

/// Reads the history file. Corrupt JSON returns an empty list — never a
/// panic and never a crash loop on startup; the next save heals the file.
fn load_history(path: &PathBuf) -> Vec<ReadingHistoryEntry> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<HistoryFile>(&text) {
        Ok(file) if file.version == 1 => file.entries,
        _ => Vec::new(),
    }
}

/// Atomic write: temp file + rename, so a crash mid-write can never
/// corrupt the only copy of the user's history.
fn save_history(path: &PathBuf, entries: &[ReadingHistoryEntry]) -> Result<(), String> {
    let body = serde_json::to_string(&HistoryFile {
        version: 1,
        entries: entries.to_vec(),
    })
    .map_err(|e| format!("Cannot serialize history: {e}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create the history folder: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body).map_err(|e| format!("Cannot write history: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("Cannot save history: {e}"))?;
    Ok(())
}

/// Field-level validation before anything touches disk. Unknown fields
/// in the incoming JSON are ignored by serde (no panic on extra data).
fn validate_entry(entry: &ReadingHistoryEntry) -> Result<(), String> {
    if entry.paper_id.trim().is_empty() || entry.title.trim().is_empty() {
        return Err("History entry needs a paper id and title".into());
    }
    if entry.paper_id.len() > 128 || entry.title.len() > 512 || entry.pdf_url.len() > 2048 {
        return Err("History entry fields are too long".into());
    }
    Ok(())
}

/// Upsert: an existing paperId moves to the top with its refreshed
/// lastOpenedAt; new entries are inserted at the top. The list is then
/// trimmed to the cap (oldest opened dropped).
fn upsert_impl(entries: &mut Vec<ReadingHistoryEntry>, entry: ReadingHistoryEntry) {
    entries.retain(|e| e.paper_id != entry.paper_id);
    entries.insert(0, entry);
    entries.truncate(HISTORY_CAP);
}

#[tauri::command]
pub fn list_history(app: tauri::AppHandle) -> Result<Vec<ReadingHistoryEntry>, String> {
    Ok(load_history(&history_path(Some(&app))))
}

/// Records (or refreshes) one entry. Failures are surfaced to the caller
/// but the frontend treats them as non-blocking: history must never get
/// in the way of opening a paper.
#[tauri::command]
pub fn record_history(app: tauri::AppHandle, entry: ReadingHistoryEntry) -> Result<(), String> {
    validate_entry(&entry)?;
    let path = history_path(Some(&app));
    let mut entries = load_history(&path);
    upsert_impl(&mut entries, entry);
    save_history(&path, &entries)
}

#[tauri::command]
pub fn remove_history_entry(app: tauri::AppHandle, paper_id: String) -> Result<(), String> {
    let path = history_path(Some(&app));
    let mut entries = load_history(&path);
    entries.retain(|e| e.paper_id != paper_id);
    save_history(&path, &entries)
}

#[tauri::command]
pub fn clear_history(app: tauri::AppHandle) -> Result<(), String> {
    let path = history_path(Some(&app));
    save_history(&path, &[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    /// Serializes tests that mutate PAPYRUS_HISTORY_DIR: parallel tests
    /// would clobber each other's env var and files (same pattern as
    /// notes.rs).
    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn temp_history_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "papyrus-history-test-{}-{name}",
            std::process::id()
        ))
    }

    fn with_temp_dir(name: &str) -> (PathBuf, std::sync::MutexGuard<'static, ()>) {
        let guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = temp_history_dir(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        unsafe {
            std::env::set_var("PAPYRUS_HISTORY_DIR", &dir);
        }
        (dir, guard)
    }

    fn sample_entry(paper_id: &str, opened_at: &str) -> ReadingHistoryEntry {
        ReadingHistoryEntry {
            paper_id: paper_id.into(),
            title: format!("Paper {paper_id}"),
            authors: vec!["A. Author".into()],
            published: "2026-01-01".into(),
            pdf_url: format!("https://arxiv.org/pdf/{paper_id}"),
            categories: vec!["cs.AI".into()],
            source: Some("arxiv".into()),
            last_opened_at: opened_at.into(),
            last_page: None,
        }
    }

    #[test]
    fn upsert_moves_existing_entry_to_the_top() {
        let mut entries = vec![sample_entry("p1", "2026-08-01T00:00:00Z")];
        upsert_impl(&mut entries, sample_entry("p2", "2026-08-02T00:00:00Z"));
        upsert_impl(&mut entries, sample_entry("p1", "2026-08-03T00:00:00Z"));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].paper_id, "p1", "reopened paper must be first");
        assert_eq!(entries[0].last_opened_at, "2026-08-03T00:00:00Z");
        assert_eq!(entries[1].paper_id, "p2");
    }

    #[test]
    fn upsert_caps_the_list_at_200() {
        let mut entries = Vec::new();
        for i in 0..250 {
            upsert_impl(
                &mut entries,
                sample_entry(&format!("p{i}"), "2026-08-01T00:00:00Z"),
            );
        }
        assert_eq!(entries.len(), HISTORY_CAP);
        // The newest (highest i) entries survive; the oldest are dropped.
        assert_eq!(entries[0].paper_id, "p249");
        assert!(!entries.iter().any(|e| e.paper_id == "p0"));
    }

    #[test]
    fn record_and_list_roundtrip_through_the_file() {
        let (dir, _guard) = with_temp_dir("roundtrip");
        let path = history_path(None);
        save_history(&path, &[sample_entry("p1", "2026-08-01T00:00:00Z")]).expect("save ok");
        let loaded = load_history(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].paper_id, "p1");
        let _ = fs::remove_dir_all(&dir);
        unsafe {
            std::env::remove_var("PAPYRUS_HISTORY_DIR");
        }
    }

    #[test]
    fn remove_and_clear_persist() {
        let (dir, _guard) = with_temp_dir("remove-clear");
        let path = history_path(None);
        let entries = vec![
            sample_entry("p1", "2026-08-01T00:00:00Z"),
            sample_entry("p2", "2026-08-02T00:00:00Z"),
        ];
        save_history(&path, &entries).expect("save ok");
        let mut pruned = load_history(&path);
        pruned.retain(|e| e.paper_id != "p1");
        save_history(&path, &pruned).expect("save ok");
        assert_eq!(load_history(&path).len(), 1);
        save_history(&path, &[]).expect("clear ok");
        assert!(load_history(&path).is_empty());
        let _ = fs::remove_dir_all(&dir);
        unsafe {
            std::env::remove_var("PAPYRUS_HISTORY_DIR");
        }
    }

    #[test]
    fn corrupt_file_loads_as_empty() {
        let (dir, _guard) = with_temp_dir("corrupt");
        let path = history_path(None);
        fs::write(&path, "not json {{").unwrap();
        assert!(load_history(&path).is_empty());
        let _ = fs::remove_dir_all(&dir);
        unsafe {
            std::env::remove_var("PAPYRUS_HISTORY_DIR");
        }
    }

    #[test]
    fn validation_rejects_empty_paper_id() {
        let err = validate_entry(&sample_entry("", "2026-08-01T00:00:00Z")).expect_err("must fail");
        assert!(err.contains("paper id"), "got: {err}");
    }
}
