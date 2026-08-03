# Plan 008: Update the second-source spike to match the shipped citations feature

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- docs/spikes docs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (docs only — no code)
- **Depends on**: none (must land BEFORE plan 011, which builds from this doc)
- **Category**: docs
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

`docs/spikes/second-source.md` is the build spec for the Semantic Scholar
second source (plan 011). It was written before the citation-count feature
shipped, and it no longer matches the code in two ways: (a) §4 proposed the
citation count as a badge in the card header, but the implementation put
"Cited by N" in the meta line (`paper-card.tsx:104-111`) and built a
separate `src-tauri/src/citations.rs` command with a session cache; (b) the
doc's drift-check table (§0) says "Plan 025 (search) not landed — fetch_papers
has no query param", which is still true, but the table also needs a row
for the citations feature so the next reader of the doc knows it exists. A
stale spec produces a wrong build: plan 011 would duplicate the citations
plumbing it doesn't know about. This plan reconciles the doc with reality —
text-only, no code.

## Current state

- `docs/spikes/second-source.md` — key sections to update:
  - §0 drift-check table (rows verified 2026-08-02).
  - §1 Recommendation ("citationCount + tldr + venue ... in a single call").
  - §4 UI surfacing: "**Citation count badge.** Render citationCount as a
    small mono badge next to the existing category badge (`paper-card.tsx:59-61`)"
    — the shipped implementation instead renders `Cited by N` inside the
    meta line (`paper-card.tsx:104-111`), via `src/stores/papers.ts`
    `loadCitations` + `src-tauri/src/citations.rs` `fetch_citations`
    (batch endpoint, session cache, failure-proof).
  - §8 Effort estimate mentions tests for "card renders citation badge
    only when present" — the shipped card test equivalent lives in
    `src/stores/__tests__/papers.test.ts` ("loadCitations stores the
    returned counts", "refresh enriches the list with citation counts").
- `src/features/papers/paper-card.tsx:104-111` — shipped citation UI:
  ```tsx
  {
    typeof citationCount === "number" && (
      <>
        {" · "}
        <span title={t("papers.citedBy", { count: citationCount })}>
          {t("papers.citedBy", { count: citationCount })}
        </span>
      </>
    );
  }
  ```
- `src-tauri/src/citations.rs` — the shipped `fetch_citations` command
  (batch POST, `PAPYRUS_S2_URL` test override, session `CITATION_CACHE`).

Repo convention: the spikes are living specs — see `provider-failover.md`
§0 for how a drift check is formatted (a table of plan claims vs live
tree, with dates).

## Commands you will need

| Purpose | Command                                                    | Expected on success  |
| ------- | ---------------------------------------------------------- | -------------------- |
| Format  | `pnpm exec prettier --check .` (docs are prettier-checked) | clean                |
| Tests   | `pnpm exec vitest run`                                     | all pass (unchanged) |

## Scope

**In scope**:

- `docs/spikes/second-source.md` (text only)
- `plans/README.md` (status row)

**Out of scope**:

- `docs/spikes/provider-failover.md` — it matches the code (its drift table
  is current); do not touch it.
- Any code, any other doc, the README changelog (this is an internal spec
  reconciliation; note it in the commit message instead of a changelog row).

## Git workflow

- Branch: `advisor/008-update-second-source-spike`
- Commit style: `docs: reconcile the second-source spike with the shipped citations feature`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Update the drift-check table (§0)

Add rows to the table (keeping the existing rows and their dates):

- "Citation counts shipped" — YES: `src-tauri/src/citations.rs`
  `fetch_citations` (batch POST + session cache), frontend
  `src/lib/citations.ts` + `src/stores/papers.ts` `loadCitations`,
  card meta line `paper-card.tsx:104-111`.
- "Card citation UI" — shipped as a meta-line entry ("Cited by N"), NOT
  the badge proposed in §4; §4 is superseded (see Step 2).
- Verify the "Plan 025 not landed" row is still accurate (check
  `src-tauri/src/papers.rs` for a `query` param — it has none as of
  `692c0d0`).

**Verify**: the table renders and the new rows cite the exact files above.

### Step 2: Rewrite §4's citation-badge paragraph

Replace the "Citation count badge" paragraph with the shipped reality:

- The count renders in the meta line as `t("papers.citedBy")` with a
  title tooltip; cite `paper-card.tsx:104-111`.
- The fetch is a dedicated batch command (`citations.rs`) with a session
  cache; the S2 keyless reliability caveat (§A) applies to it too — plan
  005 adds a disk TTL cache.
- Keep the TLDR-as-summary-fallback paragraph and the source-switcher
  paragraph unchanged (both still planned, not shipped).
- Update §8's test-strategy bullet that says "card renders citation badge
  only when present" to reference the existing tests in
  `src/stores/__tests__/papers.test.ts`.

**Verify**: `grep -n "badge" docs/spikes/second-source.md` → the only
remaining "badge" mentions are historical (the word can stay in the
superseded note, but the proposal must be marked superseded, not current).

### Step 3: Add a "superseded" marker

At the top of §4, add one line: "Note (2026-08-03): the citation-count
half of this section shipped in commit `1fce618` in a different shape —
see the drift table. The remaining paragraphs (TLDR fallback, source
switcher) are still ahead of the code."

**Verify**: `pnpm exec prettier --check .` → clean; `pnpm exec vitest run` → all pass.

## Test plan

- No code tests. The only verification is that the doc's file references
  exist: `grep -n "paper-card.tsx" docs/spikes/second-source.md` shows the
  line numbers that match the live file (104-111), and
  `grep -n "loadCitations\|fetch_citations" docs/spikes/second-source.md`
  names the shipped symbols.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `docs/spikes/second-source.md` §0 table has rows for the shipped citations feature
- [ ] §4's badge proposal is marked superseded with the shipped shape described
- [ ] All file:line references in the updated doc match the live tree
      (spot-check with grep)
- [ ] `pnpm exec prettier --check .` → clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The live code has drifted again (e.g. the citation UI moved, or a
  `query` param landed in `papers.rs`) — update the table to the NEW
  reality and note the drift date instead of forcing the excerpts above.
- `provider-failover.md` needs changes — it is out of scope; report the
  need instead.

## Maintenance notes

- Plan 011 (Semantic Scholar second source) DEPENDS on this doc being
  current — land this first.
- When plan 005 (citation disk cache) lands, add a row for it here too
  (the doc's §A reliability discussion is where its rationale lives).
- Reviewer focus: the doc must distinguish "shipped" from "planned" at a
  glance — the drift table is the contract.
