//! Fetch-path tests for citations: S2 batch parsing, 429 retries, the
//! OpenAlex fallback, the reachable flag, and the session + disk caches.
//! All network access goes through local mock servers; the OpenAlex
//! fallback is always pointed at a dead or mock URL.

use super::*;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
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
    if let Ok(mut guard) = cache::cache().lock() {
        *guard = None;
    }
}

fn fetch_with_override(ids: Vec<String>, url: &str) -> HashMap<String, u32> {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    reset_session_cache();
    // Rust 2024 made env::set_var/remove_var unsafe.
    unsafe {
        std::env::set_var("PAPYRUS_S2_URL", url);
        // The OpenAlex fallback must never hit the real API in tests.
        std::env::set_var("PAPYRUS_OPENALEX_URL", "http://127.0.0.1:1");
    }
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(fetch_citations_impl(ids))
        .0;
    unsafe {
        std::env::remove_var("PAPYRUS_S2_URL");
        std::env::remove_var("PAPYRUS_OPENALEX_URL");
    }
    result
}

fn fetch_with_overrides(ids: Vec<String>, s2: &str, oa: &str) -> HashMap<String, u32> {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    reset_session_cache();
    unsafe {
        std::env::set_var("PAPYRUS_S2_URL", s2);
        std::env::set_var("PAPYRUS_OPENALEX_URL", oa);
    }
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(fetch_citations_impl(ids))
        .0;
    unsafe {
        std::env::remove_var("PAPYRUS_S2_URL");
        std::env::remove_var("PAPYRUS_OPENALEX_URL");
    }
    result
}

/// Starts a mock OpenAlex works endpoint returning the given results.
fn spawn_mock_openalex(results: Vec<Value>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // Read the request first: answering before the client
            // finishes sending makes reqwest report a failed send.
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
            let body =
                serde_json::json!({ "meta": { "count": results.len() }, "results": results })
                    .to_string();
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

#[test]
fn openalex_fallback_serves_counts_when_s2_is_down() {
    // S2 answers 429 to every attempt (the shared keyless pool does
    // this often); OpenAlex must supply the counts so "Most cited"
    // still reorders instead of showing "counts unavailable".
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let head =
                "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes());
        }
    });
    let oa = spawn_mock_openalex(vec![serde_json::json!({
        "doi": "https://doi.org/10.48550/arxiv.2607.00001",
        "cited_by_count": 42,
    })]);
    let counts = fetch_with_overrides(vec!["2607.00001".into()], &format!("http://{addr}"), &oa);
    assert_eq!(counts.get("2607.00001"), Some(&42));
}

#[test]
fn openalex_fills_ids_s2_could_not_resolve() {
    // S2 answers one count and null for another (unknown paper);
    // OpenAlex covers the gap with its own count.
    let s2 = spawn_mock_s2(vec![
        serde_json::json!({ "paperId": "ARXIV:2607.00001", "citationCount": 5 }),
        Value::Null,
    ]);
    let oa = spawn_mock_openalex(vec![serde_json::json!({
        "doi": "https://doi.org/10.48550/arxiv.2607.00002",
        "cited_by_count": 77,
    })]);
    let counts = fetch_with_overrides(vec!["2607.00001".into(), "2607.00002".into()], &s2, &oa);
    assert_eq!(counts.get("2607.00001"), Some(&5));
    assert_eq!(counts.get("2607.00002"), Some(&77));
}

#[test]
fn reachable_flag_is_true_when_a_source_answers_with_zero() {
    // S2 429s, OpenAlex answers 200 with zero results: reachable must
    // be true — the honest message is "papers too fresh", not
    // "network down".
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let head =
                "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes());
        }
    });
    let oa = spawn_mock_openalex(vec![]);
    let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    reset_session_cache();
    unsafe {
        std::env::set_var("PAPYRUS_S2_URL", format!("http://{addr}"));
        std::env::set_var("PAPYRUS_OPENALEX_URL", oa);
    }
    let (counts, reachable) = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(fetch_citations_impl(vec!["2607.00001".into()]));
    unsafe {
        std::env::remove_var("PAPYRUS_S2_URL");
        std::env::remove_var("PAPYRUS_OPENALEX_URL");
    }
    assert!(counts.is_empty());
    assert!(reachable);
}

#[test]
fn reachable_flag_is_false_when_everything_is_down() {
    // Both sources unreachable: reachable stays false so the UI can
    // offer a retry instead of claiming the papers have no data.
    let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    reset_session_cache();
    unsafe {
        std::env::set_var("PAPYRUS_S2_URL", "http://127.0.0.1:1");
        std::env::set_var("PAPYRUS_OPENALEX_URL", "http://127.0.0.1:1");
    }
    let (counts, reachable) = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(fetch_citations_impl(vec!["2607.00001".into()]));
    unsafe {
        std::env::remove_var("PAPYRUS_S2_URL");
        std::env::remove_var("PAPYRUS_OPENALEX_URL");
    }
    assert!(counts.is_empty());
    assert!(!reachable);
}

#[test]
fn openalex_fallback_ignores_foreign_results() {
    // A response containing a doi that was not requested must be
    // ignored (defense against a misbehaving proxy or cache).
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let head =
                "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes());
        }
    });
    let oa = spawn_mock_openalex(vec![serde_json::json!({
        "doi": "https://doi.org/10.48550/arxiv.9999.99999",
        "cited_by_count": 999,
    })]);
    let counts = fetch_with_overrides(vec!["2607.00001".into()], &format!("http://{addr}"), &oa);
    assert!(counts.is_empty());
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
        // Keep the OpenAlex fallback off the real network in tests.
        std::env::set_var("PAPYRUS_OPENALEX_URL", "http://127.0.0.1:1");
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
        ))
        .0;
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
        ))
        .0;
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
        // The OpenAlex fallback must never hit the real API in tests.
        std::env::set_var("PAPYRUS_OPENALEX_URL", "http://127.0.0.1:1");
    }
    let stale_saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() - 8 * 24 * 3600)
        .unwrap_or(0);
    let body = serde_json::json!({ "savedAt": stale_saved_at, "counts": { "2607.00001": 42 } });
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(cache::CACHE_FILE_NAME),
        serde_json::to_string(&body).unwrap(),
    )
    .unwrap();

    unsafe {
        std::env::set_var("PAPYRUS_S2_URL", "http://127.0.0.1:1"); // dead
    }
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(fetch_citations_with_cache(None, vec!["2607.00001".into()]))
        .0;
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
            .0
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
            .0
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
        // The OpenAlex fallback must never hit the real API in tests.
        std::env::set_var("PAPYRUS_OPENALEX_URL", "http://127.0.0.1:1");
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = serde_json::json!({ "savedAt": now, "counts": { "2607.00001": 42 } });
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(cache::CACHE_FILE_NAME),
        serde_json::to_string(&body).unwrap(),
    )
    .unwrap();

    unsafe {
        std::env::set_var("PAPYRUS_S2_URL", "http://127.0.0.1:1"); // dead
    }
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(fetch_citations_with_cache(None, vec!["2607.00001".into()]))
        .0;
    assert!(result.is_empty(), "TTL 0 must expire the cache immediately");

    let _ = std::fs::remove_dir_all(&dir);
    unsafe {
        std::env::remove_var("PAPYRUS_CACHE_DIR");
        std::env::remove_var("PAPYRUS_CACHE_TTL_SECS");
        std::env::remove_var("PAPYRUS_S2_URL");
    }
}
