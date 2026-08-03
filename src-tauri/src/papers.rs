use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const ARXIV_API: &str = "https://export.arxiv.org/api/query";
const USER_AGENT: &str = concat!(
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
    let wait_for = {
        let mut last = LAST_REQUESTS
            .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let elapsed = last.get(source).map(|t| now.duration_since(*t));
        last.insert(source.to_string(), now);
        elapsed
            .map(|e| interval.saturating_sub(e))
            .unwrap_or_default()
    };
    if !wait_for.is_zero() {
        tokio::time::sleep(wait_for).await;
    }
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
    let category = category.trim();
    let valid_category = !category.is_empty()
        && category.len() <= 32
        && category
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid_category {
        return Err("Invalid category".into());
    }

    let mut term = if let Some(query) = query {
        let query = query.trim();
        let valid_query = !query.is_empty()
            && query.len() <= 200
            && !query
                .chars()
                .any(|c| matches!(c, '"' | '(' | ')' | ':' | '&'));
        if !valid_query {
            return Err("Invalid search query".into());
        }
        format!("all:{query}")
    } else {
        format!("cat:{category}")
    };

    if let Some(date) = date {
        let (y, m, d) = parse_date(date)?;
        let (ny, nm, nd) = next_day(y, m, d);
        // arXiv's range syntax wants compact YYYYMMDD bounds. The upper
        // bound is the following day so the whole day is included.
        term.push_str(&format!(
            "+AND+submittedDate:[{y:04}{m:02}{d:02} TO {ny:04}{nm:02}{nd:02}]"
        ));
    }

    let mut url = format!(
        "{ARXIV_API}?search_query={term}&sortBy=submittedDate&sortOrder=descending&max_results={max}"
    );
    if start > 0 {
        // Pagination: arXiv returns results ordered newest first, so the
        // next page starts at the current list length.
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
pub async fn fetch_papers(
    category: String,
    max_results: Option<usize>,
    query: Option<String>,
    date: Option<String>,
    start: Option<usize>,
    source: Option<String>,
) -> Result<(Vec<Paper>, Option<String>), String> {
    let max = max_results.unwrap_or(20).clamp(1, MAX_RESULTS_LIMIT);
    let start = start.unwrap_or(0);
    let source = source.unwrap_or_else(|| "arxiv".into());
    let source = source.trim().to_lowercase();

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
        match fetch_from_semanticscholar(&query, max, start).await {
            Ok(papers) => return Ok((papers, None)),
            Err(source_error) => {
                // Fallback to arXiv, surfacing the source error. If arXiv
                // also fails, that error propagates (never masked).
                let papers = fetch_from_arxiv(&category, Some(&query), None, max, start).await?;
                return Ok((papers, Some(source_error)));
            }
        }
    }

    fetch_from_arxiv(&category, query.as_deref(), date.as_deref(), max, start)
        .await
        .map(|papers| (papers, None))
}

/// The arXiv path: validates input, enforces the arXiv rate limit, fetches
/// and parses the Atom feed.
async fn fetch_from_arxiv(
    category: &str,
    query: Option<&str>,
    date: Option<&str>,
    max: usize,
    start: usize,
) -> Result<Vec<Paper>, String> {
    let url = build_fetch_url(category, query, date, max, start)?;
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

/// Fetches papers from the Semantic Scholar search API. Requires a
/// non-empty query; `start` maps to the API's `offset` for pagination.
async fn fetch_from_semanticscholar(
    query: &str,
    max: usize,
    start: usize,
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
    if start > 0 {
        url.push_str(&format!("&offset={start}"));
    }

    let response = shared_client()
        .get(&url)
        .timeout(S2_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Network error while contacting Semantic Scholar: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Semantic Scholar response: {e}"))?;

    if !status.is_success() {
        return Err(format!("Semantic Scholar API returned HTTP {status}"));
    }

    parse_s2_search(&body)
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
        assert!(url.contains("search_query=cat:cs.AI"));
        assert!(!url.contains("search_query=all:"));
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
        assert!(url.contains("search_query=all:transformer"));
        // The category term is replaced, not combined.
        assert!(!url.contains("cat:cs.AI"));
        assert!(url.contains("sortBy=submittedDate&sortOrder=descending&max_results=20"));
    }

    #[test]
    fn fetch_url_with_date_adds_submitted_range() {
        let url = build_fetch_url("cs.AI", None, Some("2026-08-01"), 20, 0)
            .expect("date URL should build");
        // The range covers the whole day: [20260801 TO 20260802].
        assert!(url.contains("search_query=cat:cs.AI+AND+submittedDate:[20260801 TO 20260802]"));
        assert!(url.contains("sortBy=submittedDate&sortOrder=descending&max_results=20"));
    }

    #[test]
    fn fetch_url_combines_query_and_date() {
        let url = build_fetch_url("cs.AI", Some("transformer"), Some("2026-08-01"), 20, 0)
            .expect("combined URL should build");
        assert!(
            url.contains("search_query=all:transformer+AND+submittedDate:[20260801 TO 20260802]")
        );
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
        assert!(url.contains("search_query=all:attention"));
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
            ));
        unsafe {
            std::env::remove_var("PAPYRUS_S2_SEARCH_URL");
            std::env::remove_var("PAPYRUS_ARXIV_URL");
        }

        let err = result.expect_err("a total outage must surface as Err");
        assert!(err.contains("arXiv"), "got: {err}");
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
    fn s2_url_encodes_query_parameters() {
        assert_eq!(urlencode("transformer"), "transformer");
        assert_eq!(
            urlencode("attention is all you need"),
            "attention%20is%20all%20you%20need"
        );
        assert_eq!(urlencode("عربي"), "%D8%B9%D8%B1%D8%A8%D9%8A");
    }
}
