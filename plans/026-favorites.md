# Plan 026: Add favorites / reading list (DIR-2)

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

- **Priority**: P2 (direction — stated nice-to-have, REF2.md:28)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002 (test runner), 012 (localStorage validation
  pattern to mirror)
- **Category**: direction
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

The app has no memory of what a user read or found interesting — every
session starts from zero, so the "latest papers" feed is the only reason
to return. Favorites create return visits and are the foundation for the
daily-digest roadmap item (which stays a separate future spike). The
persistence pattern already exists (localStorage stores in settings.ts),
and `Paper` is a plain serializable struct.

## Current state

- `src/features/papers/paper-card.tsx:80-97` — two actions per card
  (Open PDF, Explain); no bookmark.
- `src/stores/papers.ts` — memory-only paper list; no saved set.
- `src/stores/settings.ts:13-14` — the localStorage persistence pattern to
  mirror (`STORAGE_KEY`, JSON parse with validation per plan 012).
- `Paper` type: `src/lib/types.ts:1-8` (plain JSON).
- i18n: `src/i18n/locales/en.json` / `ar.json`.
- UI views: `src/stores/ui.ts` — `view: "papers" | "settings"`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
| --------- | ------------------------ | ------------------- |
| TS test   | `pnpm test`              | all pass            |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/stores/favorites.ts` (create — zustand slice)
- `src/stores/__tests__/favorites.test.ts` (create)
- `src/features/papers/paper-card.tsx` (bookmark button)
- `src/features/papers/paper-list.tsx` (Saved filter toggle)
- `src/i18n/locales/en.json`, `ar.json` (strings)
- `src/features/papers/sidebar.tsx` (only if a "Saved" entry belongs
  there — optional; prefer the list-header toggle to keep scope tight)

**Out of scope** (do NOT touch):

- The Rust backend (no persistence needed — favorites are per-device,
  localStorage is correct for this and matches AGENTS.md's key rule: only
  API keys are forbidden from localStorage).
- The digest/notifications feature (future spike).

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Favorites store

Create `src/stores/favorites.ts`:

```ts
import { create } from "zustand";
import type { Paper } from "@/lib/types";

const STORAGE_KEY = "papyrus-favorites";

interface FavoritesState {
  ids: string[];
  byId: Record<string, Paper>;
  loaded: boolean;
  load: () => void;
  toggle: (paper: Paper) => void;
  isFavorite: (id: string) => boolean;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  ids: [],
  byId: {},
  loaded: false,
  load: () => {
    if (get().loaded) return;
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      const byId = (raw && typeof raw === "object" ? raw : {}) as Record<string, Paper>;
      const ids = Object.keys(byId);
      set({ byId, ids, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  toggle: (paper) =>
    set((s) => {
      const ids = s.ids.includes(paper.id)
        ? s.ids.filter((id) => id !== paper.id)
        : [...s.ids, paper.id];
      const byId = { ...s.byId };
      if (ids.includes(paper.id)) byId[paper.id] = paper;
      else delete byId[paper.id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(byId));
      return { ids, byId };
    }),
  isFavorite: (id) => get().ids.includes(id),
}));
```

- Load it in `App.tsx`'s existing `useEffect` (next to `loadSettings()`).
- Mirror plan 012's validation spirit: entries that aren't objects are
  dropped (keep it light — a shape check on `title`/`id` strings suffices;
  extend if plan 012's validator is reusable).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Bookmark button + saved filter

- `paper-card.tsx`: add an icon button (lucide `Bookmark` /
  `BookmarkCheck`; filled state when favorited) in the actions row:
  `onClick={() => toggle(paper)}`, `aria-pressed={isFavorite(paper.id)}`,
  i18n label `papers.save` / `papers.saved`.
- `paper-list.tsx`: add a toggle next to Refresh — `t("papers.savedOnly")`
  — when on, render only `favorites.byId` papers in their saved order
  (map `favorites.ids` to papers; if a saved paper's data is stale it
  still renders from `byId`). Empty state when no favorites: reuse
  `t("papers.empty")` or add `papers.noFavorites` — add the key.
- i18n EN: `save: "Save"`, `saved: "Saved"`, `savedOnly: "Saved"`,
  `noFavorites: "No saved papers yet. Tap the bookmark on any paper."`
- i18n AR: `save: "حفظ"`, `saved: "تم الحفظ"`, `savedOnly: "المحفوظة"`,
  `noFavorites: "لا توجد أوراق محفوظة بعد. اضغط على الإشارة المرجعية لأي ورقة."`

**Verify**: `pnpm exec tsc --noEmit` → exit 0; `pnpm run build` → exit 0.

### Step 3: Tests

Create `src/stores/__tests__/favorites.test.ts` (pattern: plan 004's
settings suite — localStorage cleared in `beforeEach`):

1. `toggle adds then removes` — toggle twice → ids empty.
2. `persists across load` — toggle a paper, create a fresh store state
   (`useFavoritesStore.setState({ loaded: false })`, call `load()`), assert
   the paper is still favorited.
3. `load with corrupted storage does not throw` — storage is `"not json"`
   → empty favorites, no throw.
4. `saved order is insertion order` — toggle A then B → ids `[A, B]`.

**Verify**: `pnpm test` → all pass.

## Test plan

- 4 tests in `src/stores/__tests__/favorites.test.ts`.
- Verification: `pnpm test` all pass; `pnpm run build` green.

## Done criteria

- [ ] Bookmark button on every paper card (EN + AR labels)
- [ ] "Saved" filter in the list header showing only favorites
- [ ] Favorites persist across restarts (localStorage)
- [ ] `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm run build` — all pass
- [ ] No Rust code modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Paper ids collide across arXiv versions (`v1`/`v2` suffixes) in manual
  testing — the id includes the version (`2607.12345v1`); if that's
  undesirable for favorites, normalize by stripping the version suffix in
  the store and report the decision.
- Plan 012's validator pattern doesn't exist yet — write the light shape
  check inline (noted in Step 1) and note it in the status row.

## Maintenance notes

- The daily digest (REF2.md:29) builds on this store — saved papers are
  the digest's input.
- If favorites ever need syncing across devices, that's a backend feature
  (out of scope; the local store is the right MVP).
- Reviewer: confirm the bookmark button doesn't trigger the card's
  expand-on-click (stopPropagation if the card root has a click handler).
