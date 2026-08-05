# Plan 041 — Advanced search (old papers + modes + filters)

**Priority:** P0 · **Effort:** L · **Depends on:** 040

## Problem

Today Papyrus is strong at **latest digests** and weak at **library
search**:

- Keyword search uses arXiv `all:` (or Semantic Scholar when source =
  `semanticscholar`), but the UI does not expose fielded search
  (title / author / abstract), year ranges, or “search the archive”
  as a first-class mode.
- Day browsing covers history for the **current category’s collected
  digest**, not arbitrary historical queries.
- Plan 035 already called out clear-button, Esc, result context, and
  empty-state clear — implement those here if not already on `main`.
- Users expect alphaXiv-like ability to find **old** foundational papers
  without knowing the arXiv id.

## Product outcomes

1. User can choose a **search mode** and run a query against arXiv and/or
   Semantic Scholar.
2. User can restrict results by **year range** or **exact arXiv id**.
3. User can clear search in one click / Esc and return to the feed.
4. Status line always explains *what* is being shown (feed day vs search
   results vs empty).
5. Search preferences (last mode, last source) persist across sessions
   in settings store (local, not secrets).

## Non-negotiables

- All query construction happens in **Rust** (`papers.rs`); the webview
  never concatenates raw arXiv query grammar.
- Reject operator-injection characters in free text the same way
  `build_fetch_url` already does (keep that validation; extend carefully).
- Rate limits for arXiv and S2 stay enforced in Rust.
- No new API keys required for basic search (optional S2 key remains
  roadmap, not a blocker).

## Out of scope

- Full-text search inside cached PDFs (future spike).
- Vector / embedding search.
- Notes (042) — only leave a hook if a result card needs a “add note”
  later; do not implement notes here.
- Changing citation batch semantics (033).

---

## Current code map (read first)

| Piece | Location |
| ----- | -------- |
| Frontend fetch wrapper | `src/lib/arxiv.ts` → `fetchPapers(...)` |
| Papers store | `src/stores/papers.ts` (query, date, category, source, refresh) |
| Toolbar / list | `src/features/papers/papers-toolbar.tsx` (after 040), `paper-list.tsx` |
| Rust URL builder | `src-tauri/src/papers.rs` → `build_fetch_url`, `fetch_papers` |
| S2 path | `fetch_from_semanticscholar` in same file |
| Sort | `src/lib/paper-sort.ts` |

---

## Data model

### Search mode (frontend + IPC)

```ts
/** How the backend should interpret the free-text query. */
export type SearchField = "all" | "title" | "author" | "abstract" | "id";

export type SearchSource = "arxiv" | "semanticscholar" | "both"; // "both" = try S2 then merge/fallback policy documented below

export interface SearchRequest {
  query: string;
  field: SearchField;
  source: PaperSource | "both"; // keep PaperSource compatibility; prefer explicit
  /** Inclusive year bounds; optional */
  yearFrom?: number;
  yearTo?: number;
  category?: string; // optional category boost/filter for arXiv
  start?: number;
  maxResults?: number;
}
```

Prefer extending existing `fetchPapers` signature rather than a second
command, **unless** the arity becomes unreadable. If extending:

```ts
export async function fetchPapers(
  category: string,
  maxResults = 20,
  query?: string,
  date?: string,
  start = 0,
  source: PaperSource = "arxiv",
  field: SearchField = "all",
  yearFrom?: number,
  yearTo?: number,
): Promise<FetchPapersResult>
```

Rust side mirror with `#[serde(default)]` for new args so older frontends
do not break mid-dev.

### arXiv query mapping

| field | arXiv term |
| ----- | ---------- |
| `all` | `all:TERM` |
| `title` | `ti:TERM` |
| `author` | `au:TERM` |
| `abstract` | `abs:TERM` |
| `id` | `id:TERM` (normalize: strip `arXiv:`, version suffix optional) |

**Year range:** arXiv supports `submittedDate:[YYYYMMDD TO YYYYMMDD]`.
When `yearFrom`/`yearTo` set, AND that clause into the query. Default
range for “old papers” preset: e.g. `yearTo = currentYear - 1` is a
**UI preset**, not a backend default.

**Category + search:** when user is in a category and searches with
field ≠ id, optional AND `cat:cs.AI` (or current category). Expose a
checkbox “Limit to current field” default **on** for arXiv, **off** for
S2 (S2 has its own relevance ranking).

### Semantic Scholar

- S2 search API is relevance-ranked; fielded search is limited.
- When `field` is `title` or `author`, pass query as-is; document in UI
  that S2 does not support arXiv-style field operators.
- Year filter: use S2 `year` query param if available in current API
  usage; otherwise filter client-side on returned `publicationDate` /
  `year` **only for the current page** and document the limitation.
- `id` field on S2 source: resolve via arXiv id → S2 paper lookup if
  already implemented; else switch source to arXiv for id queries.

### Source policy for `"both"` (optional, implement only if cheap)

Recommended minimal policy:

1. If field is `id` → arXiv only.
2. Else try S2; on failure or empty, fall back to arXiv with same text
   mapped through field mapping; set `fallbackNote` as today.

If `"both"` is too much for one plan, ship `arxiv | semanticscholar`
only and leave `"both"` as a follow-up spike.

---

## UI specification

### Search field (041 + leftover 035)

In `papers-search-field.tsx`:

1. Text input (existing).
2. **Clear (X)** button when `query.length > 0`; click clears query,
   resets search results, restores feed (`refresh` without query).
3. **Escape** while focused does the same.
4. Debounce stays (existing timing); do not fire on every keystroke
   without debounce.

### Mode controls

Adjacent to the input (or a compact popover on small widths):

- Segmented control or select: All · Title · Author · Abstract · ID
- Source select: already exists; keep labels translated
- Optional year range: two numeric inputs or a preset chips row:
  - Any time
  - Last 5 years
  - 2017–2020 (example chips can be “Last 5 years”, “2010–2016”, “Before 2010”)
  - Custom

Chips must be pure UI that sets `yearFrom`/`yearTo` in the store; they
do not call network themselves.

### Status line

| State | Status text (EN concept) |
| ----- | ------------------------ |
| Feed + day | existing day context |
| Search active | Results for “query” · Field · Years |
| Search empty | No results for “query” + Clear search button |
| S2 fallback | existing dismissible fallback note |

Arabic strings: natural phrasing, not word-for-word English. Follow
user’s existing AR voice (clear Fusha/colloquial mix already in
`ar.json`).

### Day navigation interaction

When a search query is active:

- **Hide** day prev/next (search ignores date) — plan 035.
- Clearing search restores the previous day selection.

---

## Store changes (`src/stores/papers.ts`)

Add fields:

```ts
searchField: SearchField; // default "all"
yearFrom: number | null;
yearTo: number | null;
limitToCategory: boolean; // default true
```

Actions:

- `setSearchField`, `setYearRange`, `setLimitToCategory`
- `clearSearch()` — clears query + year overrides? **Decision:** clear
  query and field back to `all`, keep year chips unless user clears
  them separately. Document in code comment.
- `refresh` / `loadMore` pass new params to `fetchPapers`.

Persist non-secret prefs via existing settings persistence path if
available; else `localStorage` keys:

- `papyrus-search-field`
- `papyrus-search-limit-category`

Do **not** persist the raw query string (privacy + surprise on reopen).

---

## Rust implementation checklist

1. Extend `fetch_papers` command args with `field`, `year_from`, `year_to`,
   `limit_to_category` (bool).
2. Update `build_fetch_url`:
   - Map field → prefix.
   - Sanitize term (existing rules).
   - For `id`, normalize input.
   - Append submittedDate range when years present.
   - Optionally AND `cat:CATEGORY` when `limit_to_category` and category
     is a known code.
3. Unit tests in `papers.rs` (or existing test module):
   - each field produces expected `search_query` substring
   - years encode as `YYYYMMDD`
   - invalid characters still error
   - empty query with only years → either error or category browse;
     **prefer error** “Enter a search term” for pure year without query
     unless product wants browse-by-year (out of scope — keep day nav)
4. S2 path: ignore arXiv field operators; pass trimmed query; apply
   year filter as documented.

---

## Tests (frontend)

| Test | Assert |
| ---- | ------ |
| Clear button | visible iff query non-empty; click calls clear |
| Esc | keydown on input clears |
| Mode select | changing field updates store and triggers refresh mock |
| Status line | shows query fragment when searching |
| Empty state | shows clear action |
| RTL | search icon and clear button on correct edges with logical CSS |

Mock `fetchPapers` in store tests; do not hit network.

---

## Verification gates

All standard gates from plan 040, plus:

- Manual: search `Attention Is All You Need` with field Title + years
  2017–2017 → finds the paper (network).
- Manual: field ID `1706.03762` → single paper.
- Manual: Arabic UI, search still works; layout not mirrored incorrectly
  for LTR titles.
- CDP (if plan 035 script exists): clear restores feed.

## Commit strategy

1. `feat(search): fielded arXiv query mapping + year range in Rust`
2. `feat(search): papers store searchField / year range / clearSearch`
3. `feat(search): toolbar modes, year chips, clear + Esc, status line`
4. `test(search): unit + component coverage for modes and clear`
5. `docs(search): document search modes in README features table`

## Agent anti-patterns

- Do not build a second papers list page; enhance the existing feed.
- Do not send unsanitized user input to arXiv.
- Do not block the UI without skeleton/loading states already used.
- Do not remove category sidebar behavior.
