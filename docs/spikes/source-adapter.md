# Spike: source adapter boundary for open-access discovery

Status: design spike (no production code changed). Companion to plan 016.
Written: 2026-08-04. Facts below were re-checked against each source's
current documentation on 2026-08-04; anything not directly verified is
marked explicitly.

## 1. Why this exists

Papyrus has two discovery behaviors with different semantics: arXiv
browsing by category and day, and Semantic Scholar keyword search with a
honest fallback to arXiv when the free tier is rate limited. README names
OpenAlex as a future source. Before a third source is added, the
source-specific branching should be mapped and an adapter contract
designed, so a new source cannot fork the dispatch logic, duplicate
error handling, or silently mislabel results.

## 2. Inventory of existing source seams

| Seam                | Location                                                   | What it does                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source choice state | `src/stores/papers.ts` (`source`, `setSource`, line 80)    | Switching clears papers, citations, error and the fallback note; source is persisted in `papyrus-source`                                                              |
| Dispatch            | `src-tauri/src/papers.rs` (`fetch_papers`, line 221+)      | `arxiv` browses categories/searches `all:`; `semanticscholar` is search-only; on non-arXiv failure it falls back to arXiv and the payload reports `source` truthfully |
| Rate limiting       | `src-tauri/src/papers.rs` (`rate_limit`, line 78)          | Per-source politeness registry: arXiv 3 s, Semantic Scholar 1.1 s; unknown sources get the arXiv interval                                                             |
| Paper normalization | `src-tauri/src/papers.rs`                                  | Both sources map into the same `Paper` shape (id, title, authors, published, summary, pdfUrl, categories)                                                             |
| Citation enrichment | `src-tauri/src/citations.rs`                               | Semantic Scholar batch lookups, disk TTL 7 days, session TTL same, per-entry timestamps                                                                               |
| Frontend fetch      | `src/lib/arxiv.ts`                                         | `fetchPapers(source, ...)`; `PaperSource` union lives here                                                                                                            |
| UI labels           | `src/features/settings/settings-page.tsx`                  | Exactly two choices: arXiv, Semantic Scholar                                                                                                                          |
| Fallback notice     | `src/stores/papers.ts` (`fallbackNote`) + `paper-list.tsx` | Shown only when a non-arXiv source failed and arXiv served the list; never claims the wrong source                                                                    |

Tests that pin the current behavior: `src-tauri/src/papers.rs` tests
(per-source parsing, fallback), `src-tauri/src/citations.rs` tests (TTL),
`src/stores/papers.ts` tests (source switching resets state, fallback
note), `paper-list.tsx` tests (fallback notice, day navigation).

## 3. Candidate source matrix (verified 2026-08-04)

| Source     | Auth                                                                                                                       | Rate limits                                                         | Search                    | Browse by date                 | Abstracts                                       | PDF links                                  | Verdict                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- | ------------------------------ | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| OpenAlex   | API key now REQUIRED for all requests (free key, usage-based: USD 0.10/day without key, USD 1/day with free key, then pay) | Credit-budget system, not fixed req/s                               | Yes (full-text + filters) | Yes (publication_date filters) | Yes (inverted-index format, needs decoding)     | Yes (open_access.oa_url, Unpaywall-backed) | Changed from keyless to keyed freemium; contradicts the keyless expectation    |
| Europe PMC | None                                                                                                                       | Polite-use guidelines, no registration                              | Yes (life sciences)       | Yes                            | Yes (37.8M)                                     | Yes (OA subset)                            | Wrong domain: biomedical, tiny CS coverage                                     |
| DBLP       | None                                                                                                                       | 429 + Retry-After on excess; be polite                              | Yes (q, h, f pagination)  | By year, not by day            | NO (metadata only)                              | Link/DOI to electronic edition             | No abstracts kills the AI explanation flow                                     |
| Crossref   | None (polite pool via mailto)                                                                                              | Public + polite pools, limits revised 2025-12-01; 503/429 on excess | Yes                       | Yes (from-pub-date filters)    | Sometimes (publisher-deposited; some copyright) | NO (DOI only)                              | DOI-centric metadata; spotty abstracts, no PDFs                                |
| CORE       | Free API key required                                                                                                      | Free tier limits (not re-verified this pass)                        | Yes                       | Partial                        | Yes (OA subset)                                 | Yes (OA subset)                            | Keyed; aggregator with overlap                                                 |
| Unpaywall  | No key, but an email query param is REQUIRED                                                                               | Polite-use                                                          | NO (DOI lookup only)      | No                             | No                                              | Yes (legal OA copies)                      | Enrichment-only, already partially covered by Semantic Scholar's openAccessPdf |

Verified from: developers.openalex.org (authentication/pricing),
dblp.org FAQ (rate limiting, search API), crossref.org REST API docs and
rate-limit announcement, europepmc.org/developers. CORE free-tier numbers
NOT re-verified this pass (marked unverified).

## 4. Recommended decision

Do not add a third source yet. Every candidate either requires a
credential (OpenAlex changed to keyed freemium, CORE), misses a
capability the product needs (DBLP has no abstracts, Crossref has spotty
abstracts and no PDF links), or is out of domain (Europe PMC). The
README-named candidate (OpenAlex) no longer matches the keyless,
privacy-first assumption it was chosen under.

Deferred, in order:

1. OpenAlex - revisit only if a free API key and the usage budget are
   acceptable to the product's privacy stance (the key is used for
   quotas, not data access; data itself is CC0). Adds broad
   cross-domain discovery, OA URLs, venues and concepts.
2. DBLP - if a CS venue/author directory is wanted later; clearly
   metadata-only, never for AI explanations.
3. Crossref - as a citation/DOI enrichment layer, not a discovery
   source.

The adapter contract below stays valid for whichever source qualifies
first.

## 5. Adapter contract (Rust, proposed)

A source module implements a small trait; dispatch picks it from a
registry, and the honest fallback stays at the dispatch level:

```rust
pub enum SourceRequest {
    Latest { category: String },          // arXiv-style day browse
    Search { query: String },             // keyword search
    Day { category: String, date: String } // explicit day browse
}

pub struct SourceResult {
    pub papers: Vec<Paper>,
    pub served_by: String,   // the REAL source id, never a lie
    pub rate_limited: bool,  // structured fallback signal
}

pub trait PaperSource: Send + Sync {
    fn id(&self) -> &'static str;
    /// What this source can honestly do; unknown capabilities are rejected
    /// at the UI level, not silently degraded.
    fn capabilities(&self) -> SourceCapabilities;
    async fn fetch(&self, req: SourceRequest) -> Result<SourceResult, String>;
}
```

Rules the contract must keep:

- The existing `Paper` shape stays; a source that cannot fill a field
  (e.g. missing abstract) leaves it empty and the UI shows the TLDR/no
  abstract fallback it already has. No invented values, ever.
- Every source registers its own politeness interval in the existing
  per-source rate limiter; unknown sources get the arXiv interval.
- Fallback metadata is structured (`served_by`), so the UI notice can
  never mislabel a fallback result as the requested source.
- Fixtures come before parsers: success, empty, rate-limit (429 +
  Retry-After), malformed JSON, missing abstract, missing PDF. No live
  network tests in the unit suite.

## 6. What was intentionally not done

- No production code changed; no source added; no API keys or
  credentials touched.
- No scraping of any website.
- No ranking or recommendation logic.
- No change to the arXiv/Semantic Scholar pair.

## 7. Follow-up (only if a source qualifies)

1. Confirm the qualifying source's terms again the day implementation
   starts (this matrix aged out once already).
2. Write fixtures, then the parser, then the module, then the dispatch
   entry; keep `served_by` visible in the settings source picker.
3. Bump version, README and release notes per AGENTS.md rules.
