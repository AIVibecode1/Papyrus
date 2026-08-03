# Plan 009: Investigate the day-boundary timezone edge in date browsing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src/stores/digest.ts src-tauri/src/papers.rs src/stores/papers.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3 (investigate — LOW confidence the bug is real)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

Day browsing builds arXiv date-range queries in LOCAL time on the frontend
and compares them against UTC-based arXiv days. `todayStr()` in
`src/stores/digest.ts` returns the local date; the backfill and the day
picker then request arXiv days like `20260801`. arXiv stamps submissions by
UTC (US Eastern, actually — the arXiv day rolls at 00:00 ET), so a user in
a timezone ahead of UTC (e.g. UTC+3) can see "today = 2026-08-01" while
arXiv's 2026-08-01 batch is still 3 hours from starting — or already
labeled differently. The result would be a day with zero papers (the
"days with zero papers" symptom the project has seen before) or papers
landing on the wrong day. This plan is an INVESTIGATION: confirm whether
the mismatch is real and user-visible, then apply the smallest correct fix
or document the conclusion. It deliberately does not prescribe the fix
before the investigation.

## Current state

- `src/stores/digest.ts:14-15` — local-time "today":
  ```ts
  export function todayStr(): string {
    const d = new Date();
    ...formats YYYY-MM-DD from local components...
  }
  ```
- `src-tauri/src/papers.rs` — the date range is built as
  `submittedDate:[YYYYMMDD TO YYYYMMDD+1]` (the day plus one), i.e. a
  UTC-day window. The backfill loop (14 days) uses these ranges with the
  3 s arXiv politeness interval.
- `src/stores/papers.ts` `refresh()` — day views are cache-first via the
  digest store, then refreshed live with the same date string.
- History: the project already hit "days with zero papers" once (real
  arXiv zero-paper days on 2026-07-31 and 2026-08-01 were verified as
  genuine), so a timezone-shift bug would be easy to mistake for a genuine
  empty day.

## Commands you will need

| Purpose    | Command                                                 | Expected on success |
| ---------- | ------------------------------------------------------- | ------------------- |
| Tests      | `pnpm exec vitest run`                                  | all pass            |
| Typecheck  | `pnpm exec tsc --noEmit`                                | exit 0              |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | all pass            |
| Lint       | `pnpm exec eslint .`                                    | exit 0              |

## Scope

**In scope**:

- `src/stores/digest.ts` (only if the investigation confirms a fix)
- `src-tauri/src/papers.rs` (only if the fix belongs to the date-window
  construction)
- `src/stores/__tests__/digest.test.ts` (extend for the chosen fix)
- `src-tauri/src/papers.rs` tests (extend for the chosen fix)
- `plans/README.md` (status row)

**Out of scope**:

- Changing the backfill logic, retention, or the 3 s interval.
- Anything beyond the date-window semantics.

## Git workflow

- Branch: `advisor/009-day-timezone-investigation`
- Commit style: `fix: ...` if a fix lands, or `docs: ...` if the
  conclusion is "no change needed" (see Done criteria)
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Establish the actual semantics (read-only)

1. Read `src/stores/digest.ts` `todayStr()` and the day-picker construction
   in `src/features/papers/paper-list.tsx` (`formatDay`, `digestDays`).
2. Read `src-tauri/src/papers.rs` `build_fetch_url` (the
   `submittedDate:[A TO B]` branch) and the backfill loop.
3. Determine: which clock do all three agree on? Write a small throwaway
   test (do NOT commit it) or use `node -e` to print
   `new Date().getTimezoneOffset()` and the local vs UTC date at the
   current time, and reason about the 3-hour window around midnight local
   vs arXiv's day boundary (arXiv uses US Eastern — verify the current
   rule with a web search: "arXiv submission day boundary timezone", cite
   the source in your report per the audit rule; if the search is
   inconclusive, state it as unverified).

**Verify**: a one-paragraph written conclusion stating (a) what clock each
layer uses, (b) whether a user-visible mismatch exists, (c) the timezone(s)
affected.

### Step 2: Decide and fix (or document)

If the mismatch is real and user-visible:

- **Preferred fix**: make the day-window construction explicit about the
  boundary — either shift the day label to UTC in `todayStr()` (and every
  consumer of day labels: the picker, the digest keys, the backfill), or
  keep local labels but document that they approximate arXiv's ET day and
  accept the ±1-day skew near the boundary (smallest change, likely
  acceptable for a reader app).
- Add a regression test for the chosen semantics: e.g.
  `todayStr_is_utc_based` (fake timers at a known instant) or a comment-
  anchored test asserting the range construction uses the same day source
  as the labels.
- If the mismatch is NOT user-visible (e.g. the digest backfill re-fetches
  the same range the picker shows, so labels are internally consistent and
  the only cost is an occasional empty day that matches reality): document
  the conclusion in a short note appended to the digest store's comment
  block or in `docs/research/` (create a one-page note), and commit as
  `docs:`.

**Verify**: `pnpm exec vitest run` → all pass; `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Gates

**Verify**:

1. `pnpm exec vitest run` → all pass (with the new test if a fix landed)
2. `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass
3. `pnpm exec eslint .` and `pnpm exec prettier --check .` → clean

## Test plan

- If a fix lands: one regression test pinning the day-source semantics
  (fake timers + a fixed instant), plus a Rust test for the range
  construction if it changed.
- If the conclusion is "no change": no new tests; the investigation note
  is the deliverable.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] The investigation conclusion is written down (either a code fix with
      tests, or a documented "no user-visible bug" note)
- [ ] `pnpm exec vitest run` and `cargo test --manifest-path src-tauri/Cargo.toml --lib` pass
- [ ] `pnpm exec tsc --noEmit`, `pnpm exec eslint .`, `pnpm exec prettier --check .` clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The web search cannot confirm arXiv's day boundary (then the fix would
  be built on an unverified assumption — report and ask, or make the code
  fix independent of the boundary rule by anchoring everything to one
  clock).
- The fix turns out to require changing the digest storage format
  (`papyrus-digest-v1` keys) — that is a data migration, out of scope;
  report the need.
- Live arXiv probing (optional, ignored network test) contradicts the
  reasoning — report the evidence.

## Maintenance notes

- If a second paper source lands (plan 011), its "published" dates are
  calendar dates without timezones — the day-boundary question disappears
  for that source; keep this note in mind when reviewing that plan.
- Reviewer focus: internal consistency (labels, cache keys, and queries
  all from the same clock) matters more than matching arXiv's exact
  boundary — the bug class is mixed clocks, not the chosen boundary.
