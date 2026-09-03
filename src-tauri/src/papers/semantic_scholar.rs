//! Semantic Scholar source: search API fetch (with 429 retries) and
//! response parsing into the shared [`Paper`](super::Paper) shape.

use std::time::Duration;

use super::arxiv::validate_year;
use super::{Paper, rate_limit, shared_client, urlencode};

const S2_SEARCH_URL: &str = "https://api.semanticscholar.org/graph/v1/paper/search";
pub(crate) const S2_TIMEOUT: Duration = Duration::from_secs(20);

/// Retries on HTTP 429: Semantic Scholar's shared unauthenticated pool is
/// frequently saturated (spike §3.1) and a short wait usually clears it.
/// A persistent outage still falls back to arXiv via fetch_papers.
pub(crate) const S2_RETRIES: u32 = 3;
pub(crate) const S2_RETRY_DELAY_MS: u64 = 1500;

pub(crate) fn s2_search_url() -> String {
    std::env::var("PAPYRUS_S2_SEARCH_URL").unwrap_or_else(|_| S2_SEARCH_URL.to_string())
}

/// Fetches papers from the Semantic Scholar search API. Requires a
/// non-empty query; `start` maps to the API's `offset` for pagination.
/// Year bounds go in the `year` query param when both are present (S2's
/// documented range syntax); one-sided bounds cannot be expressed there,
/// so they are enforced client-side on the returned page (current-page
/// limitation, documented in plan 041).
pub(crate) async fn fetch_from_semanticscholar(
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
pub(crate) fn parse_s2_search(json: &str) -> Result<Vec<Paper>, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // S2 fixture tests
    // ------------------------------------------------------------------

    const S2_FIXTURE: &str = include_str!("../s2_fixture.json");

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
}
