use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const ARXIV_API: &str = "https://export.arxiv.org/api/query";
pub(crate) const USER_AGENT: &str = concat!(
    "Papyrus/",
    env!("CARGO_PKG_VERSION"),
    " (research paper reader)"
);
/// arXiv asks for at most ~1 request per 3 seconds. Be polite.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESULTS_LIMIT: usize = 50;
const S2_SEARCH_URL: &str = "https://api.semanticscholar.org/graph/v1/paper/search";
const S2_TIMEOUT: Duration = Duration::from_secs(20);

/// Per-source politeness intervals (spike §3.2): arXiv 3 s, Semantic
/// Scholar ~1.1 s. Keep in sync with `source_interval` below.
const SOURCE_INTERVALS: &[(&str, Duration)] = &[
    ("arxiv", MIN_REQUEST_INTERVAL),
    ("semanticscholar", Duration::from_millis(1100)),
];

/// Test hooks: let the unit tests point at local mock servers.
fn arxiv_url() -> String {
    std::env::var("PAPYRUS_ARXIV_URL").unwrap_or_else(|_| ARXIV_API.to_string())
}

fn s2_search_url() -> String {
    std::env::var("PAPYRUS_S2_SEARCH_URL").unwrap_or_else(|_| S2_SEARCH_URL.to_string())
}

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

/// Builds the arXiv API query URL for a category browse, a free-text
/// search, and/or a single submission day.
///
/// - A search query replaces the category term with arXiv's `all:` field
///   (title + abstract + authors).
/// - A `date` (YYYY-MM-DD) narrows the result to papers submitted on that
///   day using arXiv's `submittedDate` range syntax. The range is
///   `[YYYYMMDD TO YYYYMMDD]` where the upper bound is the next day, so
///   the whole 24-hour window is captured.
///
/// All inputs are validated here so malformed `search_query` grammar
/// never reaches arXiv: categories must look like `cat:` codes, query
/// strings reject the characters arXiv's query parser treats as operators
/// (`"`, `(`, `)`, `:`, `&`), and dates must be real calendar dates.
fn build_fetch_url(
    category: &str,
    query: Option<&str>,
    date: Option<&str>,
    max: usize,
    start: usize,
) -> Result<String, String> {
    let category = validate_category(category)?;

    let mut term = if let Some(query) = query {
        format!("all:{}", validate_query(query)?)
    } else {
        format!("cat:{category}")
    };

    if let Some(date) = date {
        append_day_range(&mut term, date)?;
    }

    finish_arxiv_url(&term, max, start, ArxivSort::SubmittedDate)
}

/// Year bounds for fielded search (plan 041). Both endpoints are
/// inclusive calendar years; a range like 2017–2017 covers that year.
fn validate_year(year: u32) -> Result<(), String> {
    if !(1900..=2100).contains(&year) {
        return Err("Invalid year".into());
    }
    Ok(())
}

/// Fielded search options (plan 041): the arXiv field prefix, inclusive
/// year bounds, and whether the current category is ANDed onto the query.
#[derive(Clone, Copy, Default)]
struct SearchOptions<'a> {
    field: &'a str,
    year_from: Option<u32>,
    year_to: Option<u32>,
    limit_to_category: bool,
}

/// Builds the arXiv query URL for a fielded search (plan 041): maps the
/// field to its arXiv prefix (`all`/`ti`/`au`/`abs`/`id`), sanitizes the
/// term, appends the optional year range as a `submittedDate` range, and
/// optionally ANDs the current category. A day `date` takes precedence
/// over the year range (a single day is stricter).
fn build_search_url(
    category: &str,
    query: &str,
    opts: SearchOptions<'_>,
    date: Option<&str>,
    max: usize,
    start: usize,
) -> Result<String, String> {
    let category = validate_category(category)?;
    let prefix = field_prefix(opts.field)?;

    let query = query.trim();
    let mut term = if prefix == "id" {
        // Id queries are exact: normalize (strip `arXiv:` prefix, keep
        // the safe id charset) and never AND a category onto them. The
        // id charset is the sanitizer here, so `arXiv:1706.03762` (a
        // colon) is valid input, not an operator.
        format!("id:{}", normalize_id_query(query)?)
    } else {
        // validate_query rejects operator characters (`"`, `(`, `)`,
        // `:`, `&`, `[`, `]`, `*`, `+`) before anything reaches arXiv.
        let query = validate_query(query)?;
        if query.split_whitespace().count() > 1 {
            // Multi-word terms ship as a QUOTED phrase (server-generated
            // quotes; user `"` never reaches this point). Two live-
            // verified reasons (2026-08):
            // 1. relevance sort: unquoted/parenthesized multi-word terms
            //    get scrambled ranking — `ti:Attention Is All You Need`
            //    ranked unrelated papers above 1706.03762; the quoted
            //    phrase puts the exact match at #1.
            // 2. trailing AND clauses (year range, cat:) survive the
            //    quoted phrase, so archive searches keep their bounds.
            format!("{prefix}:\"{query}\"")
        } else {
            // Single-word terms need no wrapping: arXiv honors trailing
            // AND clauses (verified live), and relevance ranks them fine.
            format!("{prefix}:{query}")
        }
    };

    if let Some(date) = date {
        append_day_range(&mut term, date)?;
    } else if prefix != "id" {
        // submittedDate range: lower bound is Jan 1 of year_from; the
        // upper bound is Jan 1 of year_to + 1 (exclusive, mirroring the
        // day range) so Dec 31 of year_to is included.
        match (opts.year_from, opts.year_to) {
            (Some(from), Some(to)) => {
                validate_year(from)?;
                validate_year(to)?;
                if from > to {
                    return Err("Year range is reversed".into());
                }
                term.push_str(&format!(
                    " AND submittedDate:[{from}0101 TO {}0101]",
                    to + 1
                ));
            }
            (Some(from), None) => {
                validate_year(from)?;
                term.push_str(&format!(" AND submittedDate:[{from}0101 TO 21000101]"));
            }
            (None, Some(to)) => {
                validate_year(to)?;
                term.push_str(&format!(" AND submittedDate:[19000101 TO {}0101]", to + 1));
            }
            (None, None) => {}
        }
    }

    if opts.limit_to_category && prefix != "id" {
        term.push_str(&format!(" AND cat:{category}"));
    }

    finish_arxiv_url(&term, max, start, ArxivSort::Relevance)
}

/// Validates a category code (must look like a `cat:` code).
fn validate_category(category: &str) -> Result<String, String> {
    let category = category.trim();
    let valid_category = !category.is_empty()
        && category.len() <= 32
        && category
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid_category {
        return Err("Invalid category".into());
    }
    Ok(category.to_string())
}

/// Validates a free-text search term: non-empty, capped length, and no
/// characters arXiv's query parser treats as operators (`"`, `(`, `)`,
/// `:`, `&` and the range brackets / wildcards `[` `]` `*` `+`).
fn validate_query(query: &str) -> Result<String, String> {
    let query = query.trim();
    let valid_query = !query.is_empty()
        && query.len() <= 200
        && !query
            .chars()
            .any(|c| matches!(c, '"' | '(' | ')' | ':' | '&' | '[' | ']' | '*' | '+'));
    if !valid_query {
        return Err("Invalid search query".into());
    }
    Ok(query.to_string())
}

/// Maps the UI search field to its arXiv prefix.
fn field_prefix(field: &str) -> Result<&'static str, String> {
    match field {
        "" | "all" => Ok("all"),
        "title" => Ok("ti"),
        "author" => Ok("au"),
        "abstract" => Ok("abs"),
        "id" => Ok("id"),
        _ => Err(format!("Unknown search field: {field}")),
    }
}

/// Test helper: fielded search URL with the common (date=None, start=0)
/// tail, keeping the assertions readable.
#[cfg(test)]
fn search_url(
    category: &str,
    query: &str,
    field: &str,
    year_from: Option<u32>,
    year_to: Option<u32>,
    limit: bool,
    max: usize,
) -> Result<String, String> {
    build_search_url(
        category,
        query,
        SearchOptions {
            field,
            year_from,
            year_to,
            limit_to_category: limit,
        },
        None,
        max,
        0,
    )
}

/// Normalizes an arXiv id query: strips a leading `arXiv:` (any case) or
/// `/abs/` path, keeps the trailing version suffix optional, and allows
/// only the safe id charset (digits, letters, dot, dash, underscore,
/// comma for id lists). Anything else is rejected before it reaches the
/// API.
fn normalize_id_query(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let q = if let Some(rest) = trimmed.to_ascii_lowercase().strip_prefix("arxiv:") {
        // `rest` is a byte-identical prefix of `trimmed` (ASCII lowering
        // preserves length), so slicing by its byte length is safe.
        &trimmed[trimmed.len() - rest.len()..]
    } else {
        trimmed
    };
    let q = q.strip_suffix('/').unwrap_or(q);
    if q.is_empty()
        || q.len() > 200
        || !q
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ','))
    {
        return Err("Invalid arXiv id".into());
    }
    Ok(q.to_string())
}

/// Appends the day-browse `submittedDate:[YYYYMMDD TO next_day]` clause.
fn append_day_range(term: &mut String, date: &str) -> Result<(), String> {
    let (y, m, d) = parse_date(date)?;
    let (ny, nm, nd) = next_day(y, m, d);
    // arXiv's range syntax wants compact YYYYMMDD bounds. The upper
    // bound is the following day so the whole day is included. The
    // term is joined with spaces (not "+") so the fully encoded URL
    // matches what the API demonstrably accepts: "cat:cs.AI AND
    // submittedDate:[20260725 TO 20260726]" with %20 spaces returns
    // entries, while raw or "%2B"-encoded operators and raw range
    // brackets silently return zero.
    term.push_str(&format!(
        " AND submittedDate:[{y:04}{m:02}{d:02} TO {ny:04}{nm:02}{nd:02}]"
    ));
    Ok(())
}

/// How arXiv should order the result set (plan 050).
///
/// Category browse and day browse are inherently "newest first"
/// (`submittedDate` desc). Free-text and fielded search must rank by
/// `relevance`, otherwise every query returns "newest papers that
/// happen to match the words" and foundational archive papers (e.g.
/// DeepSeek, Jan 2025) lose to 2026 mentions.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ArxivSort {
    SubmittedDate,
    Relevance,
}

/// The common URL tail for every arXiv query.
fn finish_arxiv_url(
    term: &str,
    max: usize,
    start: usize,
    sort: ArxivSort,
) -> Result<String, String> {
    let sort_by = match sort {
        ArxivSort::SubmittedDate => "submittedDate",
        ArxivSort::Relevance => "relevance",
    };
    let mut url = format!(
        "{ARXIV_API}?search_query={}&sortBy={sort_by}&sortOrder=descending&max_results={max}",
        // Percent-encode the term: arXiv's range grammar (`[` `]` `:`) and
        // any query text must arrive encoded, or the API silently returns
        // zero entries for date ranges.
        urlencode(term),
    );
    if start > 0 {
        // Pagination: arXiv returns results ordered by the sort above, so
        // the next page starts at the current list length.
        url.push_str(&format!("&start={start}"));
    }
    Ok(url)
}

/// Parses and validates a `YYYY-MM-DD` calendar date.
fn parse_date(date: &str) -> Result<(u32, u32, u32), String> {
    let date = date.trim();
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("Invalid date".into());
    }
    let y: u32 = parts[0].parse().map_err(|_| "Invalid date".to_string())?;
    let m: u32 = parts[1].parse().map_err(|_| "Invalid date".to_string())?;
    let d: u32 = parts[2].parse().map_err(|_| "Invalid date".to_string())?;
    if !(1900..=2100).contains(&y) || !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
        return Err("Invalid date".into());
    }
    Ok((y, m, d))
}

/// Days in a Gregorian month, leap years included.
fn days_in_month(y: u32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = y.is_multiple_of(4) && !y.is_multiple_of(100) || y.is_multiple_of(400);
            if leap { 29 } else { 28 }
        }
        _ => 0,
    }
}

/// The calendar day after `(y, m, d)`, with month and year rollover.
fn next_day(y: u32, m: u32, d: u32) -> (u32, u32, u32) {
    if d < days_in_month(y, m) {
        (y, m, d + 1)
    } else if m < 12 {
        (y, m + 1, 1)
    } else {
        (y + 1, 1, 1)
    }
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

/// The arXiv path: validates input, enforces the arXiv rate limit, fetches
/// and parses the Atom feed. Fielded search (plan 041) applies when a
/// query is present; plain category/date browsing keeps the legacy URL
/// builder.
async fn fetch_from_arxiv(
    category: &str,
    query: Option<&str>,
    date: Option<&str>,
    max: usize,
    start: usize,
    opts: SearchOptions<'_>,
) -> Result<Vec<Paper>, String> {
    let url = match query {
        Some(q) => build_search_url(category, q, opts, date, max, start)?,
        None => {
            if opts.year_from.is_some() || opts.year_to.is_some() {
                return Err("Enter a search term to filter by year range".into());
            }
            build_fetch_url(category, None, date, max, start)?
        }
    };
    // Test hook: swap the base URL (PAPYRUS_ARXIV_URL) while keeping the
    // validated query string from build_fetch_url.
    let url = url.replacen(ARXIV_API, &arxiv_url(), 1);

    rate_limit("arxiv").await;

    let response = shared_client()
        .get(&url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Network error while contacting arXiv: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read arXiv response: {e}"))?;

    if !status.is_success() {
        return Err(format!("arXiv API returned HTTP {status}"));
    }

    parse_feed(&body)
}

/// Retries on HTTP 429: Semantic Scholar's shared unauthenticated pool is
/// frequently saturated (spike §3.1) and a short wait usually clears it.
/// A persistent outage still falls back to arXiv via fetch_papers.
const S2_RETRIES: u32 = 3;
const S2_RETRY_DELAY_MS: u64 = 1500;

/// Fetches papers from the Semantic Scholar search API. Requires a
/// non-empty query; `start` maps to the API's `offset` for pagination.
/// Year bounds go in the `year` query param when both are present (S2's
/// documented range syntax); one-sided bounds cannot be expressed there,
/// so they are enforced client-side on the returned page (current-page
/// limitation, documented in plan 041).
async fn fetch_from_semanticscholar(
    query: &str,
    max: usize,
    start: usize,
    year_from: Option<u32>,
    year_to: Option<u32>,
) -> Result<Vec<Paper>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Search query is required for Semantic Scholar".into());
    }

    rate_limit("semanticscholar").await;

    let mut url = format!(
        "{}?query={}&fields=title,abstract,year,citationCount,venue,openAccessPdf,authors,publicationDate,s2FieldsOfStudy&limit={max}",
        s2_search_url(),
        urlencode(query),
    );
    if let (Some(from), Some(to)) = (year_from, year_to) {
        validate_year(from)?;
        validate_year(to)?;
        if from > to {
            return Err("Year range is reversed".into());
        }
        url.push_str(&format!("&year={from}-{to}"));
    }
    if start > 0 {
        url.push_str(&format!("&offset={start}"));
    }

    let mut attempt = 0u32;
    loop {
        let response = shared_client()
            .get(&url)
            .timeout(S2_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("Network error while contacting Semantic Scholar: {e}"))?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < S2_RETRIES {
            attempt += 1;
            tokio::time::sleep(Duration::from_millis(
                S2_RETRY_DELAY_MS * u64::from(attempt),
            ))
            .await;
            continue;
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read Semantic Scholar response: {e}"))?;

        if !status.is_success() {
            return Err(if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                "Semantic Scholar is busy right now (free-tier rate limits). Try again in a minute."
                    .into()
            } else {
                format!("Semantic Scholar API returned HTTP {status}")
            });
        }

        let mut papers = parse_s2_search(&body)?;
        // Client-side year enforcement (one-sided bounds, and belt for
        // two-sided ones): a paper whose year is unknown cannot be proven
        // in range, so it is dropped from the current page.
        if year_from.is_some() || year_to.is_some() {
            papers.retain(|p| {
                let year = p.published.get(..4).and_then(|s| s.parse::<u32>().ok());
                match year {
                    Some(y) => year_from.is_none_or(|f| y >= f) && year_to.is_none_or(|t| y <= t),
                    None => false,
                }
            });
        }
        return Ok(papers);
    }
}

/// Percent-encodes a query for use in a URL query string (spaces, unicode
/// and reserved characters become %XX; unreserved chars pass through).
fn urlencode(s: &str) -> String {
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

/// The S2 search response shape (fields requested above; everything not
/// present in the response is optional — the parse never fails on it).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct S2SearchResponse {
    data: Vec<S2Paper>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct S2Paper {
    paper_id: String,
    title: Option<String>,
    #[serde(default)]
    authors: Vec<S2Author>,
    publication_date: Option<String>,
    year: Option<i64>,
    #[serde(rename = "abstract")]
    abstract_text: Option<String>,
    tldr: Option<S2Tldr>,
    venue: Option<String>,
    citation_count: Option<u32>,
    open_access_pdf: Option<S2Pdf>,
    #[serde(default)]
    s2_fields_of_study: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct S2Author {
    name: String,
}

#[derive(Debug, serde::Deserialize)]
struct S2Tldr {
    text: String,
}

#[derive(Debug, serde::Deserialize)]
struct S2Pdf {
    url: String,
}

/// Parses a Semantic Scholar search response into papers (mapping per
/// spike §2.2): ids are prefixed `s2:`; `published` prefers the full date
/// and falls back to the year; the PDF url falls back to the paper landing
/// page; categories come from s2FieldsOfStudy (up to 3).
fn parse_s2_search(json: &str) -> Result<Vec<Paper>, String> {
    let response: S2SearchResponse = serde_json::from_str(json)
        .map_err(|e| format!("Failed to parse Semantic Scholar response: {e}"))?;

    let mut papers = Vec::new();
    for entry in response.data {
        let title = entry.title.unwrap_or_default().trim().to_string();
        if title.is_empty() {
            continue; // skip malformed entries
        }
        let published = entry
            .publication_date
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| entry.year.map(|y| format!("{y}-01-01")).unwrap_or_default());
        let authors: Vec<String> = entry.authors.into_iter().map(|a| a.name).collect();
        let pdf_url = entry
            .open_access_pdf
            .map(|p| p.url)
            .unwrap_or_else(|| format!("https://www.semanticscholar.org/paper/{}", entry.paper_id));
        let categories: Vec<String> = entry.s2_fields_of_study.into_iter().take(3).collect();

        papers.push(Paper {
            id: format!("s2:{}", entry.paper_id),
            title,
            authors,
            published,
            summary: entry.abstract_text.unwrap_or_default().trim().to_string(),
            pdf_url,
            categories,
            citation_count: entry.citation_count,
            tldr: entry.tldr.map(|t| t.text),
            venue: entry.venue,
        });
    }
    Ok(papers)
}

/// Parses arXiv's Atom XML feed into a list of papers.
pub fn parse_feed(xml: &str) -> Result<Vec<Paper>, String> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| format!("Failed to parse arXiv response: {e}"))?;

    let mut papers = Vec::new();
    for entry in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "entry")
    {
        let children = entry.children().filter(|n| n.is_element());

        let text_of = |name: &str| -> String {
            children
                .clone()
                .find(|n| n.tag_name().name() == name)
                .and_then(|n| n.text())
                .unwrap_or_default()
                .trim()
                .to_string()
        };

        let title = normalize_whitespace(&text_of("title"));
        let summary = normalize_whitespace(&text_of("summary"));
        let id = text_of("id")
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        let published = text_of("published");

        let authors: Vec<String> = children
            .clone()
            .filter(|n| n.tag_name().name() == "author")
            .filter_map(|a| {
                a.children()
                    .find(|n| n.is_element() && n.tag_name().name() == "name")
                    .and_then(|n| n.text())
                    .map(|t| t.trim().to_string())
            })
            .collect();

        let pdf_url = children
            .clone()
            .filter(|n| n.tag_name().name() == "link")
            .find(|n| n.attribute("type") == Some("application/pdf"))
            .and_then(|l| l.attribute("href"))
            .map(normalize_pdf_url)
            .unwrap_or_else(|| format!("https://arxiv.org/pdf/{id}"));

        let categories: Vec<String> = children
            .clone()
            .filter(|n| n.tag_name().name() == "category")
            .filter_map(|c| c.attribute("term").map(str::to_string))
            .collect();

        if title.is_empty() && summary.is_empty() {
            continue; // skip malformed entries
        }

        papers.push(Paper {
            id,
            title,
            authors,
            published,
            summary,
            pdf_url,
            categories,
            // arXiv does not provide these; the S2 parse fills them.
            citation_count: None,
            tldr: None,
            venue: None,
        });
    }

    Ok(papers)
}

fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Upgrades arXiv PDF links to https so paper downloads never ride on
/// plaintext transport (downgrade/MITM protection).
fn normalize_pdf_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("http://arxiv.org/") {
        format!("https://arxiv.org/{rest}")
    } else if let Some(rest) = url.strip_prefix("http://export.arxiv.org/") {
        format!("https://export.arxiv.org/{rest}")
    } else {
        url.to_string()
    }
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

    const SAMPLE_FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2607.12345v1</id>
    <title>Attention Is All You Need
    (second line)</title>
    <published>2026-07-31T17:59:59Z</published>
    <summary>A transformer architecture for sequence
    modeling.</summary>
    <author><name>Jane Doe</name></author>
    <author><name>John Smith</name></author>
    <link href="http://arxiv.org/abs/2607.12345v1" rel="alternate" type="text/html"/>
    <link href="http://arxiv.org/pdf/2607.12345v1" rel="related" type="application/pdf"/>
    <category term="cs.AI"/>
    <category term="cs.CL"/>
  </entry>
</feed>"#;

    #[test]
    fn parses_atom_feed() {
        let papers = parse_feed(SAMPLE_FEED).expect("feed should parse");
        assert_eq!(papers.len(), 1);
        let p = &papers[0];
        assert_eq!(p.id, "2607.12345v1");
        assert_eq!(p.title, "Attention Is All You Need (second line)");
        assert_eq!(p.published, "2026-07-31T17:59:59Z");
        assert_eq!(p.authors, vec!["Jane Doe", "John Smith"]);
        assert!(p.summary.contains("transformer architecture"));
        // The fixture deliberately ships an http:// pdf link; it must come
        // out normalized to https.
        assert_eq!(p.pdf_url, "https://arxiv.org/pdf/2607.12345v1");
        assert_eq!(p.categories, vec!["cs.AI", "cs.CL"]);
    }

    #[test]
    fn normalizes_arxiv_pdf_links_to_https() {
        assert_eq!(
            normalize_pdf_url("http://arxiv.org/pdf/2607.12345v1"),
            "https://arxiv.org/pdf/2607.12345v1"
        );
        assert_eq!(
            normalize_pdf_url("http://export.arxiv.org/pdf/2607.12345v1"),
            "https://export.arxiv.org/pdf/2607.12345v1"
        );
        // Already-secure and non-arXiv links are left untouched.
        assert_eq!(
            normalize_pdf_url("https://arxiv.org/pdf/2607.12345v1"),
            "https://arxiv.org/pdf/2607.12345v1"
        );
        assert_eq!(
            normalize_pdf_url("https://example.com/paper.pdf"),
            "https://example.com/paper.pdf"
        );
    }

    #[test]
    fn skips_malformed_entries() {
        // An entry with neither a title nor a summary is dropped; the
        // rest of the feed is still returned.
        let feed = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2607.11111v1</id>
    <title>A Real Paper</title>
    <published>2026-07-30T10:00:00Z</published>
    <summary>A real summary.</summary>
    <author><name>Jane Doe</name></author>
    <link href="https://arxiv.org/pdf/2607.11111v1" rel="related" type="application/pdf"/>
    <category term="cs.AI"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2607.22222v1</id>
    <published>2026-07-30T11:00:00Z</published>
  </entry>
</feed>"#;
        let papers = parse_feed(feed).expect("feed should parse");
        assert_eq!(papers.len(), 1);
        assert_eq!(papers[0].id, "2607.11111v1");
        assert_eq!(papers[0].title, "A Real Paper");
    }

    #[test]
    fn pdf_link_fallback_uses_id() {
        // An entry with no application/pdf link falls back to the
        // canonical https arXiv PDF URL derived from the entry id.
        let feed = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2607.33333v2</id>
    <title>No PDF Link Here</title>
    <published>2026-07-29T09:00:00Z</published>
    <summary>Only an HTML link is present.</summary>
    <author><name>John Smith</name></author>
    <link href="https://arxiv.org/abs/2607.33333v2" rel="alternate" type="text/html"/>
    <category term="cs.LG"/>
  </entry>
</feed>"#;
        let papers = parse_feed(feed).expect("feed should parse");
        assert_eq!(papers.len(), 1);
        assert_eq!(papers[0].pdf_url, "https://arxiv.org/pdf/2607.33333v2");
    }

    #[test]
    fn fetch_url_without_query_uses_category() {
        let url = build_fetch_url("cs.AI", None, None, 20, 0).expect("category URL should build");
        assert!(url.contains("search_query=cat%3Acs.AI"));
        assert!(!url.contains("search_query=all%3A"));
        assert!(url.contains("sortBy=submittedDate&sortOrder=descending&max_results=20"));
        // Invalid categories are still rejected at the same boundary.
        assert_eq!(
            build_fetch_url("cs.AI; DROP TABLE", None, None, 20, 0),
            Err("Invalid category".into())
        );
    }

    #[test]
    fn fetch_url_with_query_uses_all_field() {
        let url = build_fetch_url("cs.AI", Some("transformer"), None, 20, 0)
            .expect("query URL should build");
        assert!(url.contains("search_query=all%3Atransformer"));
        // The category term is replaced, not combined.
        assert!(!url.contains("cat:cs.AI"));
        assert!(url.contains("sortBy=submittedDate&sortOrder=descending&max_results=20"));
    }

    #[test]
    fn fetch_url_with_date_adds_submitted_range() {
        let url = build_fetch_url("cs.AI", None, Some("2026-08-01"), 20, 0)
            .expect("date URL should build");
        // The range covers the whole day: [20260801 TO 20260802], joined
        // with spaces and fully percent-encoded (arXiv returns zero
        // entries when the range grammar arrives raw or with "%2B").
        assert_eq!(
            url,
            "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI%20AND%20submittedDate%3A%5B20260801%20TO%2020260802%5D&sortBy=submittedDate&sortOrder=descending&max_results=20"
        );
    }

    #[test]
    fn fetch_url_combines_query_and_date() {
        let url = build_fetch_url("cs.AI", Some("transformer"), Some("2026-08-01"), 20, 0)
            .expect("combined URL should build");
        assert!(url.contains(
            "search_query=all%3Atransformer%20AND%20submittedDate%3A%5B20260801%20TO%2020260802%5D"
        ));
        assert!(!url.contains("cat:cs.AI"));
    }

    #[test]
    fn fetch_url_rejects_invalid_queries() {
        // Characters arXiv's query grammar treats as operators must be
        // rejected before they reach the API.
        for bad in ['"', '(', ')', ':', '&'] {
            let url = build_fetch_url("cs.AI", Some(&format!("transformer{bad}")), None, 20, 0);
            assert_eq!(
                url,
                Err("Invalid search query".into()),
                "charset must reject {bad:?}"
            );
        }
        // Over-long and blank queries are rejected too…
        assert_eq!(
            build_fetch_url("cs.AI", Some(&"a".repeat(201)), None, 20, 0),
            Err("Invalid search query".into())
        );
        assert_eq!(
            build_fetch_url("cs.AI", Some("   "), None, 20, 0),
            Err("Invalid search query".into())
        );
        // …but surrounding whitespace is trimmed before validation.
        let url = build_fetch_url("cs.AI", Some("  attention  "), None, 20, 0)
            .expect("trimmed query should build");
        assert!(url.contains("search_query=all%3Aattention"));
    }

    #[test]
    fn fetch_url_rejects_invalid_dates() {
        for bad in [
            "2026-13-01", // month 13
            "2026-00-10", // month 0
            "2026-02-30", // February has no 30th
            "2026-04-31", // April has no 31st
            "2026-02-29", // 2026 is not a leap year
            "20260801",   // wrong format (needs dashes)
            "abc",        // garbage
            "",           // empty
        ] {
            let url = build_fetch_url("cs.AI", None, Some(bad), 20, 0);
            assert_eq!(url, Err("Invalid date".into()), "must reject {bad:?}");
        }
    }

    // ------------------------------------------------------------------
    // Plan 041: fielded search URL building
    // ------------------------------------------------------------------

    #[test]
    fn search_url_uses_relevance_sort() {
        // Keyword/fielded search ranks by relevance (plan 050): otherwise
        // archive papers lose to "newest that happen to match".
        let url = search_url("cs.AI", "DeepSeek-R1", "all", None, None, false, 20)
            .expect("url should build");
        assert!(
            url.contains("sortBy=relevance&sortOrder=descending"),
            "got: {url}"
        );
    }

    #[test]
    fn browse_url_uses_submitted_date_sort() {
        // Category browse and day browse stay newest-first (plan 050).
        let browse = build_fetch_url("cs.AI", None, None, 20, 0).expect("browse url should build");
        assert!(
            browse.contains("sortBy=submittedDate&sortOrder=descending"),
            "got: {browse}"
        );
        let day = build_fetch_url("cs.AI", None, Some("2026-08-01"), 20, 0)
            .expect("day url should build");
        assert!(
            day.contains("sortBy=submittedDate&sortOrder=descending"),
            "got: {day}"
        );
    }

    #[test]
    fn search_url_without_limit_omits_cat() {
        // The default (limit off) must not AND the active category onto a
        // query: a cs.CL or cs.LG hit with a perfect title match has to
        // surface while the user sits on cs.AI (plan 050).
        let url = search_url(
            "cs.AI",
            "Attention Is All You Need",
            "title",
            None,
            None,
            false,
            20,
        )
        .expect("url should build");
        assert!(!url.contains("cat%3A"), "got: {url}");
    }

    #[test]
    fn search_url_maps_each_field_to_arxiv_prefix() {
        // Single-word terms are plain `field:term` (no wrapping needed;
        // arXiv honors trailing AND clauses and relevance ranks them).
        let cases = [
            ("all", "search_query=all%3Atransformer"),
            ("title", "search_query=ti%3Atransformer"),
            ("author", "search_query=au%3Atransformer"),
            ("abstract", "search_query=abs%3Atransformer"),
            ("id", "search_query=id%3A1706.03762"),
        ];
        for (field, expected) in cases {
            let query = if field == "id" {
                "1706.03762"
            } else {
                "transformer"
            };
            let url =
                search_url("cs.AI", query, field, None, None, false, 20).expect("url should build");
            assert!(
                url.contains(expected),
                "field {field} must produce {expected}, got: {url}"
            );
        }
    }

    #[test]
    fn search_url_quotes_multi_word_terms() {
        // Multi-word terms ship as a server-generated quoted phrase: with
        // relevance sort an unquoted phrase ranks unrelated papers above
        // the exact match (live-verified), and the quotes keep the
        // trailing year-range and cat: clauses honored.
        let url = search_url(
            "cs.AI",
            "Attention Is All You Need",
            "title",
            None,
            None,
            false,
            20,
        )
        .expect("url should build");
        assert!(
            url.contains("search_query=ti%3A%22Attention%20Is%20All%20You%20Need%22"),
            "got: {url}"
        );

        // Multi-word quoted + year range + cat clause all present.
        let deepseek = search_url(
            "cs.AI",
            "DeepSeek R1",
            "all",
            Some(2025),
            Some(2025),
            true,
            20,
        )
        .expect("deepseek url should build");
        assert!(
            deepseek.contains("all%3A%22DeepSeek%20R1%22"),
            "got: {deepseek}"
        );
        assert!(
            deepseek.contains("submittedDate%3A%5B20250101%20TO%2020260101%5D"),
            "got: {deepseek}"
        );
        assert!(deepseek.contains("%20AND%20cat%3Acs.AI"), "got: {deepseek}");
    }

    #[test]
    fn search_url_normalizes_id_input() {
        // The arXiv: prefix and trailing slash are stripped; the version
        // suffix is kept (arXiv accepts it).
        let url = search_url("cs.AI", "arXiv:1706.03762v2", "id", None, None, false, 20)
            .expect("id url should build");
        assert!(url.contains("search_query=id%3A1706.03762v2"), "got: {url}");

        // Operator-ish characters are rejected before they reach the API.
        assert_eq!(
            search_url("cs.AI", "1706.03762; DROP", "id", None, None, false, 20),
            Err("Invalid arXiv id".into())
        );
    }

    #[test]
    fn search_url_appends_year_range_as_yyyymmdd() {
        // The upper bound is Jan 1 of year_to + 1 (exclusive) so Dec 31
        // of year_to is included, mirroring the day-range semantics.
        let url = search_url(
            "cs.AI",
            "transformer",
            "all",
            Some(2017),
            Some(2017),
            false,
            20,
        )
        .expect("url should build");
        assert!(
            url.contains("submittedDate%3A%5B20170101%20TO%2020180101%5D"),
            "got: {url}"
        );
    }

    #[test]
    fn search_url_one_sided_year_bounds() {
        let from = search_url("cs.AI", "transformer", "all", Some(2017), None, false, 20)
            .expect("from-only url should build");
        assert!(
            from.contains("submittedDate%3A%5B20170101%20TO%2021000101%5D"),
            "got: {from}"
        );
        let to = search_url("cs.AI", "transformer", "all", None, Some(2009), false, 20)
            .expect("to-only url should build");
        assert!(
            to.contains("submittedDate%3A%5B19000101%20TO%2020100101%5D"),
            "got: {to}"
        );
    }

    #[test]
    fn search_url_rejects_bad_year_bounds() {
        assert_eq!(
            search_url(
                "cs.AI",
                "transformer",
                "all",
                Some(2020),
                Some(2017),
                false,
                20
            ),
            Err("Year range is reversed".into())
        );
        assert_eq!(
            search_url("cs.AI", "transformer", "all", Some(1800), None, false, 20),
            Err("Invalid year".into())
        );
    }

    #[test]
    fn search_url_limit_to_category_appends_cat_clause() {
        let limited = search_url("cs.AI", "transformer", "all", None, None, true, 20)
            .expect("limited url should build");
        assert!(limited.contains("%20AND%20cat%3Acs.AI"), "got: {limited}");

        let global = search_url("cs.AI", "transformer", "all", None, None, false, 20)
            .expect("global url should build");
        assert!(!global.contains("cat%3A"), "got: {global}");

        // Id queries are exact matches: never AND a category onto them.
        let id_url = search_url("cs.AI", "1706.03762", "id", None, None, true, 20)
            .expect("id url should build");
        assert!(!id_url.contains("cat%3A"), "got: {id_url}");
    }

    #[test]
    fn search_url_rejects_operator_injection() {
        for bad in ['"', '(', ')', ':', '&', '[', ']', '*', '+'] {
            let url = search_url(
                "cs.AI",
                &format!("transformer{bad}"),
                "title",
                None,
                None,
                false,
                20,
            );
            assert_eq!(
                url,
                Err("Invalid search query".into()),
                "charset must reject {bad:?}"
            );
        }
    }

    #[test]
    fn unknown_field_is_rejected() {
        assert_eq!(
            search_url("cs.AI", "transformer", "bogus", None, None, false, 20),
            Err("Unknown search field: bogus".into())
        );
    }

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
                &format!("http://{addr}/graph/v1/paper/search"),
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

    #[test]
    fn next_day_rolls_over_months_and_years() {
        assert_eq!(next_day(2026, 8, 1), (2026, 8, 2));
        assert_eq!(next_day(2026, 8, 31), (2026, 9, 1));
        assert_eq!(next_day(2026, 12, 31), (2027, 1, 1));
        assert_eq!(next_day(2026, 2, 28), (2026, 3, 1));
        // Leap year: 2028 has a February 29th.
        assert_eq!(next_day(2028, 2, 28), (2028, 2, 29));
        assert_eq!(next_day(2028, 2, 29), (2028, 3, 1));
        assert_eq!(next_day(2026, 4, 30), (2026, 5, 1));
    }

    #[test]
    fn pagination_appends_start_param() {
        let url = build_fetch_url("cs.AI", None, None, 20, 40).expect("url should build");
        assert!(url.contains("max_results=20&start=40"), "got: {url}");
        // start=0 (first page) omits the param entirely.
        let first = build_fetch_url("cs.AI", None, None, 20, 0).expect("url should build");
        assert!(!first.contains("start="), "got: {first}");
    }

    #[test]
    fn rejects_garbage_xml() {
        assert!(parse_feed("not xml at all {{{").is_err());
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

    // ------------------------------------------------------------------
    // S2 fixture tests
    // ------------------------------------------------------------------

    const S2_FIXTURE: &str = include_str!("../src/s2_fixture.json");

    #[test]
    fn parses_s2_search_batch() {
        let papers = parse_s2_search(S2_FIXTURE).expect("fixture should parse");
        assert_eq!(papers.len(), 2);

        // The full-fields paper maps every field per spike §2.2.
        let full = &papers[0];
        assert_eq!(full.id, "s2:abc123def456");
        assert_eq!(full.title, "Attention Is All You Need");
        assert_eq!(full.authors, vec!["Jane Doe", "John Smith"]);
        assert_eq!(full.published, "2026-07-31");
        assert!(full.summary.contains("transformer architecture"));
        assert_eq!(full.pdf_url, "https://example.com/paper.pdf");
        assert_eq!(
            full.categories,
            vec!["Computer Science", "Machine Learning"]
        );
        assert_eq!(full.citation_count, Some(123456));
        assert_eq!(
            full.tldr.as_deref(),
            Some("A transformer architecture that processes sequences in parallel.")
        );
        assert_eq!(full.venue.as_deref(), Some("NeurIPS"));

        // The sparse paper: nulls become empty/None, year becomes the
        // published fallback, the PDF url falls back to the landing page.
        let sparse = &papers[1];
        assert_eq!(sparse.id, "s2:xyz789");
        assert_eq!(sparse.authors, Vec::<String>::new());
        assert_eq!(sparse.published, "2025-01-01");
        assert_eq!(sparse.summary, "");
        assert_eq!(
            sparse.pdf_url,
            "https://www.semanticscholar.org/paper/xyz789"
        );
        assert_eq!(sparse.categories, Vec::<String>::new());
        assert_eq!(sparse.citation_count, Some(0));
        assert_eq!(sparse.tldr, None);
        assert_eq!(sparse.venue, None);
    }

    #[test]
    fn s2_id_is_prefixed() {
        let papers = parse_s2_search(S2_FIXTURE).expect("fixture should parse");
        for p in &papers {
            assert!(p.id.starts_with("s2:"), "id must be prefixed: {}", p.id);
        }
    }

    #[test]
    fn rejects_garbage_s2_json() {
        assert!(parse_s2_search("not json {{{").is_err());
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
        let feed = SAMPLE_FEED.to_string();
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
            std::env::set_var("PAPYRUS_ARXIV_URL", &format!("http://{addr}/api/query"));
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
                &format!("http://{addr}/graph/v1/paper/search"),
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
        let feed = SAMPLE_FEED.to_string();
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
                &format!("http://{addr}/graph/v1/paper/search"),
            );
            std::env::set_var("PAPYRUS_ARXIV_URL", &format!("http://{addr}/api/query"));
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
