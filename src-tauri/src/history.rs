//! Reading history (plan 060): papers the user opened in the reader,
//! persisted as JSON in the app data directory. Recording is automatic
//! (the reader calls record_history after a PDF loads), the list is
//! capped, and it never leaves the device unless the user exports.
//! History is distinct from favorites (explicit saves) and notes.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use tauri::Manager;

const HISTORY_FILE: &str = "history.json";
/// Cap: 200 entries. The list stays small, every write stays fast, and
/// the oldest-opened entries are dropped first (by lastOpenedAt order).
const HISTORY_CAP: usize = 200;
/// Upper bound on one import batch. An export never exceeds HISTORY_CAP,
/// so this only rejects a hand-edited or corrupt file.
const MAX_IMPORT_ENTRIES: usize = 5_000;

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
    if let Some(dir) = crate::test_hooks::test_env("PAPYRUS_HISTORY_DIR") {
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

/// Serializes the load-modify-save cycle across every history command.
///
/// Without this, two commands that overlap (the webview fires
/// `record_history` fire-and-forget whenever a paper opens, and
/// `clear_history`/`remove_history_entry` can land at the same moment)
/// each read the file, each write it, and the later write silently drops
/// the earlier one. Same rationale as `notes_lock` in notes.rs.
fn history_lock() -> &'static Mutex<()> {
    static HISTORY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    HISTORY_LOCK.get_or_init(|| Mutex::new(()))
}

/// Merges an import batch into the stored history, resolving same-paperId
/// entries by newer `last_opened_at` and keeping the cap. Returns the
/// merged, most-recent-first list. Pure, so it is tested without an
/// AppHandle.
///
/// Note this deliberately differs from `upsert_impl` (move-to-top): an
/// import must not reshuffle the user's list, only update and extend it.
fn merge_import(
    current: Vec<ReadingHistoryEntry>,
    incoming: Vec<ReadingHistoryEntry>,
) -> Vec<ReadingHistoryEntry> {
    // Map-indexed so the merge is linear; a linear scan per entry made it
    // quadratic, which is the cost this command exists to remove.
    let mut by_id: HashMap<String, ReadingHistoryEntry> =
        HashMap::with_capacity(current.len() + incoming.len());
    for entry in current {
        by_id.insert(entry.paper_id.clone(), entry);
    }
    for entry in incoming {
        match by_id.get(&entry.paper_id) {
            Some(existing) if existing.last_opened_at > entry.last_opened_at => {}
            _ => {
                by_id.insert(entry.paper_id.clone(), entry);
            }
        }
    }
    let mut merged: Vec<ReadingHistoryEntry> = by_id.into_values().collect();
    merged.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    merged.truncate(HISTORY_CAP);
    merged
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
    let _guard = history_lock().lock().unwrap_or_else(|p| p.into_inner());
    let path = history_path(Some(&app));
    let mut entries = load_history(&path);
    upsert_impl(&mut entries, entry);
    save_history(&path, &entries)
}

/// Applies a whole import in one load-modify-save cycle.
///
/// The webview used to replay the entire merged list through
/// `record_history`, one awaited IPC call per entry — up to 200 calls,
/// each re-reading and re-writing the whole history file. Re-importing a
/// backup rewrote all 200 entries even when nothing had changed.
#[tauri::command]
pub fn import_history(
    app: tauri::AppHandle,
    entries: Vec<ReadingHistoryEntry>,
) -> Result<usize, String> {
    if entries.len() > MAX_IMPORT_ENTRIES {
        return Err(format!(
            "Import is too large (max {MAX_IMPORT_ENTRIES} entries)"
        ));
    }
    // Validate up front so a bad entry cannot leave a half-applied import.
    for entry in &entries {
        validate_entry(entry)?;
    }
    let _guard = history_lock().lock().unwrap_or_else(|p| p.into_inner());
    let path = history_path(Some(&app));
    let merged = merge_import(load_history(&path), entries);
    let count = merged.len();
    save_history(&path, &merged)?;
    Ok(count)
}

#[tauri::command]
pub fn remove_history_entry(app: tauri::AppHandle, paper_id: String) -> Result<(), String> {
    let _guard = history_lock().lock().unwrap_or_else(|p| p.into_inner());
    let path = history_path(Some(&app));
    let mut entries = load_history(&path);
    entries.retain(|e| e.paper_id != paper_id);
    save_history(&path, &entries)
}

#[tauri::command]
pub fn clear_history(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = history_lock().lock().unwrap_or_else(|p| p.into_inner());
    let path = history_path(Some(&app));
    save_history(&path, &[])
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn import_merge_takes_the_newer_entry_for_a_shared_paper() {
        let merged = merge_import(
            vec![sample_entry("p1", "2026-08-01T00:00:00Z")],
            vec![sample_entry("p1", "2026-08-09T00:00:00Z")],
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].last_opened_at, "2026-08-09T00:00:00Z");
    }

    #[test]
    fn import_merge_ignores_an_older_entry_for_a_shared_paper() {
        // Re-importing an old backup must not roll a paper back down the
        // list, nor clobber a newer local edit.
        let merged = merge_import(
            vec![sample_entry("p1", "2026-08-09T00:00:00Z")],
            vec![sample_entry("p1", "2026-08-01T00:00:00Z")],
        );
        assert_eq!(merged[0].last_opened_at, "2026-08-09T00:00:00Z");
    }

    #[test]
    fn import_merge_returns_most_recent_first() {
        let merged = merge_import(
            vec![sample_entry("old", "2026-08-01T00:00:00Z")],
            vec![
                sample_entry("new", "2026-08-20T00:00:00Z"),
                sample_entry("mid", "2026-08-10T00:00:00Z"),
            ],
        );
        let ids: Vec<&str> = merged.iter().map(|e| e.paper_id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn import_merge_keeps_the_newest_duplicate_inside_one_batch() {
        let merged = merge_import(
            vec![],
            vec![
                sample_entry("p1", "2026-08-01T00:00:00Z"),
                sample_entry("p1", "2026-08-20T00:00:00Z"),
                sample_entry("p1", "2026-08-10T00:00:00Z"),
            ],
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].last_opened_at, "2026-08-20T00:00:00Z");
    }

    #[test]
    fn import_merge_enforces_the_cap() {
        let current: Vec<ReadingHistoryEntry> = (0..HISTORY_CAP)
            .map(|i| sample_entry(&format!("old{i}"), "2026-01-01T00:00:00Z"))
            .collect();
        // One genuinely new paper, the newest of all.
        let merged = merge_import(current, vec![sample_entry("fresh", "2026-12-31T00:00:00Z")]);
        assert_eq!(merged.len(), HISTORY_CAP);
        assert_eq!(merged[0].paper_id, "fresh");
    }

    #[test]
    fn import_merge_does_not_duplicate_stored_ids() {
        // Defensive: a pre-existing duplicate on disk collapses to one.
        let merged = merge_import(
            vec![
                sample_entry("p1", "2026-08-01T00:00:00Z"),
                sample_entry("p1", "2026-08-02T00:00:00Z"),
            ],
            vec![],
        );
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn import_merge_on_empty_history_adds_everything() {
        let incoming: Vec<ReadingHistoryEntry> = (0..200)
            .map(|i| sample_entry(&format!("p{i}"), "2026-08-01T00:00:00Z"))
            .collect();
        let merged = merge_import(vec![], incoming);
        assert_eq!(merged.len(), 200);
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
