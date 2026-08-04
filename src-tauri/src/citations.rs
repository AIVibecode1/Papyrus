//! Citation counts from the Semantic Scholar Academic Graph API.
//!
//! This is an enrichment layer, never a dependency: if the API is slow or
//! down, the paper list still renders without citation counts. The batch
//! endpoint accepts up to 500 ids per request and returns one entry per
//! requested id (null when the paper is unknown), preserving order.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use tauri::Manager;

use crate::papers::shared_client;

const S2_BATCH_URL: &str = "https://api.semanticscholar.org/graph/v1/paper/batch";
const CITATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// 429 retries for the shared unauthenticated S2 pool (same rationale as
/// S2_RETRIES in papers.rs).
const CITATION_RETRIES: u32 = 3;
const CITATION_RETRY_DELAY_MS: u64 = 1500;
const MAX_IDS_PER_REQUEST: usize = 100;
const CACHE_FILE_NAME: &str = "citation-cache.json";
const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);

/// Test hook: lets the unit tests point at a local mock server.
fn s2_url() -> String {
    std::env::var("PAPYRUS_S2_URL").unwrap_or_else(|_| S2_BATCH_URL.to_string())
}

/// Where the disk cache lives. Test hook: PAPYRUS_CACHE_DIR overrides the
/// app data directory (tests cannot construct an AppHandle).
pub(crate) fn cache_path(app: Option<&tauri::AppHandle>) -> PathBuf {
    if let Ok(dir) = std::env::var("PAPYRUS_CACHE_DIR") {
        return PathBuf::from(dir).join(CACHE_FILE_NAME);
    }
    let dir = app
        .and_then(|a| a.path().app_local_data_dir().ok())
        .unwrap_or_else(|| std::env::temp_dir().join("papyrus"));
    dir.join(CACHE_FILE_NAME)
}

/// Test hook: PAPYRUS_CACHE_TTL_SECS overrides the freshness window.
fn cache_ttl() -> std::time::Duration {
    if let Ok(secs) = std::env::var("PAPYRUS_CACHE_TTL_SECS")
        && let Ok(secs) = secs.parse::<u64>()
    {
        return std::time::Duration::from_secs(secs);
    }
    CACHE_TTL
}

/// Loads the on-disk cache into the session map when it is still fresh.
/// A stale file is ignored; the fetch path refreshes it.
fn load_disk_cache(app: Option<&tauri::AppHandle>) {
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
fn save_disk_cache(app: Option<&tauri::AppHandle>) {
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

fn cache() -> &'static Mutex<Option<HashMap<String, (u32, i64)>>> {
    &CITATION_CACHE
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// arXiv ids may carry a version suffix ("2607.00001v2"); Semantic Scholar
/// wants the bare id ("ARXIV:2607.00001").
fn bare_arxiv_id(id: &str) -> String {
    let id = id.trim();
    let base = match id.rfind('v') {
        Some(pos) if pos > 0 && id[pos + 1..].chars().all(|c| c.is_ascii_digit()) => &id[..pos],
        _ => id,
    };
    base.to_string()
}

/// Fetches citation counts for the given arXiv ids through the disk cache:
/// fresh on-disk counts are loaded into the session map first, and every
/// successful fetch persists the session back to disk.
#[tauri::command]
pub async fn fetch_citations(app: tauri::AppHandle, ids: Vec<String>) -> HashMap<String, u32> {
    fetch_citations_with_cache(Some(&app), ids).await
}

/// The command body without the AppHandle, so unit tests can exercise the
/// disk cache through the PAPYRUS_CACHE_DIR hook.
async fn fetch_citations_with_cache(
    app: Option<&tauri::AppHandle>,
    ids: Vec<String>,
) -> HashMap<String, u32> {
    load_disk_cache(app);
    let result = fetch_citations_impl(ids).await;
    save_disk_cache(app);
    result
}

/// Core fetcher: session cache + network, no disk. Returns a map keyed by
/// the ORIGINAL ids (with version suffixes preserved) so callers can match
/// papers directly. Unknown papers are simply absent from the map. Any
/// network or API error returns an empty map: citations are decoration.
async fn fetch_citations_impl(ids: Vec<String>) -> HashMap<String, u32> {
    let mut result = HashMap::new();
    if ids.is_empty() {
        return result;
    }

    // Serve already-known ids from the session cache. Stale entries
    // (older than the TTL) are dropped so they get refetched and so a
    // later save_disk_cache cannot re-stamp them as fresh.
    {
        let mut guard = cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(cache) = guard.as_mut() {
            let ttl = cache_ttl().as_secs() as i64;
            let now = now_secs();
            let stale: Vec<String> = cache
                .iter()
                .filter(|(_, (_, fetched_at))| now.saturating_sub(*fetched_at) >= ttl)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &stale {
                cache.remove(id);
            }
            for id in &ids {
                if let Some((count, _)) = cache.get(id) {
                    result.insert(id.clone(), *count);
                }
            }
        }
    }

    let missing: Vec<String> = ids
        .iter()
        .filter(|id| !result.contains_key(*id))
        .cloned()
        .collect();
    if missing.is_empty() {
        return result;
    }

    // Semantic Scholar ids must be unique per request; dedupe on the bare id.
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<String> = missing
        .iter()
        .map(|id| bare_arxiv_id(id))
        .filter(|bare| seen.insert(bare.clone()))
        .collect();

    let client = shared_client();
    let mut fetched: HashMap<String, u32> = HashMap::new();

    for chunk in unique.chunks(MAX_IDS_PER_REQUEST) {
        let body = serde_json::json!({
            "ids": chunk
                .iter()
                .map(|id| format!("ARXIV:{id}"))
                .collect::<Vec<_>>(),
        });

        // 429s are common on the shared unauthenticated pool; retry a
        // couple of times before giving up on the chunk.
        let mut attempt = 0u32;
        let response = loop {
            let response = client
                .post(format!("{}?fields=citationCount", s2_url()))
                .json(&body)
                .timeout(CITATION_TIMEOUT)
                .send()
                .await;

            let Ok(response) = response else { break None };
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                && attempt < CITATION_RETRIES
            {
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(
                    CITATION_RETRY_DELAY_MS * u64::from(attempt),
                ))
                .await;
                continue;
            }
            break Some(response);
        };

        let Some(response) = response else { break };
        if !response.status().is_success() {
            break; // rate-limited or down: skip silently
        }
        let text = match response.text().await {
            Ok(t) => t,
            Err(_) => break,
        };
        let entries = match serde_json::from_str::<Vec<Value>>(&text) {
            Ok(e) => e,
            Err(_) => break,
        };

        // The batch response preserves request order; null means unknown.
        for (bare, entry) in chunk.iter().zip(entries.iter()) {
            if let Some(count) = entry.get("citationCount").and_then(|c| c.as_u64()) {
                fetched.insert(bare.clone(), count as u32);
            }
        }
    }

    // Map results back to the ORIGINAL ids and merge into the session cache.
    {
        let mut guard = cache().lock().unwrap_or_else(|p| p.into_inner());
        let cache = guard.get_or_insert_with(HashMap::new);
        let now = now_secs();
        for id in &ids {
            let bare = bare_arxiv_id(id);
            if let Some(count) = fetched.get(&bare) {
                result.insert(id.clone(), *count);
                cache.insert(id.clone(), (*count, now));
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn bare_id_strips_version_suffix_only() {
        assert_eq!(bare_arxiv_id("2607.00001v2"), "2607.00001");
        assert_eq!(bare_arxiv_id("2607.00001"), "2607.00001");
        assert_eq!(bare_arxiv_id(" 2607.00001v3 "), "2607.00001");
        // A "v" followed by non-digits is not a version marker.
        assert_eq!(bare_arxiv_id("2607.1234vX"), "2607.1234vX");
    }

    #[test]
    fn maps_counts_back_to_original_ids() {
        let entries = serde_json::json!([
            { "paperId": "abc", "citationCount": 42 },
            null, // unknown paper stays absent
            { "paperId": "def", "citationCount": 7 },
        ]);
        let url = spawn_mock_s2(entries.as_array().unwrap().clone());
        let counts = fetch_with_override(
            vec![
                "2607.00001v1".into(),
                "2607.00002".into(),
                "2607.00003v2".into(),
            ],
            &url,
        );
        assert_eq!(counts.get("2607.00001v1"), Some(&42));
        assert!(!counts.contains_key("2607.00002"));
        assert_eq!(counts.get("2607.00003v2"), Some(&7));
    }

    #[test]
    fn retries_on_429_and_recovers() {
        // The shared S2 pool answers 429 a couple of times, then succeeds:
        // the fetch must retry and return the counts.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = serde_json::to_string(&[serde_json::json!({
            "paperId": "ARXIV:2607.00001",
            "citationCount": 42,
        })])
        .unwrap();
        thread::spawn(move || {
            let mut served = 0u32;
            while let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let mut req = Vec::new();
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            req.extend_from_slice(&buf[..n]);
                            if req.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                if served < 2 {
                    served += 1;
                    let head = "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(head.as_bytes());
                } else {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(body.as_bytes());
                }
            }
        });
        let counts = fetch_with_override(vec!["2607.00001".into()], &format!("http://{addr}"));
        assert_eq!(counts.get("2607.00001"), Some(&42));
    }

    #[test]
    fn returns_empty_on_api_errors() {
        // A server that answers 500 must yield an empty map, not an error:
        // citations are decoration and must never break the paper list.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let head = "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = stream.write_all(head.as_bytes());
            }
        });
        let counts = fetch_with_override(vec!["2607.00001".into()], &format!("http://{addr}"));
        assert!(counts.is_empty());
    }

    #[test]
    fn empty_input_returns_empty() {
        assert!(fetch_with_override(vec![], "http://127.0.0.1:1").is_empty());
    }

    fn spawn_mock_s2(entries: Vec<Value>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = serde_json::to_string(&entries).unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            req.extend_from_slice(&buf[..n]);
                            if req.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                // Consume the POST body so the client finishes writing.
                if let Some(len_str) = String::from_utf8_lossy(&req)
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().to_string())
                    })
                    .and_then(|l| l.parse::<usize>().ok())
                {
                    let header_end = req
                        .windows(4)
                        .position(|w| w == b"\r\n\r\n")
                        .map(|p| p + 4)
                        .unwrap_or(0);
                    let mut body_buf = req[header_end..].to_vec();
                    while body_buf.len() < len_str {
                        if stream.read(&mut buf).unwrap_or(0) == 0 {
                            break;
                        }
                        body_buf.extend_from_slice(&buf);
                    }
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    // The env vars and the session cache are process-global; serialize the
    // tests that touch them and start from a clean cache.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn reset_session_cache() {
        if let Ok(mut guard) = cache().lock() {
            *guard = None;
        }
    }

    fn fetch_with_override(ids: Vec<String>, url: &str) -> HashMap<String, u32> {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_session_cache();
        // Rust 2024 made env::set_var/remove_var unsafe.
        unsafe {
            std::env::set_var("PAPYRUS_S2_URL", url);
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_citations_impl(ids));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_URL");
        }
        result
    }

    #[test]
    fn disk_cache_survives_a_session_reset() {
        // Roundtrip: fetch through the command path with a real mock, wipe
        // the session cache, then fetch again against a DEAD url — the
        // counts must come back from the disk cache.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_session_cache();
        let dir = std::env::temp_dir().join(format!("papyrus-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        unsafe {
            std::env::set_var("PAPYRUS_CACHE_DIR", &dir);
            std::env::set_var("PAPYRUS_S2_URL", "");
        }
        let mock = spawn_mock_s2(vec![
            serde_json::json!({ "paperId": "ARXIV:2607.00001", "citationCount": 42 }),
        ]);
        unsafe {
            std::env::set_var("PAPYRUS_S2_URL", &mock);
        }
        let first = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_citations_with_cache(
                None,
                vec!["2607.00001v2".into()],
            ));
        assert_eq!(first.get("2607.00001v2"), Some(&42));

        reset_session_cache();
        unsafe {
            std::env::set_var("PAPYRUS_S2_URL", "http://127.0.0.1:1"); // dead
        }
        let second = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_citations_with_cache(
                None,
                vec!["2607.00001v2".into()],
            ));
        assert_eq!(
            second.get("2607.00001v2"),
            Some(&42),
            "disk cache must survive a session reset"
        );

        let _ = std::fs::remove_dir_all(&dir);
        unsafe {
            std::env::remove_var("PAPYRUS_CACHE_DIR");
            std::env::remove_var("PAPYRUS_S2_URL");
        }
    }

    #[test]
    fn disk_cache_ignores_stale_files() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_session_cache();
        let dir = std::env::temp_dir().join(format!("papyrus-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        unsafe {
            std::env::set_var("PAPYRUS_CACHE_DIR", &dir);
        }
        let stale_saved_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() - 8 * 24 * 3600)
            .unwrap_or(0);
        let body = serde_json::json!({ "savedAt": stale_saved_at, "counts": { "2607.00001": 42 } });
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(CACHE_FILE_NAME),
            serde_json::to_string(&body).unwrap(),
        )
        .unwrap();

        unsafe {
            std::env::set_var("PAPYRUS_S2_URL", "http://127.0.0.1:1"); // dead
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_citations_with_cache(None, vec!["2607.00001".into()]));
        assert!(result.is_empty(), "a stale disk cache must be ignored");

        let _ = std::fs::remove_dir_all(&dir);
        unsafe {
            std::env::remove_var("PAPYRUS_CACHE_DIR");
            std::env::remove_var("PAPYRUS_S2_URL");
        }
    }

    #[test]
    fn session_cache_expires_entries_with_the_ttl() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_session_cache();
        unsafe {
            std::env::set_var("PAPYRUS_CACHE_TTL_SECS", "0");
        }
        let fetch_impl = |ids: Vec<String>| {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(fetch_citations_impl(ids))
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let served = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let served_for_thread = std::sync::Arc::clone(&served);
        let body = serde_json::to_string(&[serde_json::json!({
            "paperId": "ARXIV:2607.00001",
            "citationCount": 42,
        })])
        .unwrap();
        thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let mut req = Vec::new();
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            req.extend_from_slice(&buf[..n]);
                            if req.windows(4).any(|w| w == [13, 10, 13, 10]) {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                if let Some(len_str) = String::from_utf8_lossy(&req)
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().to_string())
                    })
                    .and_then(|l| l.parse::<usize>().ok())
                {
                    let header_end = req
                        .windows(4)
                        .position(|w| w == [13, 10, 13, 10])
                        .map(|p| p + 4)
                        .unwrap_or(0);
                    let mut body_buf = req[header_end..].to_vec();
                    while body_buf.len() < len_str {
                        if stream.read(&mut buf).unwrap_or(0) == 0 {
                            break;
                        }
                        body_buf.extend_from_slice(&buf);
                    }
                }
                served_for_thread.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let crlf = String::from_utf8(vec![13, 10]).unwrap();
                let head = format!(
                    "HTTP/1.1 200 OK{crlf}Content-Type: application/json{crlf}Content-Length: {}{crlf}Connection: close{crlf}{crlf}",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        let url = format!("http://{addr}");
        let first = {
            unsafe {
                std::env::set_var("PAPYRUS_S2_URL", &url);
            }
            let r = fetch_impl(vec!["2607.00001".into()]);
            unsafe {
                std::env::remove_var("PAPYRUS_S2_URL");
            }
            r
        };
        assert_eq!(first.get("2607.00001"), Some(&42));
        let second = {
            unsafe {
                std::env::set_var("PAPYRUS_S2_URL", &url);
            }
            let r = fetch_impl(vec!["2607.00001".into()]);
            unsafe {
                std::env::remove_var("PAPYRUS_S2_URL");
            }
            r
        };
        assert_eq!(second.get("2607.00001"), Some(&42));
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 2);
        unsafe {
            std::env::remove_var("PAPYRUS_CACHE_TTL_SECS");
        }
    }

    #[test]
    fn session_cache_serves_fresh_entries_without_network() {
        // ENV_LOCK serializes with the TTL test, which mutates shared env
        // vars (PAPYRUS_CACHE_TTL_SECS) that this test's fetch reads.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_session_cache();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let served = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let served_for_thread = std::sync::Arc::clone(&served);
        let body = serde_json::to_string(&[serde_json::json!({
            "paperId": "ARXIV:2607.00001",
            "citationCount": 42,
        })])
        .unwrap();
        thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let mut req = Vec::new();
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            req.extend_from_slice(&buf[..n]);
                            if req.windows(4).any(|w| w == [13, 10, 13, 10]) {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                if let Some(len_str) = String::from_utf8_lossy(&req)
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().to_string())
                    })
                    .and_then(|l| l.parse::<usize>().ok())
                {
                    let header_end = req
                        .windows(4)
                        .position(|w| w == [13, 10, 13, 10])
                        .map(|p| p + 4)
                        .unwrap_or(0);
                    let mut body_buf = req[header_end..].to_vec();
                    while body_buf.len() < len_str {
                        if stream.read(&mut buf).unwrap_or(0) == 0 {
                            break;
                        }
                        body_buf.extend_from_slice(&buf);
                    }
                }
                served_for_thread.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let crlf = String::from_utf8(vec![13, 10]).unwrap();
                let head = format!(
                    "HTTP/1.1 200 OK{crlf}Content-Type: application/json{crlf}Content-Length: {}{crlf}Connection: close{crlf}{crlf}",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        let url = format!("http://{addr}");
        // Direct fetch_citations_impl calls: fetch_with_override resets the
        // session cache between calls, which would defeat this test.
        let fetch_impl = |ids: Vec<String>| {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(fetch_citations_impl(ids))
        };
        let first = {
            unsafe {
                std::env::set_var("PAPYRUS_S2_URL", &url);
            }
            let r = fetch_impl(vec!["2607.00001".into()]);
            unsafe {
                std::env::remove_var("PAPYRUS_S2_URL");
            }
            r
        };
        assert_eq!(first.get("2607.00001"), Some(&42));
        let second = {
            unsafe {
                std::env::set_var("PAPYRUS_S2_URL", &url);
            }
            let r = fetch_impl(vec!["2607.00001".into()]);
            unsafe {
                std::env::remove_var("PAPYRUS_S2_URL");
            }
            r
        };
        assert_eq!(second.get("2607.00001"), Some(&42));
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn disk_cache_ttl_override_expires_immediately() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_session_cache();
        let dir = std::env::temp_dir().join(format!("papyrus-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        unsafe {
            std::env::set_var("PAPYRUS_CACHE_DIR", &dir);
            std::env::set_var("PAPYRUS_CACHE_TTL_SECS", "0"); // always stale
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let body = serde_json::json!({ "savedAt": now, "counts": { "2607.00001": 42 } });
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(CACHE_FILE_NAME),
            serde_json::to_string(&body).unwrap(),
        )
        .unwrap();

        unsafe {
            std::env::set_var("PAPYRUS_S2_URL", "http://127.0.0.1:1"); // dead
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_citations_with_cache(None, vec!["2607.00001".into()]));
        assert!(result.is_empty(), "TTL 0 must expire the cache immediately");

        let _ = std::fs::remove_dir_all(&dir);
        unsafe {
            std::env::remove_var("PAPYRUS_CACHE_DIR");
            std::env::remove_var("PAPYRUS_CACHE_TTL_SECS");
            std::env::remove_var("PAPYRUS_S2_URL");
        }
    }
}
