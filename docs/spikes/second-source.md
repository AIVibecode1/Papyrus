# Spike: Second paper source — Semantic Scholar / OpenAlex (plan 028, DIR-4)

> Design spike output — feeds a future build plan. When the maintainer picks
> it up, this document is the spec. See `plans/028-second-source-spike.md` for
> the spike brief. No app code was changed by this spike.

## 0. Drift check (plan vs. live tree)

| Plan claim                                                 | Live tree (verified 2026-08-02)                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Repo has no git commits yet"                              | Stale — 18 commits exist (baseline + plans 001–027). Commit workflow per operator instruction.                                                                                                 |
| `fetch_papers(category, max_results)` at `papers.rs:43-63` | Accurate but line-shifted — command is `src-tauri/src/papers.rs:52-94`; input validation `:58-68`; arXiv-only URL construction `:72-74`.                                                       |
| `Paper` struct at `papers.rs:17-25`                        | Line-shifted — `papers.rs:26-36`; `#[derive(Debug, Serialize, Deserialize)]` with `#[serde(rename_all = "camelCase")]`; all seven fields required (`String`/`Vec<String>`).                    |
| `src/lib/arxiv.ts` is the TS fetch wrapper                 | Accurate — `fetchPapers(category, maxResults)` at `arxiv.ts:25-37`; Tauri invoke vs. `src/dev/mock-papers.json` browser fallback.                                                              |
| REF1.md:20-35 API notes                                    | Archived (plan 022) but still in `docs/research/REF1.md`. **Stale on OpenAlex**: it claims "API key required now" — live probe 2026-08-02 shows keyless still works (smaller pool, see §2/§A). |
| Plan 025 (search) not landed                               | Correct — README row 025 is TODO; `fetch_papers` has no `query` param yet. This design composes with 025's `query` per the plan brief.                                                         |

**Stop-condition check**: neither endpoint requires authentication — Semantic
Scholar answered keyless (with HTTP 429, an AWS `TooManyRequestsException`, not
401/403) and OpenAlex answered 200 keyless. No stop triggered. One material
finding to design around (not a stop): **keyless Semantic Scholar is currently
unreliable in practice** — 429s from two different IPs (local + cloud) across a
~25-minute window; the design therefore treats a user-provided S2 key as the
recommended path and arXiv as the always-available fallback (per the brief's
own instruction: "the design must account for a user-provided key if so").

## 1. Recommendation

**Implement Semantic Scholar as the second source first, with an optional
user-provided API key (Settings → `x-api-key` header), and automatic fallback
to arXiv on any failure. Keep OpenAlex's mapping in this doc but ship it later
(or not at all) — it lacks TLDRs and its "latest papers" sorting is noisy
(§2).**

Rationale in four sentences: the app's core new signal is citation count, and
S2 returns `citationCount` + `tldr` + `venue` + `openAccessPdf` in a single
`/paper/search` call (REF1.md:23-33 wanted exactly this), whereas OpenAlex's
abstracts come back as an inverted index that must be reconstructed and its
`sort=publication_date:desc` surfaces future-dated records (§2.3 — live
evidence). The S2 keyless pool is shared and saturated (429s observed from two
IPs, §A), but a free key is 1 RPS — plenty for a desktop app that fetches
≤50 papers per refresh — so the design makes the key optional, never required
(AGENTS.md privacy-first: keys live in Settings, stored via the existing
keyring pattern, never hardcoded). Fallback to arXiv keeps the app working
even when the second source is down, and the `source` param composes with
plan 025's `query` on the same command, so both features land together as one
signature change.

### Why not the alternatives

- **OpenAlex first**: no TLDR; date-sorted "latest" results are polluted by
  records with imputed/future dates (a 2031-01-01 dissertation ranked #1 for
  "transformers" — §2.3); keyless pool is only ~100 requests/day (§2.2), so a
  heavy refresh day would need a key anyway. Keep the mapping for later.
- **Both sources behind one unified query language**: over-engineering for an
  MVP — the app's browse mode is arXiv-category-shaped; S2/OpenAlex are
  search-shaped. A per-source adapter with normalized `Paper` output (§2.1) is
  the seam; a unified filter grammar can come later if a third source ever
  lands.
- **No fallback (surface error only)**: the plan brief recommends fallback
  for MVP and so does this spike — a paper reader that shows an error page
  when the secondary source hiccups (S2's 429 reality makes this _likely_,
  not rare) is worse than silently serving arXiv data with a notice.

## 2. Field mapping

### 2.1 Target: the existing `Paper` struct (`papers.rs:26-36`)

```rust
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
```

**No existing field becomes optional.** Both sources normalize at parse time
(empty `authors` → `vec![]`, missing abstract → `""`, missing PDF → canonical
landing page URL). The frontend already tolerates empty `summary`
(`paper-card.tsx:77` → `papers.noAbstract`) and empty `categories`
(`paper-card.tsx:60` → id fallback), so required-ness is preserved and the
card keeps working unchanged.

**Three new optional fields** (backward-compatible: `Paper` is
`Serialize + Deserialize` with `rename_all = "camelCase"`, so the TS
`Paper` in `src/lib/types.ts:1-9` gains matching optional members and older
JSON payloads — and older frontends — keep working):

```rust
pub citation_count: Option<u32>,  // serde → "citationCount"; None for arXiv
pub tldr: Option<String>,         // S2 TLDR text; None for arXiv/OpenAlex
pub venue: Option<String>,        // S2 venue / OpenAlex primary_location.source.display_name
```

### 2.2 Semantic Scholar → `Paper` (official OpenAPI spec, live-fetched 2026-08-02)

Endpoint: `GET https://api.semanticscholar.org/graph/v1/paper/search?query=…&fields=…&limit=…`
Response batch (`PaperRelevanceSearchBatch`, from `/graph/v1/swagger.json`):
`{ total, offset, next, data }`. `data[]` items use the `BasePaper` schema —
verified field list from the live spec:

`paperId, corpusId, externalIds, url, title, abstract, venue,
publicationVenue, year, referenceCount, citationCount,
influentialCitationCount, isOpenAccess, openAccessPdf, fieldsOfStudy,
s2FieldsOfStudy, publicationTypes, publicationDate, journal,
citationStyles, authors` (all optional in the schema; `Tldr = { model, text }`,
`openAccessInfo = { license, status, disclaimer }`).

| S2 JSON                             | → `Paper`        | Notes                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paperId`                           | `id`             | **Prefix it** (`"s2:" + paperId`) — S2 ids are hashes, not arXiv ids; the prefixed id is the React key and ExplainPanel identity, and prevents cross-source collisions if a paper exists in both.                                                                                                        |
| `title`                             | `title`          |                                                                                                                                                                                                                                                                                                          |
| `authors[].name`                    | `authors`        | `AuthorInPaper` schema; `[]` if absent.                                                                                                                                                                                                                                                                  |
| `publicationDate` (YYYY-MM-DD)      | `published`      | Fall back to `year` (S2's `year` is an int; `String::from(year)`). Frontend does `new Date(paper.published)` (`paper-card.tsx:26-28`) — ISO date-only parses fine.                                                                                                                                       |
| `abstract`                          | `summary`        | Nullable in practice → `""`.                                                                                                                                                                                                                                                                             |
| `openAccessPdf.url`                 | `pdf_url`        | **Nullable** — when null, fall back to the paper landing page `url` (S2 canonical page). The card's button label is "Open PDF" (`papers.openPdf`); a landing page is the documented-acceptable fallback (arXiv's `parse_feed` already does this — `papers.rs:140` derives `https://arxiv.org/pdf/{id}`). |
| `fieldsOfStudy` / `s2FieldsOfStudy` | `categories`     | Very coarse (`["Computer Science"]`); take up to 3, prefer `s2FieldsOfStudy`. Card badge (`paper-card.tsx:59-61`) renders `categories[0]` — coarse but honest.                                                                                                                                           |
| `citationCount`                     | `citation_count` | The headline new signal.                                                                                                                                                                                                                                                                                 |
| `tldr.text`                         | `tldr`           | Free-tier field (see below).                                                                                                                                                                                                                                                                             |
| `venue`                             | `venue`          | `publicationVenue` as fallback.                                                                                                                                                                                                                                                                          |

**Free-tier status of `tldr` / `citationCount`** (official API page, 2026-08-02):
`citationCount` is a standard `BasePaper` field, no key needed. `tldr` is
defined on `FullPaper` in the spec; community usage confirms `fields=tldr` is
accepted on `/paper/search` unauthenticated, but **this spike could not verify
a 200 response live (persistent 429) — the tldr line is
"unverified — recommend manual check"** in a fixture test when the feature
builds. Neither field is tier-gated per the current docs.

**Rate limits** (official page, live 2026-08-02; plan brief's "~100 req/5min"
is outdated): unauthenticated = **1000 requests/second shared among all
unauthenticated users** + "further throttled during periods of heavy use";
free API key = **1 RPS introductory** on all endpoints. Observed reality:
429 `TooManyRequestsException` with body
`{"message":"Too Many Requests. Please wait and try again or apply for a key
for higher rate limits. …","code":"429"}`, no `Retry-After` header, followed
by connection-level drops from the same IP (see §A).

### 2.3 OpenAlex → `Paper` (live-verified 2026-08-02 with the exact planned query)

Endpoint: `GET https://api.openalex.org/works?search=…&sort=publication_date:desc&per_page=…`
Response: `{ meta: { count, page, per_page, cost_usd, … }, results: [ Work ] }`.
Work keys (live dump of one record): `id, doi, title, display_name,
publication_year, publication_date, type, cited_by_count, language,
authorships[], abstract_inverted_index, open_access, best_oa_location,
primary_location, topics[], primary_topic, ids, locations, counts_by_year,
concepts, …`.

| OpenAlex JSON                          | → `Paper`        | Notes                                                                                                                                                                                                       |
| -------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` (`https://openalex.org/W…`)       | `id`             | Prefix `"oa:" + <W-number>` (strip URL).                                                                                                                                                                    |
| `title`                                | `title`          |                                                                                                                                                                                                             |
| `authorships[].author.display_name`    | `authors`        |                                                                                                                                                                                                             |
| `publication_date` (YYYY-MM-DD)        | `published`      | Fall back to `publication_year`.                                                                                                                                                                            |
| `abstract_inverted_index`              | `summary`        | **Inverted index** (`{word: [positions]}`) — reconstruct by placing each word at its positions into a `Vec<Option<&str>>` and joining. ~20 lines; fixture-testable. `null` when the record has no abstract. |
| `best_oa_location.pdf_url`             | `pdf_url`        | Nullable; fall back to `primary_location.landing_page_url` ?? `id`.                                                                                                                                         |
| `topics[].display_name`                | `categories`     | Up to 3.                                                                                                                                                                                                    |
| `cited_by_count`                       | `citation_count` |                                                                                                                                                                                                             |
| (none)                                 | `tldr`           | OpenAlex has no TLDR field → `None`.                                                                                                                                                                        |
| `primary_location.source.display_name` | `venue`          | e.g. "Cairn.info", "RUCforsk (Roskilde University)" — live samples.                                                                                                                                         |

**Live-verified quirks (design-relevant, from the actual probe):**

1. **`sort=publication_date:desc` returns future-dated records.** Top hits
   were `2031-01-01` (dissertation) and `2028-01-01` (articles) — OpenAlex
   imputes `publication_date` (defaults to Jan 1 of a sometimes-wrong year).
   A "latest papers" UI fed raw OpenAlex sorting will show garbage. Mitigation
   for the future build: add `filter=from_publication_date:<today-60d>`, or
   filter post-parse.
2. **Plain `search=` is full-text search.** The query "transformers" returned
   French social-science theses that merely mention the word
   (`meta.x_query` shows it compiled to `fulltext.search`). Use
   `search=title_and_abstract:…` or require an explicit query for non-arXiv
   sources (§4, Open question 2).
3. **Keyless still works** (REF1's "key required" is stale) but the pool is
   small: `X-RateLimit-Limit: 1000` credits ≈ `$0.10`/day, one `/works`
   request costs 10 credits (`X-RateLimit-Cost-USD: 0.001`), i.e. **~100
   requests/day keyless**; with a free key: `$1`/day ≈ ~1000 requests/day
   (docs: "free but requires an API key … $1/day of free usage"). OpenAlex
   sends `X-RateLimit-*` headers on every response — the client can read
   `X-RateLimit-Remaining` and stop paging when it nears zero.

## 3. Command signature + rate-limit design

### 3.1 Signature (composes with plan 025's `query`)

```rust
// src-tauri/src/papers.rs — planned shape after plans 025 + 028 land
pub type PaperSource = String; // "arxiv" | "semanticscholar" | "openalex"

#[tauri::command]
pub async fn fetch_papers(
    category: String,
    max_results: Option<usize>,
    query: Option<String>,   // plan 025: search mode (arXiv: search_query=all:{query})
    source: Option<String>,  // plan 028: default "arxiv"
) -> Result<Vec<Paper>, String>
```

- `source` defaults to `"arxiv"`; unknown values → `Err("Unknown source")`
  (same validation style as `papers.rs:58-68`).
- Dispatch to `fetch_from_arxiv` (existing body, gains 025's query branch) /
  `fetch_from_semanticscholar` / `fetch_from_openalex`, each returning
  `Result<Vec<Paper>, String>`.
- Non-arXiv sources **require `query`** in v1 (see Open question 2): if
  `source != "arxiv" && query.is_none()` → `Err("Query required for this
source")`. Category is ignored for non-arXiv sources (S2 has no category
  browse; OpenAlex topic filtering is future work).
- TS mirror (`arxiv.ts:25`): `fetchPapers(category, maxResults, query?, source?)`
  → invoke args `{ category, maxResults, query, source }`. Browser mock
  fallback: keep serving mock JSON for `arxiv`; for other sources return `[]`
  (dev preview is degraded for non-arXiv until fixtures exist — mirror the
  existing mock pattern).
- `src/stores/papers.ts` gains `source` state beside 025's `query` state.

### 3.2 Rate-limit design (per-source limiters)

Replace the single arXiv limiter (`LAST_REQUEST`, `papers.rs:13, 39-50`) with
a per-source registry — one `OnceLock<Mutex<HashMap<&'static str, Mutex<Instant>>>>`
keyed by source name, keeping arXiv's 3 s interval exactly as-is:

| Source          | Interval                                | 429 handling                                                                                                                                                               |
| --------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| arxiv           | 3 s (unchanged, `papers.rs:8-9`)        | n/a (XML error → `Err`)                                                                                                                                                    |
| semanticscholar | 1.1 s (keyed); 1.5 s + jitter (keyless) | **No blind retry loop.** One retry after a 2 s pause (shared pool can free up), then propagate the error → fallback (§5). No `Retry-After` is sent, so fixed backoff only. |
| openalex        | 1 s (polite; API allows ~10 req/s)      | Read `X-RateLimit-Remaining` header; if < 20, stop paging and return what we have. 429 → propagate → fallback.                                                             |

Verified at execution time (2026-08-02): S2 keyed = 1 RPS (official page);
S2 keyless = 1000 req/s shared + heavy-use throttling (official page; 429s
observed); OpenAlex = ~100 req/day keyless, ~1000 req/day with free key
(observed `X-RateLimit-*` headers + docs).

Optional S2 key plumbing (mirrors the AI-provider key pattern): Settings gains
an optional "Semantic Scholar API key" field → stored via the existing keyring
layer (same as provider keys, `ai.rs:113-126` pattern) → Rust command reads it
and sends `x-api-key` header when present. Never in the frontend store.

## 4. UI surfacing

**Citation count badge.** Render `citationCount` as a small mono badge next to
the existing category badge (`paper-card.tsx:59-61`), e.g. `⤷ 1,234` or
`"N citations"` via i18n. Trade-off: adds a second badge to a header that is
deliberately minimal; mitigate by keeping it `text-xs` muted and only when
`citation_count.is_some()`. Alternative (rejected for v1): moving it into the
meta line under the title — less scannable than a badge.

**TLDR as summary fallback.** `paper.summary || paper.tldr || t("papers.noAbstract")`
at `paper-card.tsx:77`. Trade-off: a TLDR is a model-generated one-liner, not
an abstract — showing it _instead of_ a present abstract would mislead; as a
_fallback_ for missing abstracts (common on S2: `abstract` is nullable) it is
strictly better than "No abstract available".

**Source switcher: Settings page** (recommended), not the sidebar footer. A
new "Paper source" select in Settings — next to where the S2 API key lives —
keeps all paper-source configuration in one place, mirrors the AI-provider
pattern (Settings owns integrations), and avoids cluttering the category
sidebar, which is the app's primary navigation. Trade-off: two clicks to
switch instead of one. Sidebar-footer alternative (rejected): faster to reach
but visually noisy, and the footer has no established home for controls today.

**Fallback notice.** When the chosen source fails and arXiv serves the list, a
small dismissible notice above the list: `"Semantic Scholar is unavailable —
showing arXiv results."` (i18n: `papers.sourceFallback`). The list itself is
indistinguishable from a plain arXiv fetch, so the notice is the only honesty
mechanism (§5).

## 5. Fallback semantics

**Yes: fall back to arXiv, with the error surfaced.** MVP behavior:

1. `fetch_papers(source=…, query=…)` → source-specific fetch fails (network,
   429 after the single retry, 5xx, malformed payload) → log the source error.
2. If `source != "arxiv"`, re-run with `source = "arxiv"` (arXiv's category
   browse ignores `query` in v1 — plan 025's `all:{query}` branch applies when
   query is present; if the user searched, arXiv searches `all:` terms).
3. Return the arXiv results **plus** a flag the frontend can read — cleanest
   is a second command return or an out-param channel; for the v1 signature
   sketch: return `(Vec<Paper>, Option<String>)` where the `Option` carries
   the original error message (frontend shows `papers.sourceFallback` when
   `Some`). This is an IPC shape change; alternative (rejected) is string
   sniffing on `Err` — brittle, and plan 005's typed-marker philosophy argues
   for structured signals.
4. If arXiv _also_ fails, return the arXiv error (existing behavior). The
   fallback never masks a total outage.

Rationale: S2 keyless 429s are _expected_ (shared pool), so "error out and
make the user retry" would be a daily occurrence; arXiv is free, keyless, and
already integrated. The fallback notice keeps it honest. Edge: a user who
explicitly wants S2-only results can't get them in v1 — acceptable, and noted
in Open question 1.

## 6. Edge cases

1. **S2 429 → fallback mid-session.** The single retry + fallback path keeps
   the list populated; the notice explains why the citations badges are
   missing (arXiv rows have `citation_count: null` → no badge).
2. **`openAccessPdf` null on S2 / `best_oa_location` null on OpenAlex.**
   `pdf_url` falls back to the landing page URL; the card button still opens
   _something_ reachable. arXiv's `parse_feed` precedent (`papers.rs:140`).
3. **Empty authors / empty abstract.** Normalize to `vec![]` / `""` at parse
   time; card already renders both gracefully (`paper-card.tsx:66-73, 77`).
4. **S2 `fieldsOfStudy` is coarse** ("Computer Science" for nearly everything)
   — the badge shows it, which is better than nothing; do not block on it.
5. **OpenAlex future dates.** `published` parses as a valid ISO date, so the
   card renders "Jan 1, 2031" correctly-but-absurdly. Mitigation lives in the
   OpenAlex fetch layer (`from_publication_date` filter) when that source
   ships; v1 ships S2 first so this is a documented known issue, not a bug.
6. **ID collisions across sources.** `s2:<hash>` / `oa:<W-number>` / bare
   arXiv id prefixes guarantee uniqueness for React keys and
   `explanation.byPaper` (stored by `paper.id`). A paper fetched from two
   sources is two distinct cards with distinct explanations — acceptable for
   v1 (dedup by DOI is Open question 4).
7. **`max_results` cap** stays 50 (`papers.rs:11, 68`); S2 `limit` max is 100
   per request, OpenAlex `per_page` max 200 — pass the user's clamped value.

## 7. Open questions (for the maintainer)

1. **Ship S2 with keyless-only first, or require the key setting?**
   _Recommendation: keyless works with fallback; the Settings key is optional
   from day one._ Keyless 429s degrade gracefully to arXiv (§5), and a
   mandatory key would block the "just works" story AGENTS.md wants.
2. **Category browse for non-arXiv sources?** _Recommendation: no — search
   only in v1._ S2's `fieldsOfStudy` filter (e.g. `Computer Science`) is
   semantically sloppy, and OpenAlex topic filtering needs taxonomy research.
   The category sidebar keeps meaning "arXiv categories".
3. **One retry on S2 429, then fallback — enough?** _Recommendation: yes._
   A retry loop with no `Retry-After` header is guesswork; the fallback makes
   the app functional regardless. Revisit if S2 becomes the primary source.
4. **Deduplicate papers across sources by DOI?** _Recommendation: defer._
   v1 sources are mutually exclusive per fetch (one `source` per call); cross-
   source dedup only matters if a future feature merges lists.
5. **Should `tldr` ever replace a _present_ abstract?** _Recommendation: no —
   fallback only (§4)._ TLDRs are generated, lossy, and sometimes stale;
   abstracts are ground truth. A settings toggle "prefer TLDR" is a cheap
   follow-up if users want it.

## 8. Effort estimate & test strategy

**Effort: M** (per plan 028). Breakdown: Rust (source dispatch, two parsers,
inverted-index reconstruction, per-source limiters, `x-api-key` plumbing) =
M; frontend (type + card badges + source select + fallback notice + i18n
en/ar) = S; tests = S-M.

**Test strategy — fixture-based parse tests per source, mirroring
`parses_atom_feed` (`papers.rs:204-218`):**

- `src-tauri/src/papers.rs` (or a `sources/` module): `parses_s2_search_batch`
  (fixture JSON with one paper containing all mapped fields + one with nulls:
  null abstract, null `openAccessPdf`, empty authors), `reconstructs_openalex_abstract`
  (inverted-index fixture → exact string), `parses_openalex_works`, and a
  `s2_id_is_prefixed` / `oa_id_is_prefixed` assertion. Fixtures are checked-in
  JSON files next to the tests (like `SAMPLE_FEED`), one per source.
- Live tests `#[ignore = "requires network access"]` mirroring
  `live_fetch_from_arxiv` (`papers.rs:294-307`) — one per source, and one
  asserting the 429-fallback path against the real API.
- Frontend (Vitest): card renders citation badge only when present, renders
  TLDR when summary is empty, renders fallback notice when the command returns
  the fallback flag; store test for `source` state passing through to invoke.
- Rate-limit unit tests: the per-source limiter registry (interval per source,
  no cross-source blocking — arXiv's 3 s must not delay an S2 fetch).

## 9. Interaction notes

- **Plan 025 (search)** — same command, same commit window: `query` and
  `source` land as one signature change (`papers.rs`, `arxiv.ts`,
  `papers.ts`). 025's `build_fetch_url` refactor is the natural home for the
  per-source URL builders.
- **Plan 027 (provider failover)** — no coupling; different command. The
  optional S2 key in Settings reuses the keyring pattern 027 documented
  (`ai.rs:113-126`) — do not duplicate key-loading code.
- **AGENTS.md** — "Semantic Scholar / OpenAlex can be added later": this spike
  stays a queue item until the maintainer green-lights the build plan.

## Appendix A — probe evidence (2026-08-02)

**Semantic Scholar** — `curl "https://api.semanticscholar.org/graph/v1/paper/search?query=transformers&fields=title,abstract,year,citationCount,tldr&limit=3"`
(plan 028's exact probe):

- 12:41 local: `HTTP/1.1 429`, `x-amzn-ErrorType: TooManyRequestsException`,
  `Content-Type: application/json`, body 174 bytes.
- Subsequent probes (~25 min): connection drops (`curl` exit 000) from the
  local IP; from a fresh cloud IP (Browserbase), 4 attempts → 4× `429` with
  body: `{"message": "Too Many Requests. Please wait and try again or apply
for a key for higher rate limits. https://www.semanticscholar.org/product/api#api-key-form", "code": "429"}`.
  No `Retry-After` header on any 429.
- Single-paper endpoint (`/paper/DOI:…`) answered 404 JSON (not 429),
  confirming the API tier responds when not throttled.
- OpenAPI spec live-fetched from `/graph/v1/swagger.json` — field lists in
  §2.2 are **spec-verified**; the runtime shape of a 200 `/paper/search`
  response (e.g. whether `tldr` is present keyless) is **unverified —
  recommend manual check** per the brief.
- Official rate-limit page (2026-08-02): keyless = 1000 req/s shared +
  heavy-use throttling; free key = 1 RPS; corpus 214M papers / 2.49B citations.

**OpenAlex** — `curl "https://api.openalex.org/works?search=transformers&sort=publication_date:desc&per_page=3"`
(plan 028's exact probe):

- `HTTP/1.1 200`, body 42,024 bytes, **keyless** (REF1's "key required now"
  is stale).
- Rate-limit headers: `X-RateLimit-Limit: 1000`, `X-RateLimit-Remaining: 990`,
  `X-RateLimit-Credits-Used: 10`, `X-RateLimit-Limit-USD: 0.1`,
  `X-RateLimit-Remaining-USD: 0.099`, `X-RateLimit-Cost-USD: 0.001`,
  `X-RateLimit-Reset: 40736` → keyless pool ≈ $0.10/day ≈ 100 requests/day
  (10 credits each); docs: free key → $1/day.
- Response shape fully live-verified (§2.3), including the two quirks
  (future-dated results; full-text search noise). Open-access PDF URLs
  present via `best_oa_location.pdf_url` on 2 of 3 sample works
  (`oa_status: "green"`); the third was `closed` with no PDF.
- Local network was intermittent during the spike (connection-level failures
  for both hosts at times); the probes above are the successful captures.
