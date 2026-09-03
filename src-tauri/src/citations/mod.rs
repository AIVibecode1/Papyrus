//! Citation counts from the Semantic Scholar Academic Graph API.
//!
//! This is an enrichment layer, never a dependency: if the API is slow or
//! down, the paper list still renders without citation counts. The batch
//! endpoint accepts up to 500 ids per request and returns one entry per
//! requested id (null when the paper is unknown), preserving order.
//!
//! Layout: `cache` owns the session map and the on-disk cache; this module
//! owns the `fetch_citations` command, the S2/OpenAlex sources and the
//! orchestration between them. The fetch-path tests live in `tests`.

pub mod cache;
#[cfg(test)]
mod tests;

pub(crate) use cache::cache_path;

use std::collections::HashMap;

use crate::papers::shared_client;

use cache::{cache, load_disk_cache, now_secs, save_disk_cache};

const S2_BATCH_URL: &str = "https://api.semanticscholar.org/graph/v1/paper/batch";
const CITATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// 429 retries for the shared unauthenticated S2 pool (same rationale as
/// S2_RETRIES in papers.rs).
const CITATION_RETRIES: u32 = 3;
const CITATION_RETRY_DELAY_MS: u64 = 1500;
const MAX_IDS_PER_REQUEST: usize = 100;
/// OpenAlex `filter=doi:` supports up to 50 pipe-separated values.
const OPENALEX_MAX_IDS: usize = 50;

/// Test hook: lets the unit tests point at a local mock server.
fn s2_url() -> String {
    std::env::var("PAPYRUS_S2_URL").unwrap_or_else(|_| S2_BATCH_URL.to_string())
}

/// Test hook: PAPYRUS_OPENALEX_URL overrides the works endpoint.
fn openalex_url() -> String {
    std::env::var("PAPYRUS_OPENALEX_URL")
        .unwrap_or_else(|_| "https://api.openalex.org/works".to_string())
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
///
/// Returns (counts, reachable): `reachable` is true when ANY citation
/// source answered (Semantic Scholar or OpenAlex), even with zero counts.
/// The UI uses it to tell "the network failed" apart from "these papers
/// are too fresh to have citation data yet" — both show a hint, but the
/// first one is retryable and the second is a data reality.
#[tauri::command]
pub async fn fetch_citations(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> (HashMap<String, u32>, bool) {
    fetch_citations_with_cache(Some(&app), ids).await
}

/// The command body without the AppHandle, so unit tests can exercise the
/// disk cache through the PAPYRUS_CACHE_DIR hook.
async fn fetch_citations_with_cache(
    app: Option<&tauri::AppHandle>,
    ids: Vec<String>,
) -> (HashMap<String, u32>, bool) {
    load_disk_cache(app);
    let result = fetch_citations_impl(ids).await;
    save_disk_cache(app);
    result
}

/// Core fetcher: session cache + network, no disk. Returns a map keyed by
/// the ORIGINAL ids (with version suffixes preserved) so callers can match
/// papers directly, plus `reachable` (true when any source answered with
/// a successful HTTP response — even zero counts). Unknown papers are
/// simply absent from the map. Any network or API error returns an empty
/// map: citations are decoration.
async fn fetch_citations_impl(ids: Vec<String>) -> (HashMap<String, u32>, bool) {
    let mut result = HashMap::new();
    let mut reachable = false;
    if ids.is_empty() {
        return (result, reachable);
    }

    // Serve already-known ids from the session cache. Stale entries
    // (older than the TTL) are dropped so they get refetched and so a
    // later save_disk_cache cannot re-stamp them as fresh.
    {
        let mut guard = cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(cache) = guard.as_mut() {
            let ttl = cache::cache_ttl().as_secs() as i64;
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

    let mut missing: Vec<String> = ids
        .iter()
        .filter(|id| !result.contains_key(*id))
        .cloned()
        .collect();
    // Only arXiv-shaped ids can be resolved by the batch endpoint: S2
    // papers (s2:...) already carry citationCount in the search payload,
    // and sending "ARXIV:s2:..." would waste a request that returns
    // nothing.
    missing.retain(|id| !id.starts_with("s2:"));
    if missing.is_empty() {
        return (result, reachable);
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
        reachable = true;
        let text = match response.text().await {
            Ok(t) => t,
            Err(_) => break,
        };
        let entries = match serde_json::from_str::<Vec<serde_json::Value>>(&text) {
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

    // OpenAlex fallback: the shared S2 pool 429s often, and citation
    // counts are the whole point of the "Most cited" sort — a sorted
    // list that never reorders reads as broken. Every arXiv paper has
    // the DOI 10.48550/arxiv.<id>, which OpenAlex indexes; one GET
    // resolves up to OPENALEX_MAX_IDS ids, with generous free limits
    // (no key). Only ids S2 could not resolve are queried.
    let still_missing: Vec<&String> = unique
        .iter()
        .filter(|id| !fetched.contains_key(*id))
        .collect();
    for chunk in still_missing.chunks(OPENALEX_MAX_IDS) {
        let filter = chunk
            .iter()
            .map(|id| format!("10.48550/arxiv.{id}"))
            .collect::<Vec<_>>()
            .join("|");
        let url = format!(
            "{}?filter=doi:{}&per-page={}&select=doi,cited_by_count",
            openalex_url(),
            // Percent-encode the pipe: a strict proxy in between may
            // reject the raw `|` in the query.
            filter.replace('|', "%7C"),
            chunk.len()
        );
        let Ok(response) = client.get(&url).timeout(CITATION_TIMEOUT).send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        reachable = true;
        let Ok(text) = response.text().await else {
            continue;
        };
        let Ok(serde_json::Value::Object(body)) = serde_json::from_str::<serde_json::Value>(&text)
        else {
            continue;
        };
        let Some(results) = body.get("results").and_then(|r| r.as_array()) else {
            continue;
        };
        let wanted: std::collections::HashSet<&str> = chunk.iter().map(|s| s.as_str()).collect();
        for entry in results {
            let Some(doi) = entry.get("doi").and_then(|d| d.as_str()) else {
                continue;
            };
            // doi looks like https://doi.org/10.48550/arxiv.2301.00001
            let Some(bare) = doi.rsplit("arxiv.").next() else {
                continue;
            };
            let bare = bare.trim_end_matches('/');
            if !wanted.contains(bare) {
                continue;
            }
            if let Some(count) = entry.get("cited_by_count").and_then(|c| c.as_u64()) {
                fetched.insert(bare.to_string(), count as u32);
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

    (result, reachable)
}
