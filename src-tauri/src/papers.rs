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

static LAST_REQUEST: OnceLock<Mutex<Instant>> = OnceLock::new();

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
}

/// Enforces arXiv's politeness interval between API calls.
async fn rate_limit() {
    let lock = LAST_REQUEST.get_or_init(|| Mutex::new(Instant::now() - MIN_REQUEST_INTERVAL));
    let wait_for = {
        let mut last = lock.lock().unwrap();
        let elapsed = last.elapsed();
        *last = Instant::now();
        MIN_REQUEST_INTERVAL.saturating_sub(elapsed)
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

    Ok(format!(
        "{ARXIV_API}?search_query={term}&sortBy=submittedDate&sortOrder=descending&max_results={max}"
    ))
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
#[tauri::command]
pub async fn fetch_papers(
    category: String,
    max_results: Option<usize>,
    query: Option<String>,
    date: Option<String>,
) -> Result<Vec<Paper>, String> {
    // Validate input before hitting the network.
    let max = max_results.unwrap_or(20).clamp(1, MAX_RESULTS_LIMIT);
    let url = build_fetch_url(&category, query.as_deref(), date.as_deref(), max)?;

    rate_limit().await;

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
        let url = build_fetch_url("cs.AI", None, None, 20).expect("category URL should build");
        assert!(url.contains("search_query=cat:cs.AI"));
        assert!(!url.contains("search_query=all:"));
        assert!(url.contains("sortBy=submittedDate&sortOrder=descending&max_results=20"));
        // Invalid categories are still rejected at the same boundary.
        assert_eq!(
            build_fetch_url("cs.AI; DROP TABLE", None, None, 20),
            Err("Invalid category".into())
        );
    }

    #[test]
    fn fetch_url_with_query_uses_all_field() {
        let url = build_fetch_url("cs.AI", Some("transformer"), None, 20)
            .expect("query URL should build");
        assert!(url.contains("search_query=all:transformer"));
        // The category term is replaced, not combined.
        assert!(!url.contains("cat:cs.AI"));
        assert!(url.contains("sortBy=submittedDate&sortOrder=descending&max_results=20"));
    }

    #[test]
    fn fetch_url_with_date_adds_submitted_range() {
        let url =
            build_fetch_url("cs.AI", None, Some("2026-08-01"), 20).expect("date URL should build");
        // The range covers the whole day: [20260801 TO 20260802].
        assert!(url.contains("search_query=cat:cs.AI+AND+submittedDate:[20260801 TO 20260802]"));
        assert!(url.contains("sortBy=submittedDate&sortOrder=descending&max_results=20"));
    }

    #[test]
    fn fetch_url_combines_query_and_date() {
        let url = build_fetch_url("cs.AI", Some("transformer"), Some("2026-08-01"), 20)
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
            let url = build_fetch_url("cs.AI", Some(&format!("transformer{bad}")), None, 20);
            assert_eq!(
                url,
                Err("Invalid search query".into()),
                "charset must reject {bad:?}"
            );
        }
        // Over-long and blank queries are rejected too…
        assert_eq!(
            build_fetch_url("cs.AI", Some(&"a".repeat(201)), None, 20),
            Err("Invalid search query".into())
        );
        assert_eq!(
            build_fetch_url("cs.AI", Some("   "), None, 20),
            Err("Invalid search query".into())
        );
        // …but surrounding whitespace is trimmed before validation.
        let url = build_fetch_url("cs.AI", Some("  attention  "), None, 20)
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
            let url = build_fetch_url("cs.AI", None, Some(bad), 20);
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
    fn rejects_garbage_xml() {
        assert!(parse_feed("not xml at all {{{").is_err());
    }

    /// Live check against the real arXiv API. Run manually: cargo test live -- --ignored
    #[test]
    #[ignore = "requires network access"]
    fn live_fetch_from_arxiv() {
        let papers = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_papers("cs.AI".into(), Some(5), None, None))
            .expect("live fetch should succeed");
        assert!(!papers.is_empty(), "expected at least one paper");
        let p = &papers[0];
        assert!(!p.title.is_empty());
        assert!(!p.authors.is_empty());
        assert!(p.pdf_url.starts_with("http"));
        eprintln!("live check: {} papers, first = {}", papers.len(), p.title);
    }
}
