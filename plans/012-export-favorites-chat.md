# Plan 012: Export favorites and per-paper chat as JSON

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src/stores/favorites.ts src/stores/reader.ts src/features/papers src/i18n/locales`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

The favorites list and the per-paper chat history are the two user-created
artifacts of the app, and both are one-directional: they can be saved but
never taken out. A researcher who curates 40 papers over weeks has no way
to back them up or move them to a reference manager (BibTeX/JSON), and a
good walkthrough conversation is lost when the machine changes.
Export-as-JSON is the smallest possible surface asymmetry fix: it needs no
new storage, no schema changes (the stores already hold the data), and it
works fully offline. This plan adds two export buttons — one on the Saved
view, one in the reader's Ask tab — producing a JSON file download via a
Blob (no Tauri fs plugin needed, so no capability changes).

## Current state

- `src/stores/favorites.ts` — `ids: string[]`, `byId: Record<string, Paper>`
  (the full Paper objects are stored, so an export has everything).
- `src/stores/reader.ts` — per-paper chat persisted under
  `papyrus-reader-chat-v1` (messages with `role`, `text`, `status`,
  `selection`); the current paper's chat is `chat` in the store state.
- `src/features/papers/paper-list.tsx` — the Saved view renders when
  `savedOnly` is true (line ~215-231).
- `src/features/reader/reader-view.tsx` — the Ask tab header area where a
  small export button fits next to the tabs.
- i18n: `en.json` / `ar.json` — `papers.*` and `reader.*` key families.

## Commands you will need

| Purpose   | Command                        | Expected on success |
| --------- | ------------------------------ | ------------------- |
| Tests     | `pnpm exec vitest run`         | all pass            |
| Typecheck | `pnpm exec tsc --noEmit`       | exit 0              |
| Lint      | `pnpm exec eslint .`           | exit 0              |
| Format    | `pnpm exec prettier --check .` | all files match     |

## Scope

**In scope**:

- `src/lib/export.ts` (create — pure export builders)
- `src/lib/__tests__/export.test.ts` (create)
- `src/features/papers/paper-list.tsx` (export button on the Saved view)
- `src/features/reader/reader-view.tsx` (export button in the Ask tab)
- `src/i18n/locales/en.json` + `ar.json` (export keys)
- `plans/README.md` (status row)

**Out of scope**:

- Tauri fs plugin / save-dialog (the Blob download works in the webview;
  a native save dialog is a nice follow-up, not this plan).
- Import (export is the asymmetry fix; import needs schema versioning).
- BibTeX generation — JSON first; BibTeX is a follow-up if requested.

## Git workflow

- Branch: `advisor/012-export-favorites-chat`
- Commit style: `feat: export favorites and chat history as JSON`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Pure export builders

Create `src/lib/export.ts`:

```ts
export interface FavoritesExport {
  app: "papyrus";
  kind: "favorites";
  exportedAt: string; // ISO timestamp
  papers: Paper[];
}

export interface ChatExport {
  app: "papyrus";
  kind: "chat";
  exportedAt: string;
  paper: { id: string; title: string };
  messages: { role: "user" | "assistant"; text: string; selection: string | null }[];
}

export function buildFavoritesExport(papers: Paper[]): FavoritesExport;
export function buildChatExport(paper: Paper, messages: ChatExport["messages"]): ChatExport;
export function downloadJson(filename: string, data: unknown): void; // Blob + a[download] click
```

`downloadJson` creates a `Blob([JSON.stringify(data, null, 2)],
{ type: "application/json" })`, an object URL, a temporary `<a>` with
`download={filename}`, clicks it, and revokes the URL. No Tauri APIs.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Unit tests

Create `src/lib/__tests__/export.test.ts`:

1. `buildFavoritesExport` includes all papers and the envelope fields.
2. `buildChatExport` filters to completed messages (the store's chat
   contains transient "loading" entries — the export must only include
   `status: "done"`/`"error"`/`"stopped"` messages, mapped to role/text/
   selection).
3. `downloadJson` triggers a click on an anchor with the right filename
   (mock `URL.createObjectURL`/`revokeObjectURL` and `document.createElement`
   in jsdom — the markdown test shows the jsdom setup).

**Verify**: `pnpm exec vitest run src/lib/__tests__/export.test.ts` → all pass.

### Step 3: Wire the buttons

- `paper-list.tsx` Saved view: an outline "Export" button (icon `Download`)
  next to the existing controls; onClick → `buildFavoritesExport` from
  `useFavoritesStore.getState().byId` values, `downloadJson("papyrus-favorites.json", ...)`.
- `reader-view.tsx` Ask tab: a small icon button in the tab header row;
  onClick → `buildChatExport(paper, reader.chat filtered)` →
  `downloadJson("papyrus-chat-<paperId>.json", ...)`.
- i18n keys: `papers.exportFavorites` ("Export" / "تصدير"),
  `reader.exportChat` ("Export chat" / "تصدير المحادثة").

**Verify**: `pnpm exec tsc --noEmit` → exit 0; `pnpm exec vitest run` → all pass.

### Step 4: Gates

**Verify**:

1. `pnpm exec eslint .` → exit 0
2. `pnpm exec prettier --check .` → clean
3. Manual smoke in the dev preview: save a paper → Saved view → Export →
   the file downloads with the expected contents; open the reader, ask a
   question, export the chat.

## Test plan

- Unit: `export.test.ts` (3 cases above).
- Existing suites stay green (no store changes).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/lib/export.ts` exists with the three functions
- [ ] `pnpm exec vitest run` → all pass incl. the new export tests
- [ ] Both buttons are wired (grep `buildFavoritesExport` in paper-list.tsx and `buildChatExport` in reader-view.tsx)
- [ ] Export i18n keys exist in both locales
- [ ] `pnpm exec tsc --noEmit`, `pnpm exec eslint .`, `pnpm exec prettier --check .` clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The chat message shape in `reader.ts` differs from the plan (check the
  `ChatMessage` interface — if it has more fields worth exporting, add
  them to the export type; do not export transient loading entries).
- The Blob download does not work inside the Tauri webview (WebView2
  supports it; if a smoke test shows otherwise, report the symptom —
  the fallback is a `data:` URL, but do not switch without evidence).

## Maintenance notes

- The export envelope (`app: "papyrus"`, `kind`, `exportedAt`) is the
  versioning seam for a future Import feature — keep it when the schema
  evolves.
- If plan 011 (S2 source) lands, `Paper` gains optional fields; the
  export includes them automatically (the whole object is serialized) —
  no change needed here.
- Reviewer focus: only completed chat messages export; the file names
  are stable and contain no user-controlled path characters.
