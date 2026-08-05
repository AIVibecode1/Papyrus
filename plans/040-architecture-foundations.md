# Plan 040 — Architecture foundations (shell, modules, design tokens)

**Priority:** P0 · **Effort:** L · **Depends on:** —

## Context

Papyrus works, but feature growth (search modes, notes, Codex, deeper
reader tools) will fight the current layout if boundaries stay fuzzy:

- Feature folders exist (`features/papers`, `features/reader`,
  `features/settings`) but cross-cutting UI (search chrome, day nav,
  status line) is concentrated in `paper-list.tsx`.
- Stores are per-domain (`papers`, `reader`, `settings`, `favorites`,
  `ui`) — good — but notes will need a new store and persistence path.
- Design tokens live in `src/index.css`; some components still risk
  one-off spacing/typography that breaks RTL or density consistency.
- Navigation is a simple `view` enum (`papers` | `reader` | `settings`)
  with no room for a Notes hub or Search workspace without crowding
  the papers feed.

This plan **does not** redesign the product. It prepares the skeleton
so 041–045 can land without rewriting the shell twice.

## Non-negotiables

1. Do not change user-visible product behavior except for neutral layout
   extraction (same screens, same copy).
2. Keep Tauri command surface stable; no new IPC in this plan unless a
   pure refactor of existing handlers is required for module boundaries.
3. Keep Zustand stores; do not introduce Redux/React Query.
4. Preserve skip-link, ErrorBoundary, and `h-dvh` overflow contract in
   `App.tsx`.

## Out of scope

- New search modes (041).
- Notes persistence (042).
- Codex / OAuth (043).
- Visual “redesign” or new color palette (044 only tunes).
- PDF virtualization (Round 3 plan 032 — do not re-implement here).

---

## Work unit 0 — Inventory (read-only, no commit)

Agent must open and summarize in the PR/plan notes:

| Area | Paths to read |
| ---- | ------------- |
| Shell | `src/App.tsx`, `src/components/layout/top-bar.tsx`, `src/stores/ui.ts` |
| Papers feed | `src/features/papers/paper-list.tsx`, `sidebar.tsx`, `today-picks.tsx` |
| Reader | `src/features/reader/reader-view.tsx`, `src/stores/reader.ts` |
| Settings | `src/features/settings/settings-page.tsx`, `src/stores/settings.ts` |
| Tokens | `src/index.css`, `src/hooks/use-theme.ts` |
| IPC | `src-tauri/src/lib.rs`, `papers.rs`, `ai/`, `citations.rs`, `pdf.rs`, `cache.rs` |
| i18n | `src/i18n/locales/en.json`, `ar.json` |

Document any `left`/`right` CSS, any hard-coded English strings, and any
component > 400 lines (candidates for split).

---

## Work unit 1 — View model extension (types only)

**File:** `src/stores/ui.ts`

Extend `View` carefully:

```ts
export type View = "papers" | "reader" | "settings" | "notes";
```

- Default remains `"papers"`.
- `setView` unchanged.
- Add unit test that notes is accepted and default is papers.
- **Do not** add Notes UI yet — only the route slot so 042 can mount.

**App.tsx:** add a branch:

```tsx
) : view === "notes" ? (
  <>
    <TopBar />
    {/* Placeholder until 042 — must not white-screen */}
    <main id="main-content" className="…">
      <NotesPage /> // can be a thin stub exporting "Notes coming" with i18n keys
    </main>
  </>
) : (
```

Stub component: `src/features/notes/notes-page.tsx` with translated empty
state only. TopBar gains a Notes entry (icon + label) next to Settings,
using existing button styles.

**Commit:** `feat(ui): add notes view slot and top-bar entry (stub)`

---

## Work unit 2 — Extract papers chrome

Split `paper-list.tsx` into focused components **without behavior change**:

| New file | Responsibility |
| -------- | -------------- |
| `src/features/papers/papers-toolbar.tsx` | Status line, source toggle, sort, day nav, search input host |
| `src/features/papers/papers-search-field.tsx` | Search input + clear button hook points (clear UI lands in 041) |
| `src/features/papers/paper-card.tsx` | Single card (if still inlined) |
| `src/features/papers/paper-list.tsx` | Composition + data wiring only |

Rules:

- Props, not new global stores.
- Keep all existing store selectors in the parent if that avoids churn;
  children receive values/callbacks.
- Move tests that target chrome into colocated tests; keep list tests green.

**Commit:** `refactor(papers): extract toolbar and search field from paper-list`

---

## Work unit 3 — Feature folder conventions

Add `docs/architecture.md` (short, agent-oriented):

```markdown
# Papyrus feature layout

- `src/features/<domain>/` — UI for one user domain
- `src/stores/<domain>.ts` — Zustand state for that domain
- `src/lib/` — pure functions + Tauri invoke wrappers (no React)
- `src-tauri/src/` — Rust commands; one module per IPC concern
- New user strings → en.json + ar.json same commit
- IPC args: camelCase in TS, serde rename in Rust
```

Also add a short “how to add a feature” checklist (store → IPC if needed →
UI → i18n → tests → plan commit).

**Commit:** `docs(arch): feature folder conventions for agents`

---

## Work unit 4 — Design token audit (no visual redesign)

In `src/index.css`:

1. Confirm tokens exist for: background, card, muted, primary, border,
   ring, destructive, radius, font sizes used by cards.
2. Add **density tokens** if missing (do not invent new hues):

```css
--space-card-y: 1rem;
--text-card-title: 0.9375rem; /* 15px target from plan 034 */
--text-card-meta: 0.75rem;
```

3. Wire `PaperCard` / extracted card to these variables via Tailwind
   arbitrary values **or** utility classes defined once in CSS — prefer
   one place.

4. Grep for `text-left`, `text-right`, `ml-`, `mr-`, `pl-`, `pr-`,
   `left-`, `right-` under `src/` and convert to logical equivalents
   where layout is directional. Leave `dir="ltr"` islands alone.

**Commit:** `refactor(ui): density tokens + logical property pass (no palette change)`

---

## Work unit 5 — Provider preset registry hygiene

**File:** `src/lib/types.ts` (`PROVIDER_PRESETS`)

- Ensure presets are the single source of truth for Settings quick-add.
- Add a typed helper `listProviderPresets(): ProviderPreset[]` if Settings
  currently iterates `Object.entries` ad hoc.
- **Do not** add Codex yet (043). Only make the registry easy to extend.

**Commit:** `refactor(settings): centralize provider preset listing helper`

---

## Work unit 6 — Persistence helper boundary

Notes (042) and search prefs (041) will need app-data JSON. Prepare a
**thin** frontend helper that only talks to existing or future invoke
commands — do not invent a second storage story.

If no generic `read_json_file` / `write_json_file` exists:

- Prefer domain-specific Rust commands in later plans (notes, search
  history) rather than a generic FS API (security).
- Document in `docs/architecture.md`: “persistence is always
  domain-scoped Tauri commands; webview never gets free filesystem.”

No code required beyond the doc if commands do not exist yet.

---

## Verification gates

```bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm exec prettier --check .
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Manual:

- App boots; papers / settings / reader still work.
- Notes stub opens from TopBar without error.
- Language switch EN↔AR does not break the new TopBar control.
- Theme cycle still applies `dark` class + `data-theme`.

## Commit strategy summary

1. `feat(ui): add notes view slot and top-bar entry (stub)`
2. `refactor(papers): extract toolbar and search field from paper-list`
3. `docs(arch): feature folder conventions for agents`
4. `refactor(ui): density tokens + logical property pass (no palette change)`
5. `refactor(settings): centralize provider preset listing helper`

## Agent anti-patterns

- Do not merge 041 search UI into this plan.
- Do not “clean up” reader store or PDF viewer here.
- Do not bump version numbers.
- Do not delete Round 3 plan files.
