# Plan 028: Design spike — second paper source (Semantic Scholar / OpenAlex) (DIR-4)

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. The
> deliverable is a written design doc (Step 2) plus a read-only API probe
> (Step 1) if network access is available. Do not implement the feature.
>
> **Drift check (run first)**: the repo has **no git commits yet**. Compare
> the "Current state" excerpts against the live files; on any mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3 (direction — AGENTS.md explicitly says "Semantic Scholar
  / OpenAlex can be added later")
- **Effort**: M (spike; the eventual feature is M)
- **Risk**: MED (new API rate limits and schema drift to absorb)
- **Depends on**: plans/025 (search — the fetch command signature should
  grow a `source` param in the same design language)
- **Category**: direction (design spike)
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

arXiv-only means preprints only: no citation counts, venue, peer-review
status, or TLDRs. REF1.md:20-35 documents the value of Semantic Scholar
(TLDRs, citations, recommendations) and OpenAlex (250M+ works, date
sorting). For a paper-reading tool, citation count is a core signal that
would make the list view dramatically more useful. The fetch layer is one
command + one struct (`papers.rs:43`, `Paper` at `papers.rs:17-25`), so a
second source slots in cleanly — if the signature anticipates it.

## Current state

- `src-tauri/src/papers.rs:43-63` — `fetch_papers(category, max_results)`
  (plan 025 adds `query`) — single source (arXiv), single endpoint.
- `Paper` struct (`papers.rs:17-25`): `id, title, authors, published,
summary, pdf_url, categories` — no citation fields.
- `src/lib/arxiv.ts` — the TS-side fetch wrapper (invoke or mock fallback).
- REF1.md:20-35 — API notes (arXiv, Semantic Scholar `/graph/v1/paper/search`,
  OpenAlex `/works`) — archived by plan 022 but still in `docs/research/`.

## Commands you will need

| Purpose    | Command                                                                                                                                    | Expected on success   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| API probe  | `curl -s "https://api.semanticscholar.org/graph/v1/paper/search?query=transformers&fields=title,abstract,year,citationCount,tldr&limit=3"` | 200 + JSON            |
| API probe  | `curl -s "https://api.openalex.org/works?search=transformers&sort=publication_date:desc&per_page=3"`                                       | 200 + JSON            |
| Rust check | `cd src-tauri && cargo check`                                                                                                              | Finished, no warnings |

## Scope

**In scope** (the only files you should modify):

- `docs/spikes/second-source.md` (create — THE DELIVERABLE)

**Out of scope** (do NOT touch):

- Any app source file. The feature itself.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Probe both APIs (read-only)

- Run the two curl probes above (they're GET requests, no keys needed).
- Record in the design doc: response shapes (which fields map to
  `Paper`), rate-limit headers observed, whether results include
  open-access PDF URLs (Semantic Scholar: `openAccessPdf`; OpenAlex:
  `open_access` / `best_oa_location`), and whether `tldr`/`citationCount`
  are free-tier fields.
- If the network is unavailable, note that in the doc and proceed with
  the documented API shapes from REF1/docs (label them
  "unverified — recommend manual check").

### Step 2: Write the design doc

`docs/spikes/second-source.md` must contain:

1. **Field mapping table**: Semantic Scholar and OpenAlex JSON → `Paper`
   fields, including which `Paper` fields would become optional and what
   new fields to add (`citationCount?: number`, `tldr?: string`,
   `venue?: string`). Note `Paper` is `Serialize + Deserialize` — adding
   optional fields is backward-compatible with the frontend.
2. **Command signature**: `fetch_papers(category, max_results, query?,
source?)` where `source: "arxiv" | "semanticscholar" | "openalex"`
   (default `"arxiv"`); the rate-limit design (per-source limiters;
   Semantic Scholar unauthenticated ~100 req/5min, OpenAlex ~10 req/s —
   verify at execution time and cite the source).
3. **UI surfacing**: which new fields to render on the card (citation
   count badge next to the category badge? tldr as summary fallback?), and
   where the source switcher lives (sidebar footer? settings?) — 2-3
   sentences each with trade-offs.
4. **Fallback semantics**: if the chosen source fails, fall back to arXiv?
   (Recommend: yes for MVP, with the error surfaced.)
5. **Open questions** (max 5, with recommended answers) and an effort
   estimate (M) with the test strategy (fixture-based parsing tests per
   source, mirroring `parses_atom_feed`).

**Verify**: the doc exists and covers all five sections; no app code
changed (`git status` shows only the new doc).

## Test plan

- None (spike). The doc's test strategy section defines the future
  plan's tests (fixture-based per-source parse tests).

## Done criteria

- [ ] Both API probes executed (or explicitly marked unavailable)
- [ ] `docs/spikes/second-source.md` exists with all five sections
- [ ] No app source files modified
- [ ] `plans/README.md` status row updated (spike done; feature pending
      maintainer decision)

## STOP conditions

Stop and report back (do not improvise) if:

- Either API requires authentication for the probed endpoints (they
  shouldn't; Semantic Scholar works keyless at low rate) — report the
  auth requirements; the design must account for a user-provided key if
  so.
- The probes reveal the APIs have materially changed from the REF1 notes
  (e.g. OpenAlex now requiring a key) — report and design around the
  current reality.

## Maintenance notes

- The spike feeds a future build plan; AGENTS.md's "primary / later"
  wording means this stays a queue item until the maintainer picks it up.
- Plan 025's `query` param and this plan's `source` param compose on the
  same command — implement both together when the feature is greenlit.
