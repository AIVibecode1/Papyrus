//! Citation counts from the Semantic Scholar Academic Graph API.
//!
//! This is an enrichment layer, never a dependency: if the API is slow or
//! down, the paper list still renders without citation counts. The batch
//! endpoint accepts up to 500 ids per request and returns one entry per
//! requested id (null when the paper is unknown), preserving order.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use crate::papers::shared_client;

const S2_BATCH_URL: &str = "https://api.semanticscholar.org/graph/v1/paper/batch";
const CITATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_IDS_PER_REQUEST: usize = 100;

/// Test hook: lets the unit tests point at a local mock server.
fn s2_url() -> String {
    std::env::var("PAPYRUS_S2_URL").unwrap_or_else(|_| S2_BATCH_URL.to_string())
}

/// Session cache so repeated list refreshes do not re-query the API.
static CITATION_CACHE: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn cache() -> &'static Mutex<Option<HashMap<String, u32>>> {
    &CITATION_CACHE
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

/// Fetches citation counts for the given arXiv ids. Returns a map keyed by
/// the ORIGINAL ids (with version suffixes preserved) so callers can match
/// papers directly. Unknown papers are simply absent from the map. Any
/// network or API error returns an empty map: citations are decoration.
#[tauri::command]
pub async fn fetch_citations(ids: Vec<String>) -> HashMap<String, u32> {
    let mut result = HashMap::new();
    if ids.is_empty() {
        return result;
    }

    // Serve already-known ids from the session cache.
    {
        let guard = cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(cache) = guard.as_ref() {
            for id in &ids {
                if let Some(count) = cache.get(id) {
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

        let response = client
            .post(format!("{}?fields=citationCount", s2_url()))
            .json(&body)
            .timeout(CITATION_TIMEOUT)
            .send()
            .await;

        let Ok(response) = response else { break };
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
        for id in &ids {
            let bare = bare_arxiv_id(id);
            if let Some(count) = fetched.get(&bare) {
                result.insert(id.clone(), *count);
                cache.insert(id.clone(), *count);
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

    fn fetch_with_override(ids: Vec<String>, url: &str) -> HashMap<String, u32> {
        // The env var and the session cache are process-global; serialize
        // the tests that touch them and start from a clean cache.
        static ENV_LOCK: Mutex<()> = Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        if let Ok(mut guard) = cache().lock() {
            *guard = None;
        }
        // Rust 2024 made env::set_var/remove_var unsafe.
        unsafe {
            std::env::set_var("PAPYRUS_S2_URL", url);
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_citations(ids));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_URL");
        }
        result
    }
}
