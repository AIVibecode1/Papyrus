# Plan 060 — Reading history (opened papers, not only favorites)

**Priority:** P1 · **Effort:** S–M · **Depends on:** —

## Problem

Users open papers, forget to favorite them, and later cannot find “what I
read last week.” Favorites are intentional saves; **history is automatic**.

Already in the app (do not re-build):

- Per-paper **reading position** (page) in the PDF viewer
- Per-paper **chat** persistence
- **Favorites** (explicit bookmark)
- **Notes / highlights**

Missing: a chronological list of **papers the user opened in the reader**.

## Product rules

1. Every successful `reader.open(paper)` records or refreshes a history
   entry (local only).
2. History is **not** the same as favorites — separate lists, optional
   “Save” from a history row.
3. Cap size (e.g. **200** entries or **90 days**) so the store stays
   small; oldest dropped by `lastOpenedAt`.
4. Privacy: history stays on device; included in export/import only if
   export already packages user data (merge carefully).
5. Opening from history reuses the same reader path (position restore
   still works via existing page memory).

## Data model

```ts
// src/lib/types.ts or src/lib/history-types.ts
export interface ReadingHistoryEntry {
  paperId: string;
  title: string;
  authors: string[];      // denormalized for list without re-fetch
  published: string;      // ISO date string if known
  pdfUrl: string;
  categories: string[];
  source?: "arxiv" | "semanticscholar";
  /** Last time the reader was opened for this paper */
  lastOpenedAt: string;   // ISO
  /** Optional: last known page from position memory (display only) */
  lastPage?: number;
}
```

Storage options (pick one; prefer consistency with notes):

| Option | Pros | Cons |
| ------ | ---- | ---- |
| A. `localStorage` key `papyrus-reading-history-v1` | Fast, no Rust | Larger payloads awkward; cleared with site data |
| B. App-data JSON via Tauri (`history.json`) like notes | Survives, matches desktop model | Needs commands |

**Recommendation:** **B** if notes already use disk; else **A** for speed
of shipping, with the same JSON shape so migration to disk is easy.

## Work units

### 1. Store + persistence

`src/stores/history.ts` (Zustand):

```ts
interface HistoryState {
  entries: ReadingHistoryEntry[];
  loaded: boolean;
  load: () => Promise<void>;
  recordOpen: (paper: Paper) => void;  // upsert by paperId, move to top
  remove: (paperId: string) => void;
  clear: () => void;
}
```

- `recordOpen`: if id exists, update `lastOpenedAt` (+ title if changed);
  else prepend; trim to max length.
- Call `recordOpen` from `reader.open` **after** load reaches a
  non-error path (or immediately on open intent — prefer after PDF
  load succeeds so failed opens do not pollute history).

### 2. UI: History surface

Minimal, fits existing shell:

- Top bar or sidebar entry: **History** (clock icon), or a section on
  the papers page under Today’s picks / above the list when not searching.
- Prefer a dedicated view `view: "history"` **or** a filter chip on the
  papers list: Feed | Saved | History — fewer new routes.

Recommended UX:

1. Papers toolbar adds a third mode: **History** (alongside feed and
   favorites if favorites is already a toggle).
2. List rows = compact paper cards (reuse `PaperCard` or a denser row):
   title, date opened (“Opened 2 hours ago”), optional “page 12”.
3. Actions: Open · Save to favorites · Remove from history.
4. Empty state: “Papers you open will show up here.”

i18n: `history.title`, `history.empty`, `history.openedAt`,
`history.remove`, `history.clear`, `history.clearConfirm` — EN + AR.

### 3. Clear / privacy

Settings → Data: “Clear reading history” next to clear cache (does not
delete favorites or notes).

### 4. Tests

- `recordOpen` upserts and caps length
- reopen updates `lastOpenedAt` and order
- remove / clear
- component: empty state + one entry opens reader (mock)

### 5. Export (optional same PR)

If `export_data` includes favorites/notes, add `readingHistory` array;
import merges by `paperId` keeping the newer `lastOpenedAt`.

## Commits

1. `feat(history): store + persist reading history on successful open`
2. `feat(history): History list UI on papers surface`
3. `feat(settings): clear reading history`
4. `test(history): store and list coverage`

## Out of scope

- Cloud sync
- Time-spent analytics
- Auto-favorite after N minutes

## Agent anti-patterns

- Do not require the user to opt in before recording (history is the
  point); do allow clear-all.
- Do not replace favorites with history.
- Do not block `reader.open` on history write failures.
