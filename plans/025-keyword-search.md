# Plan 025: Add keyword search across arXiv (DIR-1)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: the repo has **no git commits yet**. Compare
> the "Current state" excerpts against the live files; on any mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2 (direction — stated must-have in REF2.md:20)
- **Effort**: S-M
- **Risk**: LOW-MED (arXiv query syntax must be validated at the same
  boundary that validates categories)
- **Depends on**: plans/002 (test runner), 003 (store race fix — the search
  store extends the papers store)
- **Category**: direction
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

The browse loop only answers "what's new in these 6 buckets". A user who
wants papers about a topic, author, or term has no way to express it.
REF2.md:20 lists "custom keywords…" as a must-have. arXiv's API already
supports `search_query=all:<terms>` on the same endpoint — the fetch layer
just never sends it. Search is the difference between a feed and a tool.

## Current state

- `src-tauri/src/papers.rs:43-63` — `fetch_papers(category, max_results)`
  builds `search_query=cat:{category}` only.
- `src/lib/arxiv.ts:4-13` — six fixed categories; `fetchPapers(category,
  maxResults)` (lines 25-37) — browser fallback returns mock data by
  category key.
- `src/stores/papers.ts` — `category` is the sole selector; store race fix
  (plan 003) adds the sequence token.
- `src/features/papers/paper-list.tsx` — header row with refresh button.
- i18n: `src/i18n/locales/en.json` / `ar.json`.
- Mock data (`src/dev/mock-papers.json`) is keyed by category — search in
  the browser preview can filter the concatenation of all categories.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Rust test | `cd src-tauri && cargo test --lib` | all pass      |
| TS test   | `pnpm test`              | all pass            |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src-tauri/src/papers.rs` (optional `query` param)
- `src/lib/arxiv.ts` (pass query; browser fallback filters mocks)
- `src/stores/papers.ts` (query state)
- `src/features/papers/paper-list.tsx` (search input in the header)
- `src/i18n/locales/en.json`, `ar.json` (search strings)
- Tests: Rust (`papers.rs` tests) + TS (`src/stores/__tests__/papers.test.ts`)

**Out of scope** (do NOT touch):
- The explain flow; settings; anything else.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Rust — optional query parameter

In `src-tauri/src/papers.rs`:

- `fetch_papers` gains `query: Option<String>`:
  - Validate: if `Some(q)`, trim; require `1 <= len <= 200`; reject
    characters that break the arXiv query syntax: `[",:\"()]` — arXiv's
    `all:` field is phrase-ish; safe charset is alphanumerics, spaces,
    `-`, `_`, `+`, `*`?  — keep it conservative: reject `"`, `(`, `)`,
    `:` and `&` (URL-encoding is handled by reqwest, but the search_query
    grammar itself is the risk). Return `Err("Invalid search query")` on
    violation.
  - URL: when `query` is present, use
    `search_query=all:{query}` instead of `cat:{category}` (and skip the
    category term); keep `sortBy=submittedDate&sortOrder=descending`.
- Update the existing fetch tests: add `fetch_query_url_construction`
  (assert the URL string via a testable helper — extract
  `fn build_fetch_url(category: &str, query: Option<&str>, max: usize) -> String`
  if that makes it testable; do the same style as `build_chat_url` in ai.rs).

**Verify**: `cd src-tauri && cargo test --lib` → all pass.

### Step 2: Frontend — query state + input

- `src/lib/arxiv.ts`: `fetchPapers(category, maxResults, query?)` — pass
  `query` to the invoke; browser fallback: if query present, filter the
  concatenation of all mock categories by title/abstract/summary
  `toLowerCase().includes(q.toLowerCase())` and slice to maxResults.
- `src/stores/papers.ts`: add `query: string` state; `setQuery(q)` sets
  it and triggers `refresh()` (reusing the plan-003 sequence token);
  `refresh()` passes `get().query`.
- `src/features/papers/paper-list.tsx` header: add a search `Input`
  (shadcn, `dir="ltr"`? no — keep natural; placeholder from i18n) between
  the "Updated" text and Refresh. Debounce input 400 ms before
  `setQuery` (or submit on Enter — pick debounce; a `useEffect` with
  `setTimeout` and cleanup).
- i18n: `papers.searchPlaceholder` EN: "Search arXiv…" / AR:
  "ابحث في arXiv…". Also `papers.searching`? Reuse the existing loading
  skeleton (search shows the same loading state).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Tests

- Rust: URL construction tests (with/without query, invalid query chars
  rejected).
- TS (`src/stores/__tests__/papers.test.ts`): `setQuery triggers refresh
  with query` (mocked `fetchPapers` asserts the query arg); stale-response
  guard still applies to searches (extend the plan-003 race test with a
  query variant).

**Verify**: `pnpm test` → all pass; `pnpm run build` → exit 0.

## Test plan

- Rust: `fetch_query_url_construction` (2-3 cases).
- TS: query store test + race-with-query test.
- Manual: browser preview — type "transformer" → filtered mock results;
  Tauri app — real arXiv search works, Arabic placeholder renders.

## Done criteria

- [ ] `fetch_papers` accepts an optional validated `query`
- [ ] Search input in the papers header (debounced), i18n EN+AR
- [ ] `cd src-tauri && cargo test --lib` — all pass
- [ ] `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm run build` — all pass
- [ ] `grep -rn "search_query=all" src-tauri/src/papers.rs` — present
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- arXiv rejects the `all:` syntax with the chosen charset during manual
  testing — report the exact 400 response; adjust charset only after
  confirming with arXiv's API docs (info.arxiv.org/help/api).
- Plan 003 hasn't landed — the store changes here depend on its token
  pattern; run 003 first.

## Maintenance notes

- Plan 028 (second paper source) wants a `source` param on the same
  command — design `fetch_papers`'s new signature with that in mind
  (adding `query` now; `source` later is additive).
- The search state lives in the papers store — favorites (plan 026) must
  not conflate search results with category results.
- Reviewer: check the debounce cleanup (stale timeout firing after
  unmount is a classic leak).
