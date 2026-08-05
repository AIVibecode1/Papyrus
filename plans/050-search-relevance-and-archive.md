# Plan 050 — Search must find archive papers (relevance + scope)

**Priority:** P0 · **Effort:** M · **Depends on:** —

## Problem (user evidence)

Searching for a known paper (e.g. DeepSeek work **Submitted on 22 Jan
2025**) fails to surface it. The feed “only returns the latest.”

## Root causes in current code

1. **Wrong sort for search** — `finish_arxiv_url` in
   `src-tauri/src/papers.rs` always emits:

   ```text
   sortBy=submittedDate&sortOrder=descending
   ```

   That is correct for **category browse** and **day browse**. For
   **keyword / fielded search**, arXiv should use:

   ```text
   sortBy=relevance&sortOrder=descending
   ```

   Otherwise every query is “newest papers that happen to match the
   words,” so foundational 2025 papers lose to 2026 mentions.

2. **Category clamp defaults on** — Rust:

   ```rust
   let limit_to_category = limit_to_category.unwrap_or(true);
   ```

   Frontend store also defaults `limitToCategory: true` (and persists
   it). A user sitting on `cs.AI` never sees a `cs.CL` / `cs.LG` hit
   even when the title match is perfect.

3. **Page size 20** without relevance means the real paper may be off
   page 1 under date sort; relevance usually puts it on page 1.

4. Possible secondary: active **year chips** or **day date** still
   applied during search (day should already be hidden — verify
   `date` is cleared or ignored when query is non-empty).

## Product rules (after this plan)

| Mode | sortBy | Category limit default |
| ---- | ------ | ---------------------- |
| Category browse (no query) | `submittedDate` desc | N/A (cat: only) |
| Day browse | `submittedDate` + day range | N/A |
| Text (query non-empty) | **`relevance`** desc | **Off** by default |
| Search + user enables “Limit to current field” | relevance | On |
| Search field = `id` | relevance or submittedDate (either OK; id is unique) | Off |

User can still switch sort in the UI later; backend must not force
date sort for free-text search.

---

## Work unit 1 — Rust: sort mode on URL builder

**File:** `src-tauri/src/papers.rs`

1. Change `finish_arxiv_url` to accept sort:

   ```rust
   enum ArxivSort {
       SubmittedDate,
       Relevance,
   }

   fn finish_arxiv_url(term: &str, max: usize, start: usize, sort: ArxivSort) -> Result<String, String> {
       let sort_by = match sort {
           ArxivSort::SubmittedDate => "submittedDate",
           ArxivSort::Relevance => "relevance",
       };
       // ... sortBy={sort_by}&sortOrder=descending ...
   }
   ```

2. `build_fetch_url` (browse / day) → `SubmittedDate`.
3. `build_search_url` (fielded search) → **`Relevance`**.
4. Default `limit_to_category` when `None` → **`false`** (change
   `unwrap_or(true)` to `unwrap_or(false)`).

### Tests (mandatory)

- `search_url_uses_relevance_sort` — URL contains `sortBy=relevance`.
- `browse_url_uses_submitted_date_sort` — category-only URL still
  `sortBy=submittedDate`.
- `search_url_without_limit_omits_cat` — default limit false → no
  `cat:cs.AI` in term unless explicitly true.
- Keep existing year-range and field-prefix tests green.

**Commit:** `fix(search): arXiv keyword search sorts by relevance; category limit defaults off`

---

## Work unit 2 — Frontend defaults + honesty in UI

**Files:** `src/stores/papers.ts`, toolbar/list, i18n

1. Default `limitToCategory` to **false** for new installs.
2. Migration: if stored value is missing, use false (do not force old
   `true` forever — or one-time reset when upgrading search behavior;
   document in release notes).
3. Status line when searching must show:
   - sort implication: “Best matches” / Arabic equivalent (not “newest”)
   - whether category limit is on
4. Checkbox label stays; default unchecked visually.
5. Optional: add store `searchSort: "relevance" | "date"` only if UI
   already has room — **not required** if backend always uses relevance
   for queries. Prefer backend-only fix to ship faster.

**Commit:** `fix(search): default limit-to-category off + status copy`

---

## Work unit 3 — Manual verification script (agent + human)

Against **live arXiv** (or recorded fixture if offline):

| Query | Field | Limit category | Expect first page includes |
| ----- | ----- | -------------- | -------------------------- |
| `DeepSeek` or `DeepSeek-R1` | all or title | off | Jan 2025-era DeepSeek paper(s) |
| `Attention Is All You Need` | title | off | 1706.03762 |
| `1706.03762` | id | off | that id |
| `transformer` | all | **on** + category cs.AI | only cs.AI (may exclude some hits) |

Also: clear search restores day/category feed with submittedDate order.

**Commit:** `test(search): regression tests for relevance URL + limit default`

---

## Out of scope

- Full-text search inside PDFs.
- Changing Semantic Scholar ranking (already relevance-ish).
- Redesign of the search chrome (051).

## Agent anti-patterns

- Do not “fix” search by only increasing `max_results`.
- Do not remove category browse sort-by-date.
- Do not leave `unwrap_or(true)` for limit_to_category.
