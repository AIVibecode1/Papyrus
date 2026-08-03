# Plan 016: Add a source adapter boundary for open-access discovery

> **Executor instructions**: Follow this plan step by step. This is a design/spike plan, not permission to implement every source. Run the read-only discovery checks first. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src-tauri/src/papers.rs src-tauri/src/citations.rs src/lib/arxiv.ts src/lib/types.ts src/features/settings/settings-page.tsx README.md`

## Status

- **Priority**: P2
- **Effort**: M (spike; implementation is a later plan)
- **Risk**: MED
- **Depends on**: none
- **Category**: direction | architecture | performance
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

Papyrus already has two distinct discovery behaviors: arXiv browsing by category/day and Semantic Scholar search/fallback. README explicitly identifies OpenAlex as a future source, and the user asked about free sources beyond arXiv and Semantic Scholar. Adding more providers directly to the current dispatch logic will increase source-specific branching, inconsistent date/search semantics, and duplicated error/fallback behavior. A small adapter boundary should be designed before implementation.

## Current state

- `src-tauri/src/papers.rs` owns the shared client, Paper shape, arXiv fetching, date queries, and source dispatch.
- `src-tauri/src/citations.rs` separately batches Semantic Scholar citation lookups and caches results.
- `src/lib/types.ts` defines the frontend Paper and provider contracts.
- `src/features/settings/settings-page.tsx` exposes only `arxiv` and `semanticscholar` source choices.
- README’s Features, How it works, Roadmap, and Technical choices sections describe arXiv as primary, Semantic Scholar as search-only, and OpenAlex as a future source.

## Discovery questions

Answer these before writing implementation code:

1. Which free source supplies a stable browse/search API without requiring a key: OpenAlex, Europe PMC/PubMed, DBLP, CORE, Crossref, or Unpaywall? Record current API limits and whether an email/key is required. Do not claim a source is free merely because its website is public.
2. Which sources can provide abstracts/full text and which only provide metadata or legal PDF links?
3. What normalized semantics should Paper expose for source, publication date, abstract availability, PDF availability, citations, venue, and open-access status?
4. Should a source support browse, keyword search, day browsing, citation enrichment, or only one subset? Do not force all sources into arXiv’s day model.
5. What is the fallback policy? Preserve the current honest fallback notice and never silently label a fallback result as the requested source.

## Commands you will need

| Purpose        | Command                                                 | Expected              |
| -------------- | ------------------------------------------------------- | --------------------- |
| Rust tests     | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | existing suite passes |
| Frontend tests | `pnpm run test`                                         | existing suite passes |
| Typecheck/lint | `pnpm run typecheck && pnpm run lint`                   | exit 0                |

## Scope

**In scope**:

- A new design/spike document under `docs/spikes/` describing one recommended source and rejected alternatives.
- Read-only API probing only after confirming the source’s current public documentation.
- A proposed normalized adapter interface and test fixture shape.
- README roadmap wording only if the operator later selects this spike for implementation; do not change source in this plan.

**Out of scope**:

- Adding a source now
- API keys or credentials
- Scraping websites
- Replacing arXiv or Semantic Scholar
- Ranking/recommendation algorithms

## Steps

### Step 1: Inventory existing source seams

Map every source-specific branch, request model, parser, fallback note, cache key, and UI label. Include exact paths and tests. Identify whether source choice is persisted and how switching invalidates current results.

**Verify**: the inventory names all source dispatch and UI locations and `cargo test --manifest-path src-tauri/Cargo.toml --lib` remains green.

### Step 2: Compare candidate sources

For each candidate, record API endpoint/documentation URL, authentication, rate limits, search/browse support, abstract/full-text availability, license/terms constraints, and failure modes. Use read-only web verification only; no code copied from external sources.

**Verify**: the spike document includes a source matrix and marks every unverified claim explicitly.

### Step 3: Define the adapter contract

Propose a Rust-side trait or explicit source modules with a normalized request enum: latest/browse, day, keyword search, and optional enrichment. Define source identity, pagination, deduplication, empty results, rate limits, and structured fallback metadata. Match the existing Paper shape unless a field is proven necessary.

**Verify**: include fixtures for success, empty, rate limit, malformed response, missing abstract, and missing PDF; no live network tests are required.

### Step 4: Recommend one small implementation slice

Choose one source only if it adds a capability Papyrus does not already have. Prefer OpenAlex for broad scholarly metadata only if its current API terms and limits are confirmed; otherwise recommend Europe PMC/DBLP for a clearly scoped domain. State why the other candidates are deferred.

**Verify**: the document ends with a small follow-up implementation plan and explicit non-goals.

## Done criteria

- [ ] Existing source branches and tests are mapped.
- [ ] Candidate claims have current, re-checkable sources or are marked unverified.
- [ ] Adapter contract handles source-specific capability differences honestly.
- [ ] Fallback metadata cannot mislabel results.
- [ ] No production source code is modified by this spike.

## STOP conditions

- The source has no stable documented API or its usage terms are unclear.
- A free source requires scraping or a credential the product cannot safely provision.
- Normalizing the source would require lying about dates, citations, abstracts, or PDF rights.
- The proposed source adds no user value over the current arXiv/Semantic Scholar pair.

## Maintenance notes

When a source is eventually implemented, update AGENTS.md-compatible release/version rules, add source-specific fixtures before parser code, and keep the fallback notice and source identity visible in the UI.

## Grounded evidence

- `README.md` Features / How it works / Roadmap: OpenAlex is named as a future source and Semantic Scholar is explicitly search-only.
- `src-tauri/src/papers.rs`: source dispatch and normalized Paper mapping are centralized enough to support a bounded adapter spike.
- `src/features/settings/settings-page.tsx`: source selection currently exposes exactly two choices, so a third source needs a deliberate capability label rather than a generic dropdown item.
