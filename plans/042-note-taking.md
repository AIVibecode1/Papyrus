# Plan 042 — Note-taking system (paper notes, highlights, free notes)

**Priority:** P0 · **Effort:** L · **Depends on:** 040

## Problem

Papyrus explains papers and lets users favorite them, but there is no
way to **capture thoughts** while reading. Research assistants need:

- Notes attached to a paper (and ideally a page / selection).
- A place to review notes later without reopening every PDF.
- Local-only storage (same privacy model as API keys: data stays on the
  machine).

## Product outcomes

1. From the reader, user can create a **paper note** (markdown text).
2. User can save a **highlight** from a text selection (quote + optional
   comment + page number when known).
3. **Notes hub** (`view === "notes"`) lists notes across papers with
   search/filter.
4. Notes survive app restart (disk via Tauri).
5. Export/import (existing `export_data` / `import_data`) includes notes
   when those commands are extended — same commit or immediate follow-up
   commit in this plan.

## Non-negotiables

- Notes never leave the device unless the user exports them.
- Webview does not get a generic filesystem API.
- Markdown notes render with the **same** safe markdown pipeline as AI
  output (no raw HTML).
- Deleting a favorite does **not** auto-delete notes (confirm if
  linking by paper id only).

## Out of scope

- Real-time collaboration / sync to cloud.
- Handwriting or image annotations on the PDF canvas.
- Full Zotero/Obsidian bidirectional sync (spike only).
- AI “summarize my notes” (can be 045 later).

---

## Data model

```ts
// src/lib/types.ts or src/lib/notes-types.ts

export type NoteKind = "note" | "highlight";

export interface PaperNote {
  id: string; // uuid v4
  paperId: string;
  paperTitle: string; // denormalized for hub list without re-fetch
  kind: NoteKind;
  body: string; // markdown; for highlights, user comment (may be empty)
  quote?: string; // required for highlight
  page?: number; // 1-based when known
  createdAt: string; // ISO
  updatedAt: string; // ISO
  tags?: string[]; // optional, keep simple: max 5 tags, short strings
}
```

Storage file (Rust):

- Path: `{app_data_dir}/notes.json`
- Shape: `{ "version": 1, "notes": PaperNote[] }`
- Atomic write: write temp + rename (or write then fsync pattern used
  elsewhere if any).

---

## Rust commands

Add module `src-tauri/src/notes.rs` and register in `lib.rs`.

```rust
#[tauri::command]
fn list_notes(app: AppHandle) -> Result<Vec<PaperNote>, String>;

#[tauri::command]
fn upsert_note(app: AppHandle, note: PaperNote) -> Result<PaperNote, String>;

#[tauri::command]
fn delete_note(app: AppHandle, id: String) -> Result<(), String>;
```

Validation:

- `id`, `paperId` non-empty; `body` + `quote` total size cap (e.g. 50 KiB
  per note, 2 MiB file).
- `kind == highlight` ⇒ `quote` must be non-empty after trim.
- Unknown fields ignored via serde.

Tests:

- round-trip upsert/list/delete on temp dir
- corrupt JSON → returns empty list or clear error without panic
- size limit rejected

**Capability:** commands run in default capability (same as other
app-data commands). No new webview FS permission.

---

## Frontend store

`src/stores/notes.ts`:

```ts
interface NotesState {
  notes: PaperNote[];
  loaded: boolean;
  filterPaperId: string | null;
  query: string;
  load: () => Promise<void>;
  upsert: (note: Omit<PaperNote, "id" | "createdAt" | "updatedAt"> & { id?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setFilterPaperId: (id: string | null) => void;
  setQuery: (q: string) => void;
}
```

Selectors:

- `notesForPaper(paperId)`
- `filteredNotes` for hub (query matches title/body/quote)

Load once on app start alongside favorites (`App.tsx`).

---

## UI surfaces

### A. Reader — Notes panel section

In `reader-view.tsx` (or a child `reader-notes.tsx`):

- Collapsible “Notes” block in the AI/side column **or** a tab next to
  chat/walkthrough (prefer tab if the side panel already uses tabs;
  otherwise a section below synthesis to avoid huge scope).
- List existing notes for `paper.id`.
- “Add note” → textarea + Save.
- For selection: if PDF text selection exists, “Save highlight” pre-fills
  `quote`. Page number: use current page from PDF viewer state if
  exposed; else omit.

Wire selection carefully:

- Do not break existing “copy selection” behavior.
- Highlight save is explicit (button), not automatic on every select.

### B. Notes hub page

`src/features/notes/notes-page.tsx` (replace 040 stub):

- Search input filters list.
- Group by paper title (or flat reverse-chronological — prefer
  reverse-chronological with paper title on each card).
- Click note → `setView("reader")` + open that paper if possible
  (reuse papers store open path / favorites cache). If paper not in
  memory, show note detail still, with “Open PDF” disabled or fetch by
  id if feasible.
- Delete with confirm.

### C. Paper card affordance (optional small)

On `PaperCard`, if note count > 0, show a small badge (note icon +
count). Clicking badge can open notes hub filtered to that paper.
Only if low risk; otherwise skip to keep plan focused.

---

## i18n keys (minimum)

```
notes.title
notes.empty
notes.add
notes.save
notes.delete
notes.deleteConfirm
notes.highlight
notes.quote
notes.comment
notes.searchPlaceholder
notes.forPaper
notes.saved
notes.loadError
```

EN + AR in the same commits as UI.

---

## Export / import

If `export_data` / `import_data` already package favorites + settings:

- Include `notes` array in the export JSON under a `notes` key.
- Import merges by note `id` (incoming wins or skip duplicates —
  **prefer:** same id → update if newer `updatedAt`).
- Tests for merge behavior.

---

## Verification gates

- Unit: notes store upsert/remove/filter
- Rust: file IO tests
- Component: notes page empty + list; reader add note (mock invoke)
- Manual: create highlight, restart app, note still present
- Manual: AR layout of notes hub
- Full gate suite

## Commit strategy

1. `feat(notes): Rust notes.json CRUD commands + tests`
2. `feat(notes): Zustand notes store + app load`
3. `feat(notes): reader notes panel + highlight save`
4. `feat(notes): notes hub page replaces stub`
5. `feat(notes): include notes in export/import`
6. `test(notes): component coverage for hub and reader section`

## Agent anti-patterns

- Do not store notes in `localStorage` only (too easy to lose; inconsistent
  with desktop app data dir).
- Do not put API keys or provider secrets into notes files.
- Do not render note markdown with `dangerouslySetInnerHTML` raw.
- Do not block PDF rendering on notes load.
