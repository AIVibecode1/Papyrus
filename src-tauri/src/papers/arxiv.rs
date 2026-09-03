//! arXiv source: query URL building, input validation, Atom feed parsing,
//! and the arXiv fetch path.

use std::time::Duration;

use super::{Paper, rate_limit, shared_client, urlencode};

pub(crate) const ARXIV_API: &str = "https://export.arxiv.org/api/query";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Test hooks: let the unit tests point at local mock servers.
pub(crate) fn arxiv_url() -> String {
    std::env::var("PAPYRUS_ARXIV_URL").unwrap_or_else(|_| ARXIV_API.to_string())
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
pub(crate) fn build_fetch_url(
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
pub(crate) fn validate_year(year: u32) -> Result<(), String> {
    if !(1900..=2100).contains(&year) {
        return Err("Invalid year".into());
    }
    Ok(())
}

/// Fielded search options (plan 041): the arXiv field prefix, inclusive
/// year bounds, and whether the current category is ANDed onto the query.
#[derive(Clone, Copy, Default)]
pub(crate) struct SearchOptions<'a> {
    pub(crate) field: &'a str,
    pub(crate) year_from: Option<u32>,
    pub(crate) year_to: Option<u32>,
    pub(crate) limit_to_category: bool,
}

/// Builds the arXiv query URL for a fielded search (plan 041): maps the
/// field to its arXiv prefix (`all`/`ti`/`au`/`abs`/`id`), sanitizes the
/// term, appends the optional year range as a `submittedDate` range, and
/// optionally ANDs the current category. A day `date` takes precedence
/// over the year range (a single day is stricter).
pub(crate) fn build_search_url(
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

/// The arXiv path: validates input, enforces the arXiv rate limit, fetches
/// and parses the Atom feed. Fielded search (plan 041) applies when a
/// query is present; plain category/date browsing keeps the legacy URL
/// builder.
pub(crate) async fn fetch_from_arxiv(
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

#[cfg(test)]
pub(crate) const SAMPLE_FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
