# Plan 075: Virtualize long paper / history / saved lists

> **Executor instructions**: Match existing Papyrus list styling. Do not virtualize the PDF page canvas in this plan (already handled separately).
>
> **Drift check**: Read `src/features/papers/paper-list.tsx` list rendering and `paper-card.tsx` height behavior.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: Papyrus snapshot v1.1.8 (2026-08-07)

## Why this matters

PDF virtualization exists; the **papers feed** still maps the full visible array to `PaperCard` components. Large search results, history (up to 200), or big favorite sets mean heavy DOM and scroll cost on Windows WebView2.

## Current state

- `paper-list.tsx` renders `visiblePapers.map(...)` into cards inside a scrollable column.
- History list and saved-only mode similarly map full arrays.
- No `@tanstack/react-virtual` (or equivalent) in `package.json` at audit time — adding a dependency requires following `AGENTS.md` (project-local `pnpm add` only).

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Install (if needed) | `pnpm add <chosen-lib>` | lockfile updates |
| Tests | `pnpm test -- src/features/papers` | pass |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**

- `src/features/papers/paper-list.tsx`
- `src/features/papers/history-list.tsx` (if separate)
- Possibly a shared `VirtualPaperList` helper under `src/features/papers/`
- Tests for “renders N items without mounting all” if testable (or smoke that first/last open still works)

**Out of scope**

- Changing PaperCard design
- Windowing the reader AI panel
- Server-side pagination redesign (loadMore stays)

## Git workflow

- Branch: `advisor/075-virtual-paper-list`
- Commit: `perf(papers): virtualize long paper lists`

## Steps

### Step 1: Choose approach

Prefer **`@tanstack/react-virtual`** (common, maintained) **or** a minimal custom window if dependency policy is tight. Confirm with lockfile + AGENTS local install rule.

Estimate row height: PaperCard is variable height (abstract length). Use **dynamic measurement** or a generous estimated height + measureElement pattern from TanStack docs.

### Step 2: Implement virtual list for main feed

- Parent must be the existing scroll container (check which element scrolls — often a main column with `overflow-y-auto`).
- Preserve `loadMore` button after the virtual window or as a sticky footer outside the virtualizer.
- Keep keyboard/accessibility: links/buttons inside cards still focusable for mounted rows.

**Verify**: manual or component test — with 50 mock papers, DOM does not contain 50 full cards at once (query by role/title count).

### Step 3: History + saved modes

- Apply same virtualizer when `historyMode` / `savedOnly` lists are long.
- Empty states unchanged.

**Verify**: `pnpm test` papers feature tests.

## Test plan

- Mock 30+ papers; assert virtualizer parent renders; opening first card still calls reader open mock.
- Use existing `paper-card.test.tsx` / paper-list tests as patterns.

## Done criteria

- [ ] Long lists do not mount every card simultaneously
- [ ] loadMore / empty / error states still work
- [ ] RTL layout not broken (logical properties preserved)
- [ ] typecheck + tests green

## STOP conditions

- Scroll parent is ambiguous (window vs div) and wrong choice breaks sticky toolbar — stop and document scroll parent before shipping.
- Variable height cards cause jumpiness that cannot be fixed in-scope — ship feed-only virtualization with estimated heights and note follow-up.

## Maintenance notes

- Today’s picks strip stays non-virtual (max ~5).
- Reviewers: watch restored scroll position when returning from reader.
