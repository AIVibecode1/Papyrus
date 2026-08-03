# Plan 013: Design spike — curated daily selection

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src src-tauri docs README.md`
> If the app has changed substantially (new feature surfaces) since this
> plan was written, note it in the spike's drift table — this is a DESIGN
> SPIKE: it produces a decision document, NOT implementation code.

## Status

- **Priority**: P3
- **Effort**: S (spike — investigation + design doc, no feature code)
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction (design/spike — see audit playbook §9: spikes
  produce a design doc, not a build)
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

The app's daily flow today is "open the app, see the newest 20 papers per
field, scan, read". The operator has stated (in earlier sessions, not in
the repo) that a curated daily selection — a small hand-picked set of the
day's most notable papers — is a desired next step. Nothing in the repo
implements it. This spike investigates how to ground it in the EXISTING
architecture with the least new machinery, and produces the decision
document `docs/spikes/curated-daily.md` that either recommends a build
plan or recommends against (the playbook's "not worth doing" is a valid
outcome). The spike's job is to answer: what is "curated" in an app that
has no editorial staff and no user accounts? Candidates to weigh:
citations-driven ranking (already have the data), AI-mentor selection
(one batch call per day using the user's own provider — consistent with
the privacy-first design), or per-user reading-history weighting.

## Current state

- `src/stores/digest.ts` — auto-collected per-day history per category
  (14-day backfill, 30-day retention, `byCategory[cat][date]`).
- `src/stores/papers.ts` — `citations: Record<string, number>` (S2 counts,
  session cache) and `refresh`/`loadMore`.
- `src-tauri/src/citations.rs` — S2 batch endpoint (the ranking signal
  source).
- `src-tauri/prompts.json` — the mentor prompts; an AI-selection prompt
  would follow the same contract (EN/AR pairs, writing-quality block).
- `src/features/papers/paper-list.tsx` — the list surface where a
  "Today's picks" section would render.
- User-intent evidence is NOT in the repo (the operator stated the wish
  in conversation) — the spike must state this grounding gap explicitly
  and treat the feature as an option, not a promise.

## Commands you will need

| Purpose   | Command                        | Expected on success |
| --------- | ------------------------------ | ------------------- |
| Typecheck | `pnpm exec tsc --noEmit`       | exit 0              |
| Tests     | `pnpm exec vitest run`         | all pass            |
| Format    | `pnpm exec prettier --check .` | clean               |

## Scope

**In scope**:

- `docs/spikes/curated-daily.md` (create — the spike deliverable)
- `plans/README.md` (status row)
- READ-ONLY investigation of the sources listed above. You may write a
  throwaway probe script under `/tmp` (NOT in the repo) to fetch live S2
  counts or run a sample AI-selection prompt against the mock server —
  do not commit probes.

**Out of scope**:

- ANY application code changes (spike only).
- `docs/spikes/provider-failover.md` and `second-source.md` — do not edit
  them; reference them.
- Building the feature, even if the recommendation is "build it" — the
  build gets its own plan (next number) after the operator approves the
  spike.

## Git workflow

- Branch: `advisor/013-curated-daily-spike`
- Commit style: `docs: spike — curated daily selection design`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Investigate the ranking signals

1. Read `src/stores/digest.ts` and `src/stores/papers.ts` fully — what
   per-day, per-paper data already exists locally (counts, citations,
   favorites, read history)?
2. Check `src-tauri/src/citations.rs` for the batch endpoint shape and
   session cache; estimate the cost of ranking a day's ~50 papers by
   citation count (one batch call — cheap).
3. Read `src-tauri/prompts.json` — assess whether an "select the 3 most
   notable papers from this list, explain why in one line each" prompt
   fits the existing contract (EN/AR, writing-quality rules, the
   language marker "اللغة العربية").
4. Read `src/features/papers/paper-list.tsx` — where a picks section
   would live and what empty/loading/error states it would need.

**Verify**: a short list of the concrete data sources and their shapes
(feed into Step 2's comparison).

### Step 2: Design the options and pick a recommendation

Write `docs/spikes/curated-daily.md` with:

1. **The grounding statement**: the wish comes from the operator's
   sessions, not the repo; the spike is an option assessment.
2. **Option A — citations ranking** (no AI): sort the day's papers by S2
   citation count. Pros: deterministic, free, offline-ish (cached),
   zero new prompts. Cons: citations lag new papers (a paper published
   today has ~0 citations — the signal is weak for a DAILY selection;
   this is the spike's critical finding to verify: what does a day-old
   paper's citation count look like? probe 3-5 papers from the last 48h
   via the S2 batch endpoint from a throwaway script and record real
   numbers).
3. **Option B — AI-mentor selection** (user's provider): one
   non-streaming batch call per day per category with a new
   `curationPromptEn/Ar`; the mentor picks 3 papers + one-line reasons.
   Pros: matches the app's core value (AI explanations), the prompt
   contract exists, results are explainable ("because ..." lines).
   Cons: costs the user's tokens daily, adds a new Rust command or
   reuses `explain_paper`'s machinery, non-deterministic.
4. **Option C — reading-history weighting** (personal): weight by the
   user's favorites/read papers' categories and authors. Pros: personal.
   Cons: sparse signal (few favorites), the app has no read tracking
   today (the reader store does not record reads).
5. **Recommendation**: pick ONE (the spike's opinion, with the trade-off
   table and the probe evidence). The likely shape: Option B with
   citation counts as the tie-breaker input, running on demand (a
   "Today's picks" button/section that generates once per day, cached
   per day in the digest-style store) — but VERIFY the citation-lag
   finding first; if day-old counts are effectively 0, Option A alone is
   dead and B becomes the primary recommendation.
6. **Build sketch if recommended**: the command signature, the store
   shape, the UI section, the i18n keys, the test plan — all sketched,
   sized, and listed as open questions (exact same structure as the
   existing spikes in `docs/spikes/`). Follow the format of
   `docs/spikes/provider-failover.md` (drift table + recommendation +
   why-not-alternatives + API sketch + UX + edge cases + open questions
   - effort + tests).

**Verify**: the doc exists, follows the existing spike format, includes
the citation-lag probe evidence (real numbers + date), and ends with a
clear recommendation (build / don't build / build-later).

### Step 3: Record the outcome

**Verify**:

1. `pnpm exec prettier --check .` → clean (the new doc is checked)
2. `plans/README.md` row for 013 marked DONE with a one-line outcome
   pointer to the spike doc.

## Test plan

- No code tests (spike). The deliverable is the decision document; its
  quality bar: a different model could turn its "build sketch" section
  into a plan without re-reading the app.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `docs/spikes/curated-daily.md` exists with: grounding statement,
      options A/B/C with trade-offs, probe evidence (real citation numbers
      for day-old papers, with date), a single recommendation, and a build
      sketch with open questions
- [ ] The doc's file references match the live tree (spot-check with grep)
- [ ] `pnpm exec prettier --check .` clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The S2 probe hits persistent 429s (the known keyless reality) — record
  the failure and still write the spike: "citation-lag probe: unverified
  due to S2 throttling — recommend manual check" is a valid, honest
  outcome per the audit rules; do NOT fabricate numbers.
- The operator's intent is ambiguous enough that the recommendation
  could mislead (e.g. "curated" could mean hand-picked-by-editors) —
  the spike must state the assumption it used and flag the ambiguity in
  the open questions, not silently pick one.

## Maintenance notes

- This spike's "build" decision lands as plan 014+ only after the
  operator reviews `docs/spikes/curated-daily.md`.
- The citation-lag finding also matters for plan 011 (S2 source): if
  day-old papers show ~0 citations, the S2 source's value for "latest
  papers" is weaker than for search — cross-reference the two docs.
- Reviewer focus: the probe numbers and their date; every claim in the
  trade-off table must trace to a file or probe, not vibes.
