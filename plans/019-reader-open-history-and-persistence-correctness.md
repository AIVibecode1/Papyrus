# Plan 019: Prevent stale reader opens and persistence failures

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src/stores/reader.ts src/stores/digest.ts src/stores/favorites.ts src/features/reader/__tests__ src/stores/__tests__`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: correctness | tests | architecture
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

The reader and daily-history stores perform asynchronous work that can outlive the user action that started it. A fast second paper open can allow the first PDF/text extraction to overwrite the active reader. Switching categories during the one-global backfill can leave the new category without history. Favorites persistence can also throw after the in-memory action, depending on storage availability. These failures are intermittent and need deterministic regression tests.

## Current state

- `src/stores/reader.ts:110-139` applies PDF and extracted-text results without an operation token tied to the latest `open()` call.
- `src/stores/digest.ts:52-53,80-83` uses one global `running` flag; a second category returns while the first backfill is active.
- `src/stores/favorites.ts:43-53` writes to `localStorage` without a guarded best-effort persistence boundary.
- Existing store tests are under `src/stores/__tests__/`; reader component tests are under `src/features/reader/__tests__/`.

## Commands you will need

| Purpose       | Command                                                                                                                               | Expected |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Store tests   | `pnpm exec vitest run src/stores/__tests__/reader.test.ts src/stores/__tests__/digest.test.ts src/stores/__tests__/favorites.test.ts` | all pass |
| Reader tests  | `pnpm exec vitest run src/features/reader/__tests__/reader-view.test.tsx`                                                             | all pass |
| Full frontend | `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run format:check`                                                       | all pass |

## Scope

**In scope**:

- `src/stores/reader.ts` and reader tests
- `src/stores/digest.ts` and digest tests
- `src/stores/favorites.ts` and favorites tests
- Reader integration test only if it can use existing mocks and fixtures

**Out of scope**:

- PDF virtualization or a pdf.js rewrite; that is a separate performance plan.
- New persistence libraries.
- Changing public Paper or chat shapes.

## Steps

### Step 1: Guard reader open results with an operation token

Create a monotonically increasing open-generation token, or equivalent cancellation mechanism. Capture it at the beginning of `open()` and apply loading, PDF, extraction, section, and ready/error state only if the token is still current. Preserve the latest paper’s loading state when an older operation resolves.

**Verify**: a delayed two-open test resolves paper A after paper B and asserts the store contains only B’s PDF/text/sections.

### Step 2: Make history backfill category-aware

Replace the single global suppression behavior with per-category in-flight tracking or a queued latest-category request. Switching from category A to B during A’s backfill must eventually schedule B without duplicate concurrent requests for B.

**Verify**: a controlled fetch test switches categories during an active backfill and asserts B is fetched once after scheduling.

### Step 3: Make favorites persistence best-effort

Update the in-memory favorite state independently from storage. Wrap storage writes in a narrow try/catch and keep the current in-memory action when storage is unavailable or quota-limited. Do not hide unrelated programming errors inside broad catches.

**Verify**: mock `localStorage.setItem` to throw, toggle a favorite, and assert the store updates without throwing.

### Step 4: Add malformed persisted-state tests

Extend focused tests for invalid reader chat entries, invalid digest dates/records, and malformed favorite payloads. Follow existing validation conventions and safely discard only invalid records.

**Verify**: malformed fixtures load without exceptions and valid records remain available.

## Done criteria

- [ ] Older reader opens cannot overwrite the latest paper.
- [ ] Category switching during backfill eventually loads the requested category.
- [ ] Favorite toggles remain usable when storage writes fail.
- [ ] Malformed persistence fixtures are handled safely.
- [ ] Targeted and full frontend gates pass.
- [ ] Only scoped files are modified.

## STOP conditions

- The reader has a supported concurrent-open use case that requires multiple active documents; report before enforcing a singleton token.
- A store’s persisted schema differs from this plan’s current-state description; update the plan rather than guessing.
- Fixing storage behavior would silently migrate or delete valid user data without a defined compatibility rule.

## Maintenance notes

Any new asynchronous store action must define stale-result behavior. Any new persisted structure must have a runtime validator and malformed-data test before it is read into Zustand state.

## Related plans

- Plan 015 covers PDF render lifecycle and split stability.
- Plan 018 covers AI stream ownership and cancellation.
- Plan 014 covers secure PDF fetching and cache identity.

## Evidence

- Frontend audit finding CORRECTNESS-01: stale PDF opens.
- Frontend audit finding CORRECTNESS-02: category-aware digest backfill.
- Frontend audit finding CORRECTNESS-03: failure-safe favorites persistence.
- Frontend audit finding ARCHITECTURE-01: shared runtime validation for persisted state.

No secrets are included in this plan.
