//! Paper discovery: shared types, politeness rate limiting, and the
//! `fetch_papers` command that routes between sources.
//!
//! Source-specific logic lives in the submodules:
//! - `arxiv`: arXiv URL building, input validation, Atom feed parsing.
//! - `semantic_scholar`: Semantic Scholar search and response parsing.

pub mod arxiv;
pub mod semantic_scholar;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use arxiv::{SearchOptions, fetch_from_arxiv};
use semantic_scholar::fetch_from_semanticscholar;

pub(crate) const USER_AGENT: &str = concat!(
    "Papyrus/",
    env!("CARGO_PKG_VERSION"),
    " (research paper reader)"
);
/// arXiv asks for at most ~1 request per 3 seconds. Be polite.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(3);
const MAX_RESULTS_LIMIT: usize = 50;

/// Per-source politeness intervals (spike §3.2): arXiv 3 s, Semantic
/// Scholar ~1.1 s. Keep in sync with `source_interval` below.
const SOURCE_INTERVALS: &[(&str, Duration)] = &[
    ("arxiv", MIN_REQUEST_INTERVAL),
    ("semanticscholar", Duration::from_millis(1100)),
];

/// The politeness interval for a source (registry lookup; unknown sources
/// get the arXiv interval).
fn source_interval(source: &str) -> Duration {
    SOURCE_INTERVALS
        .iter()
        .find(|(s, _)| *s == source)
        .map(|(_, d)| *d)
        .unwrap_or(MIN_REQUEST_INTERVAL)
}

/// Per-source last-request timestamps.
static LAST_REQUESTS: OnceLock<Mutex<std::collections::HashMap<String, Instant>>> = OnceLock::new();

/// Per-source serialization locks: a caller holds its source's lock across
/// the sleep, so concurrent fetches of one source can never fire together.
static RATE_LIMIT_LOCKS: OnceLock<
    Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();

/// Shared HTTP client with keep-alive across commands.
pub fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .expect("reqwest client build cannot fail at runtime")
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub published: String,
    pub summary: String,
    pub pdf_url: String,
    pub categories: Vec<String>,
    /// Semantic Scholar enrichment; None for arXiv papers.
    pub citation_count: Option<u32>,
    /// Model-generated one-liner (S2); None for arXiv papers.
    pub tldr: Option<String>,
    pub venue: Option<String>,
}

/// Enforces the per-source politeness interval between API calls
/// (arXiv 3 s, Semantic Scholar 1.1 s — no cross-source blocking).
async fn rate_limit(source: &str) {
    let interval = source_interval(source);
    // Serialize per source: the lock is held across the sleep, so a
    // concurrent caller cannot start (and fire) while this one is
    // waiting — two callers can never fire together.
    let lock = RATE_LIMIT_LOCKS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(source.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let _permit = lock.lock().await;

    let wait_for = {
        let last = LAST_REQUESTS
            .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let elapsed = last.get(source).map(|t| now.duration_since(*t));
        elapsed
            .map(|e| interval.saturating_sub(e))
            .unwrap_or_default()
    };
    if !wait_for.is_zero() {
        tokio::time::sleep(wait_for).await;
    }
    // The timestamp is recorded AFTER the sleep: it marks the moment the
    // request actually fires, so the next caller waits the full interval
    // from it.
    LAST_REQUESTS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(source.to_string(), Instant::now());
}

/// Percent-encodes a query for use in a URL query string (spaces, unicode
/// and reserved characters become %XX; unreserved chars pass through).
pub(crate) fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Fetches the latest papers for an arXiv category, newest first. When
/// `query` is given, the category is ignored and arXiv's `all:` field
/// (title + abstract + authors) is searched instead. When `date`
/// (YYYY-MM-DD) is given, only papers submitted on that day are returned.
/// Fetches papers from the chosen source, newest first. `arxiv` browses
/// categories and searches `all:` terms; `semanticscholar` is search-only
/// (a query is required) and returns citation counts, TLDRs and venues in
/// the same payload. When a non-arXiv source fails, the fetch falls back
/// to arXiv and returns the source error alongside the arXiv results so
/// the UI can show a fallback notice (spike §5 — the notice is the honesty
/// mechanism; the list itself is indistinguishable from a plain fetch).
#[tauri::command]
// The command mirrors the IPC contract: one arg per field, all Option
// so older frontends keep working. Clippy's arity limit does not apply
// to a command boundary.
#[allow(clippy::too_many_arguments)]
pub async fn fetch_papers(
    category: String,
    max_results: Option<usize>,
    query: Option<String>,
    date: Option<String>,
    start: Option<usize>,
    source: Option<String>,
    field: Option<String>,
    year_from: Option<u32>,
    year_to: Option<u32>,
    limit_to_category: Option<bool>,
) -> Result<(Vec<Paper>, Option<String>), String> {
    let max = max_results.unwrap_or(20).clamp(1, MAX_RESULTS_LIMIT);
    let start = start.unwrap_or(0);
    let source = source.unwrap_or_else(|| "arxiv".into());
    let source = source.trim().to_lowercase();
    let field = field.unwrap_or_else(|| "all".into());
    let field = field.trim().to_lowercase();
    let limit_to_category = limit_to_category.unwrap_or(false);
    // Years without a search term are a user error, never a silent browse
    // mode: day navigation already covers browsing by date.
    if query.as_deref().is_none_or(|q| q.trim().is_empty())
        && (year_from.is_some() || year_to.is_some())
    {
        return Err("Enter a search term to filter by year range".into());
    }

    if source != "arxiv" {
        if source != "semanticscholar" {
            return Err(format!("Unknown paper source: {source}"));
        }
        if date.is_some() {
            return Err("Date browsing is not supported for Semantic Scholar".into());
        }
        let Some(query) = query.filter(|q| !q.trim().is_empty()) else {
            return Err("Search query is required for Semantic Scholar".into());
        };
        // Id queries are arXiv-native (S2 has no id field syntax):
        // route them straight to the arXiv path.
        if field == "id" {
            let papers = fetch_from_arxiv(
                &category,
                Some(&query),
                None,
                max,
                start,
                SearchOptions {
                    field: &field,
                    year_from,
                    year_to,
                    limit_to_category,
                },
            )
            .await?;
            return Ok((papers, None));
        }
        match fetch_from_semanticscholar(&query, max, start, year_from, year_to).await {
            Ok(papers) => return Ok((papers, None)),
            Err(source_error) => {
                // Fallback to arXiv, surfacing the source error. If arXiv
                // also fails, that error propagates (never masked).
                let papers = fetch_from_arxiv(
                    &category,
                    Some(&query),
                    None,
                    max,
                    start,
                    SearchOptions {
                        field: &field,
                        year_from,
                        year_to,
                        limit_to_category,
                    },
                )
                .await?;
                return Ok((papers, Some(source_error)));
            }
        }
    }

    fetch_from_arxiv(
        &category,
        query.as_deref(),
        date.as_deref(),
        max,
        start,
        SearchOptions {
            field: &field,
            year_from,
            year_to,
            limit_to_category,
        },
    )
    .await
    .map(|papers| (papers, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// The env vars (PAPYRUS_S2_SEARCH_URL, PAPYRUS_ARXIV_URL) and the
    /// per-source rate-limit timestamps are process-global; serialize the
    /// tests that touch them.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn years_without_query_are_rejected() {
        // A pure year filter is a user error, never a silent browse mode.
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                None,
                None,
                None,
                None,
                None,
                Some(2017),
                None,
                None,
            ))
            .expect_err("years need a search term");
        assert!(err.contains("Enter a search term"), "got: {err}");
    }

    #[test]
    fn id_queries_route_to_arxiv_even_for_s2_source() {
        // S2 has no id field syntax: an id query must use the arXiv path
        // only. Both test endpoints are dead; the error must come from
        // arXiv (proving S2 was never contacted).
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        unsafe {
            std::env::set_var("PAPYRUS_S2_SEARCH_URL", "http://127.0.0.1:1");
            std::env::set_var("PAPYRUS_ARXIV_URL", "http://127.0.0.1:2/api/query");
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                Some("1706.03762".into()),
                None,
                None,
                Some("semanticscholar".into()),
                Some("id".into()),
                None,
                None,
                Some(true),
            ));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_SEARCH_URL");
            std::env::remove_var("PAPYRUS_ARXIV_URL");
        }
        let err = result.expect_err("the arXiv path is dead in this test");
        assert!(err.contains("arXiv"), "got: {err}");
    }

    #[test]
    fn semanticscholar_sends_year_param_and_filters_page() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = r#"{"data":[
            {"paperId":"old1","title":"Too Old","authors":[],"publicationDate":"2016-05-01","year":2016,"abstract":"a"},
            {"paperId":"hit1","title":"In Range","authors":[],"publicationDate":"2017-06-01","year":2017,"abstract":"b"},
            {"paperId":"new1","title":"Too New","authors":[],"publicationDate":"2018-07-01","year":2018,"abstract":"c"}
        ]}"#;
        let request_line = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let captured = request_line.clone();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
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
                let head_end = req.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(0);
                let first_line = String::from_utf8_lossy(&req[..head_end])
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                *captured.lock().unwrap() = first_line;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });

        unsafe {
            std::env::set_var(
                "PAPYRUS_S2_SEARCH_URL",
                format!("http://{addr}/graph/v1/paper/search"),
            );
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                Some("transformer".into()),
                None,
                None,
                Some("semanticscholar".into()),
                Some("all".into()),
                Some(2017),
                Some(2017),
                Some(false),
            ));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_SEARCH_URL");
        }

        let (papers, note) = result.expect("S2 fetch should succeed");
        assert!(note.is_none(), "unexpected fallback note: {note:?}");
        assert_eq!(
            papers.len(),
            1,
            "client filter must drop out-of-range papers"
        );
        assert_eq!(papers[0].title, "In Range");
        let req = request_line.lock().unwrap().clone();
        assert!(req.contains("year=2017-2017"), "got request: {req}");
    }

    /// Live check against the real arXiv API. Run manually: cargo test live -- --ignored
    #[test]
    #[ignore = "requires network access"]
    fn live_fetch_from_arxiv() {
        let (papers, note) = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ))
            .expect("live fetch should succeed");
        assert!(note.is_none());
        assert!(!papers.is_empty(), "expected at least one paper");
        let p = &papers[0];
        assert!(!p.title.is_empty());
        assert!(!p.authors.is_empty());
        assert!(p.pdf_url.starts_with("http"));
        eprintln!("live check: {} papers, first = {}", papers.len(), p.title);
    }

    #[test]
    #[ignore = "requires network access"]
    fn live_s2_search() {
        let (papers, note) = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                Some("transformer".into()),
                None,
                None,
                Some("semanticscholar".into()),
                None,
                None,
                None,
                None,
            ))
            .expect("live s2 search should succeed");
        assert!(!papers.is_empty(), "expected at least one paper");
        let p = &papers[0];
        assert!(p.id.starts_with("s2:"), "id must be prefixed: {}", p.id);
        assert!(!p.title.is_empty());
        eprintln!(
            "live s2 check: {} papers (note={:?}), first = {}",
            papers.len(),
            note,
            p.title
        );
    }

    #[test]
    fn semanticscholar_requires_query() {
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                None,
                None,
                None,
                Some("semanticscholar".into()),
                None,
                None,
                None,
                None,
            ))
            .expect_err("a query is required");
        assert!(err.contains("Search query is required"), "got: {err}");
    }

    #[test]
    fn semanticscholar_rejects_date_browsing() {
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                Some("transformer".into()),
                Some("2026-08-01".into()),
                None,
                Some("semanticscholar".into()),
                None,
                None,
                None,
                None,
            ))
            .expect_err("date browsing is arXiv-only");
        assert!(err.contains("Date browsing is not supported"), "got: {err}");
    }

    #[test]
    fn unknown_source_is_rejected() {
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                None,
                None,
                None,
                Some("openalex".into()),
                None,
                None,
                None,
                None,
            ))
            .expect_err("unknown source");
        assert!(err.contains("Unknown paper source"), "got: {err}");
    }

    #[test]
    fn fallback_to_arxiv_on_s2_failure() {
        // S2 pointed at a dead port; arXiv pointed at a mock serving the
        // sample feed. The result must be arXiv data + the S2 error. The
        // env vars are process-global — serialize with the other test.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let feed = arxiv::SAMPLE_FEED.to_string();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/atom+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    feed.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(feed.as_bytes());
            }
        });

        // Rust 2024 made env::set_var/remove_var unsafe.
        unsafe {
            std::env::set_var("PAPYRUS_S2_SEARCH_URL", "http://127.0.0.1:1");
            std::env::set_var("PAPYRUS_ARXIV_URL", format!("http://{addr}/api/query"));
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                Some("transformer".into()),
                None,
                None,
                Some("semanticscholar".into()),
                None,
                None,
                None,
                None,
            ));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_SEARCH_URL");
            std::env::remove_var("PAPYRUS_ARXIV_URL");
        }

        let (papers, note) = result.expect("arXiv fallback must succeed");
        assert!(
            papers
                .iter()
                .any(|p| p.title.contains("Attention Is All You Need"))
        );
        let note = note.expect("the fallback notice must be Some");
        assert!(note.contains("Semantic Scholar"), "got: {note}");
    }

    #[test]
    fn fallback_propagates_when_arxiv_also_fails() {
        // Both sources dead: the fallback must NOT mask a total outage —
        // the arXiv error propagates as Err.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        unsafe {
            std::env::set_var("PAPYRUS_S2_SEARCH_URL", "http://127.0.0.1:1");
            std::env::set_var("PAPYRUS_ARXIV_URL", "http://127.0.0.1:2/api/query");
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                Some("transformer".into()),
                None,
                None,
                Some("semanticscholar".into()),
                None,
                None,
                None,
                None,
            ));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_SEARCH_URL");
            std::env::remove_var("PAPYRUS_ARXIV_URL");
        }

        let err = result.expect_err("a total outage must surface as Err");
        assert!(err.contains("arXiv"), "got: {err}");
    }

    #[test]
    fn semanticscholar_retries_on_429_then_succeeds() {
        // The shared unauthenticated S2 pool answers 429 a couple of times
        // before succeeding: the fetch must retry, not fall back to arXiv.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = r#"{"data":[{"paperId":"abc123","title":"Retry Paper","authors":[{"name":"Ada"}],"publicationDate":"2026-07-01","year":2026,"abstract":"Abstract","citationCount":3,"venue":"CVPR","openAccessPdf":{"url":"https://example.com/retry.pdf"},"s2FieldsOfStudy":["Computer Science"]}]}"#;
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

        unsafe {
            std::env::set_var(
                "PAPYRUS_S2_SEARCH_URL",
                format!("http://{addr}/graph/v1/paper/search"),
            );
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                Some("transformer".into()),
                None,
                None,
                Some("semanticscholar".into()),
                None,
                None,
                None,
                None,
            ));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_SEARCH_URL");
        }

        let (papers, note) = result.expect("S2 fetch must recover after 429s");
        assert!(note.is_none(), "no fallback notice expected, got: {note:?}");
        assert_eq!(papers.len(), 1);
        assert_eq!(papers[0].title, "Retry Paper");
        assert_eq!(papers[0].citation_count, Some(3));
    }

    #[test]
    fn semanticscholar_persistent_429_falls_back_with_friendly_note() {
        // A server that answers 429 forever: after the retries the fetch
        // must fall back to arXiv and surface a rate-limit explanation.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let feed = arxiv::SAMPLE_FEED.to_string();
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
                let marker = b"graph/v1/paper/search";
                if req.windows(marker.len()).any(|w| w == marker) && served < 10 {
                    served += 1;
                    let head = "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(head.as_bytes());
                } else {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/atom+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        feed.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(feed.as_bytes());
                }
            }
        });

        unsafe {
            std::env::set_var(
                "PAPYRUS_S2_SEARCH_URL",
                format!("http://{addr}/graph/v1/paper/search"),
            );
            std::env::set_var("PAPYRUS_ARXIV_URL", format!("http://{addr}/api/query"));
        }
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers(
                "cs.AI".into(),
                Some(5),
                Some("transformer".into()),
                None,
                None,
                Some("semanticscholar".into()),
                None,
                None,
                None,
                None,
            ));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_SEARCH_URL");
            std::env::remove_var("PAPYRUS_ARXIV_URL");
        }

        let (papers, note) = result.expect("arXiv fallback must succeed");
        assert!(
            papers
                .iter()
                .any(|p| p.title.contains("Attention Is All You Need"))
        );
        let note = note.expect("the fallback note must be Some");
        assert!(note.contains("busy"), "got: {note}");
        assert!(note.contains("rate limits"), "got: {note}");
    }

    #[test]
    fn source_intervals_are_per_source() {
        assert_eq!(source_interval("arxiv"), Duration::from_secs(3));
        assert_eq!(
            source_interval("semanticscholar"),
            Duration::from_millis(1100)
        );
        // Unknown sources get the arXiv interval (never zero).
        assert_eq!(source_interval("openalex"), Duration::from_secs(3));
    }

    #[test]
    fn concurrent_rate_limits_serialize_per_source() {
        // Two simultaneous callers must fire interval-apart, never
        // together (the old code recorded the timestamp before sleeping,
        // so both callers computed the same wait and fired at once).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let start = Instant::now();
        rt.block_on(async {
            let a = tokio::spawn(rate_limit("semanticscholar"));
            let b = tokio::spawn(rate_limit("semanticscholar"));
            a.await.expect("first rate limit task panicked");
            b.await.expect("second rate limit task panicked");
        });
        // The second caller must fire a full interval after the first
        // (~1.1s total). The old code let both fire together (~0s).
        assert!(
            start.elapsed() >= Duration::from_millis(1000),
            "concurrent rate limits fired together: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn rate_limit_isolation_between_sources() {
        // Different sources must not block each other (no cross-source
        // serialization): the second source fires immediately even while
        // the first is sleeping.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let start = Instant::now();
        rt.block_on(async {
            let a = tokio::spawn(rate_limit("arxiv"));
            let b = tokio::spawn(rate_limit("semanticscholar"));
            a.await.expect("arxiv rate limit task panicked");
            b.await.expect("scholar rate limit task panicked");
        });
        // arXiv sleeps ~3s, scholar ~1.1s; the total must not be ~4.1s
        // (serialized across sources) but ~3s (parallel).
        assert!(
            start.elapsed() < Duration::from_millis(3800),
            "sources were serialized against each other: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn s2_url_encodes_query_parameters() {
        assert_eq!(urlencode("transformer"), "transformer");
        assert_eq!(
            urlencode("attention is all you need"),
            "attention%20is%20all%20you%20need"
        );
        assert_eq!(urlencode("عربي"), "%D8%B9%D8%B1%D8%A8%D9%8A");
    }
}
