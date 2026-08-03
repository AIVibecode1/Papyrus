# Plan 011: Semantic Scholar as the second paper source (build from the spike spec)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src-tauri/src/papers.rs src-tauri/src/citations.rs src/lib/arxiv.ts src/stores/papers.ts src/features/papers src/i18n/locales`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. ALSO: plan 008 must have landed
> first (the spike doc must reflect the shipped citations feature before
> this plan builds on it).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 008 (spike doc reconciliation); plan 005 (citation
  disk cache — optional but recommended: this feature reuses its cache)
- **Category**: direction (build from `docs/spikes/second-source.md`)
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

arXiv is the only paper source today. The design spec in
`docs/spikes/second-source.md` (live-verified field mappings, rate-limit
design, fallback semantics — verified 2026-08-02) specifies Semantic
Scholar as the second source: search-shaped, returns citationCount + tldr

- venue + openAccessPdf in one call, with automatic fallback to arXiv on
  any failure. The value: users can search the full research corpus (not
  just the last weeks of arXiv), and papers that arXiv misses appear with
  citations. The spec's key reality: keyless S2 is unreliable (429s
  observed), so the design makes the optional Settings key + arXiv fallback
  the load-bearing paths — the app must never show an error page because
  the secondary source hiccuped. Read the spike FIRST; this plan is the
  execution checklist.

## Current state

- `src-tauri/src/papers.rs` — `fetch_papers(category, max_results,
query, date, start)` → arXiv only; `build_fetch_url`; `parse_feed`;
  `shared_client`; the 3 s arXiv limiter.
- `src-tauri/src/citations.rs` — `fetch_citations` (S2 batch, session
  cache) — the S2 integration seam that already exists.
- `src/lib/arxiv.ts` — `fetchPapers(category, maxResults, query?, date?,
start?)` → Tauri invoke or dev mock.
- `src/stores/papers.ts` — category/query/date state + refresh/loadMore.
- `src/features/papers/paper-card.tsx` — renders summary (line ~114-119,
  `paper.summary || t("papers.noAbstract")`), categories badge, meta line
  with citations (lines 104-111).
- `docs/spikes/second-source.md` §3 — the planned signature:
  `fetch_papers(category, max_results, query, source: Option<String>)`
  with per-source rate limiters; §2.2 the S2→Paper field mapping; §5 the
  fallback semantics (return `(Vec<Paper>, Option<String>)` fallback
  flag — the spike's §5.3 cleanest option).

## Commands you will need

| Purpose    | Command                                                            | Expected on success |
| ---------- | ------------------------------------------------------------------ | ------------------- |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --lib`            | all pass            |
| Rust lint  | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | clean               |
| Rust fmt   | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`        | clean               |
| Tests      | `pnpm exec vitest run`                                             | all pass            |
| Typecheck  | `pnpm exec tsc --noEmit`                                           | exit 0              |
| Lint       | `pnpm exec eslint .`                                               | exit 0              |

## Scope

**In scope**:

- `src-tauri/src/papers.rs` (source param + S2 fetch/parse + fallback +
  per-source limiter + tests)
- `src-tauri/src/citations.rs` (ONLY if plan 005 landed: reuse its disk
  cache; otherwise leave alone)
- `src/lib/arxiv.ts` (source param passthrough; browser mock returns `[]`
  for non-arXiv per the spike §3.1)
- `src/stores/papers.ts` (source state + fallback notice state)
- `src/features/papers/paper-list.tsx` (source switcher in Settings is
  the spike's recommendation — put the control in
  `src/features/settings/settings-page.tsx` instead if simpler; the
  fallback notice renders above the list)
- `src/i18n/locales/en.json` + `ar.json` (`papers.sourceFallback`,
  settings labels)
- `plans/README.md` (status row)

**Out of scope**:

- OpenAlex (the spike §1 recommends S2 first; keep the OpenAlex mapping
  in the doc, ship later or never).
- Category browsing for non-arXiv sources (spike open question 2:
  search-only for S2 in v1).
- Cross-source dedup by DOI (spike open question 4 — deferred).
- The optional S2 key in Settings is IN scope ONLY if time allows within
  the M budget — the spike §4 recommends shipping keyless with fallback
  first; a key field without the keyring plumbing is worse than none, so
  if the key plumbing does not fit, ship keyless and note the follow-up.

## Git workflow

- Branch: `advisor/011-semantic-scholar-source`
- Commit style: `feat: search Semantic Scholar with automatic arXiv fallback`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Read the spike; add the source dispatch in Rust

Read `docs/spikes/second-source.md` §2.2 (mapping), §3.1 (signature),
§5 (fallback). Implement in `src-tauri/src/papers.rs`:

1. Add `source: Option<String>` to `fetch_papers` (default "arxiv").
2. `fetch_from_semanticscholar(query, max)` → GET
   `https://api.semanticscholar.org/graph/v1/paper/search?query=...&fields=title,abstract,year,citationCount,venue,openAccessPdf,authors&limit=...`
   (fields per the spike's verified schema), parse to `Paper` per §2.2:
   id prefixed `s2:` + paperId; `published` from `publicationDate` with
   `year` fallback; `summary` nullable → `""`; `pdf_url` from
   `openAccessPdf.url` with landing-page fallback; `categories` from
   `s2FieldsOfStudy` up to 3; `citation_count` mapped (the `Paper` struct
   gains `citation_count: Option<u32>` — backward-compatible, serde
   camelCase, TS `Paper` gains the optional member).
3. Per-source limiter: arXiv keeps its 3 s interval; S2 gets a 1.1 s
   interval (the existing `LAST_REQUEST` pattern generalized into a
   small per-source registry — see the spike §3.2 table).
4. Fallback: when `source != "arxiv"` and the S2 fetch fails (network,
   non-200 after ONE retry with a 2 s pause, malformed payload), re-run
   the arXiv path and return `(papers, Some(source_error_message))`.
   Return type change: `Result<(Vec<Paper>, Option<String>), String>` —
   the `Option` is the fallback notice (the spike's §5.3 structured
   signal; `Err` only when arXiv ALSO fails).

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` compiles and existing tests pass (update the live-fetch and URL tests for the new signature).

### Step 2: Fixture-based parse tests

Mirror `parses_atom_feed` (`papers.rs` test module) with checked-in
fixtures (create `src-tauri/src/s2_fixture.json`):

1. `parses_s2_search_batch` — one paper with all mapped fields, one with
   null abstract / null `openAccessPdf` / empty authors.
2. `s2_id_is_prefixed` — id starts with `s2:`.
3. `fetch_papers_with_source_semanticscholar_requires_query` — the
   non-arXiv + no-query case returns `Err` per spike §3.1.
4. `fallback_to_arxiv_on_s2_failure` — mock the S2 URL (env override, the
   `PAPYRUS_S2_URL` pattern from citations.rs) with a 500, assert the
   result is arXiv data + `Some(error message)`.
5. The per-source limiter: assert the arXiv limiter is untouched (3 s)
   and S2 has its own interval (unit-test the registry's interval lookup).

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass (45 + new).

### Step 3: Frontend

- `src/lib/arxiv.ts`: `fetchPapers(..., source?: string)`; the invoke
  payload gains `source`; the dev-mock branch returns `[]` for
  non-arXiv sources (spike §3.1).
- `src/lib/types.ts`: `Paper` gains `citationCount?: number` (and
  `tldr?: string`, `venue?: string` if the spike's three optional fields
  are all in the parse — keep the TS type in sync with the Rust struct).
- `src/stores/papers.ts`: `source` state + `fallbackNote: string | null`;
  `refresh`/`loadMore` pass `source`; the resolve handles the new
  `(papers, note)` shape; `setSource` clears the list like `setCategory`.
- `src/features/papers/paper-list.tsx`: render a small dismissible notice
  above the list when `fallbackNote` is set, using
  `t("papers.sourceFallback")`; the control that sets `source` lives in
  Settings (a Select with arxiv/semanticscholar options — English labels
  fine, i18n keys provided).
- `src/features/papers/paper-card.tsx`: `paper.summary || paper.tldr ||
t("papers.noAbstract")` (TLDR as fallback only — spike §4).
- i18n keys EN/AR: `papers.sourceFallback` ("Semantic Scholar is
  unavailable — showing arXiv results." / Arabic equivalent),
  `settings.source` + options.

**Verify**: `pnpm exec tsc --noEmit` → exit 0; `pnpm exec vitest run` → all pass.

### Step 4: Store tests + gates

- Extend `src/stores/__tests__/papers.test.ts`: `source` passthrough to
  the fetch mock; fallback note stored and cleared on next refresh.
- **Verify**:
  1. `pnpm exec vitest run` → all pass
  2. `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` and `cargo fmt -- --check` clean
  3. `pnpm exec eslint .` and `pnpm exec prettier --check .` clean

## Test plan

- Rust: the 5 fixture/fallback tests (Step 2) — pattern: `parses_atom_feed`.
- Frontend: the extended papers store tests (Step 4).
- Manual smoke: dev preview with `source=semanticscholar` (browser mock
  returns `[]` — so manual smoke needs the Tauri app or a temporary
  browser mock; prefer a quick real-app smoke if the operator has a build
  handy, otherwise verify via the Rust live test `#[ignore]`:
  `cargo test --manifest-path src-tauri/Cargo.toml --lib live_s2 -- --ignored`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `fetch_papers` accepts `source`; `grep -n "fetch_from_semanticscholar" src-tauri/src/papers.rs` → match
- [ ] S2 fixture tests pass (parse, prefix, query-required, fallback)
- [ ] `Paper` (Rust + TS) has the optional citation/tldr/venue fields
- [ ] The fallback notice renders with `papers.sourceFallback` (i18n present in both locales)
- [ ] All gate commands clean; no files outside scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 008 has NOT landed (the spike doc is stale — do not build from a
  stale spec; report and wait).
- The S2 live API contradicts the spike's field mapping during
  development (e.g. `openAccessPdf` missing on search results) — the
  spike flagged `tldr` as "unverified — recommend manual check"; if a
  field is absent in practice, make it optional in the parse and note it;
  do not invent a mapping.
- The `(Vec<Paper>, Option<String>)` return change breaks the frontend
  in a way that needs a store redesign — report the shape problem; do not
  fall back to string sniffing (the spike explicitly rejects it).

## Maintenance notes

- The citations feature (already shipped) and this source share the S2
  API — the session cache in citations.rs and the disk cache from plan
  005 should serve both; dedupe the client code when both exist.
- The fallback notice is the honesty mechanism (spike §5): the list must
  look indistinguishable from a plain arXiv fetch, and the notice is the
  only way the user knows.
- Reviewer focus: failure paths — the fallback must never mask a total
  arXiv outage, and the S2 key (when added later) must live only in the
  keyring, never in the store.
