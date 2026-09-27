//! Citation cache: the in-memory session map plus the on-disk JSON cache
//! in the app data dir. Both layers share one TTL: entries older than the
//! freshness window are dropped on read, so a long-running session can
//! never serve stale counts and a stale file is simply ignored.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use tauri::Manager;

pub(crate) const CACHE_FILE_NAME: &str = "citation-cache.json";
const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);

/// Where the disk cache lives. Test hook: PAPYRUS_CACHE_DIR overrides the
/// app data directory (tests cannot construct an AppHandle).
pub(crate) fn cache_path(app: Option<&tauri::AppHandle>) -> PathBuf {
    if let Some(dir) = crate::test_hooks::test_env("PAPYRUS_CACHE_DIR") {
        return PathBuf::from(dir).join(CACHE_FILE_NAME);
    }
    let dir = app
        .and_then(|a| a.path().app_local_data_dir().ok())
        .unwrap_or_else(|| std::env::temp_dir().join("papyrus"));
    dir.join(CACHE_FILE_NAME)
}

/// Test hook: PAPYRUS_CACHE_TTL_SECS overrides the freshness window.
pub(crate) fn cache_ttl() -> std::time::Duration {
    if let Some(secs) = crate::test_hooks::test_env("PAPYRUS_CACHE_TTL_SECS")
        && let Ok(secs) = secs.parse::<u64>()
    {
        return std::time::Duration::from_secs(secs);
    }
    CACHE_TTL
}

/// Loads the on-disk cache into the session map when it is still fresh.
/// A stale file is ignored; the fetch path refreshes it.
pub(crate) fn load_disk_cache(app: Option<&tauri::AppHandle>) {
    let Ok(text) = std::fs::read_to_string(cache_path(app)) else {
        return;
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(saved_at) = map.get("savedAt").and_then(|v| v.as_i64()) else {
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if now.saturating_sub(saved_at) >= cache_ttl().as_secs() as i64 {
        return;
    }
    let Some(counts) = map.get("counts").and_then(|v| v.as_object()) else {
        return;
    };
    let mut guard = cache().lock().unwrap_or_else(|p| p.into_inner());
    let session = guard.get_or_insert_with(HashMap::new);
    for (id, count) in counts {
        if let Some(n) = count.as_u64() {
            session.insert(id.clone(), (n as u32, saved_at));
        }
    }
}

/// Persists the session cache to disk with the current timestamp so the
/// next launch (within the TTL window) starts with known counts. The
/// savedAt is the time of THIS write; per-entry freshness is discarded.
pub(crate) fn save_disk_cache(app: Option<&tauri::AppHandle>) {
    let snapshot: HashMap<String, u32> = {
        let guard = cache().lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
            Some(map) if !map.is_empty() => {
                map.iter().map(|(id, (c, _))| (id.clone(), *c)).collect()
            }
            _ => return,
        }
    };
    let saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = serde_json::json!({ "savedAt": saved_at, "counts": snapshot });
    if let Some(parent) = cache_path(app).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        cache_path(app),
        serde_json::to_string(&body).unwrap_or_default(),
    );
}

/// Session cache so repeated list refreshes do not re-query the API.
/// Each entry carries the unix time it was fetched (or, for entries loaded
/// from disk, the disk snapshot's savedAt) so the same TTL that governs
/// the disk cache also expires in-memory entries — a long-running session
/// can never keep serving counts older than the freshness window.
static CITATION_CACHE: Mutex<Option<HashMap<String, (u32, i64)>>> = Mutex::new(None);

pub(crate) fn cache() -> &'static Mutex<Option<HashMap<String, (u32, i64)>>> {
    &CITATION_CACHE
}

/// Drops the in-memory session cache. The "Clear cache and saved data"
/// action deletes the on-disk file; without this the same counts kept being
/// served from memory until the app restarted, so the button did not do what
/// it said.
pub(crate) fn clear_memory_cache() -> Result<(), String> {
    let mut guard = CITATION_CACHE
        .lock()
        .map_err(|_| "Citation cache lock is poisoned".to_string())?;
    *guard = None;
    Ok(())
}

pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
