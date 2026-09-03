# Papyrus feature layout

Agent-oriented map of the codebase. Read this before touching a feature
so new code lands next to the code it belongs with.

## Frontend (`src/`)

- `src/features/<domain>/` — UI for one user domain (papers, reader,
  settings, notes). Components here may read Zustand stores directly.
- `src/stores/` — Zustand state, one file per domain: `papers`,
  `papers-prefs`, `reader`, `reader-persist`, `explanation`, `settings`,
  `favorites`, `history`, `digest`, `notes`, `ui`. Stores are the only
  place that persists user data; each store keeps its localStorage keys
  as domain-scoped constants.
- `src/lib/` — pure functions and Tauri invoke wrappers (no React):
  `arxiv` (paper fetch), `citations`, `export`, `paper-sort`,
  `paper-text`, `pdf` / `pdf-text` / `pdf-position`, `picks`, `dates`,
  `stream`, `clipboard`, `safe-url`, `provider-errors` (key redaction),
  `types` (shared types + provider presets), `utils`, `reader-ai`, plus
  the split AI layer: `ai` (facade), `ai-contract`, `ai-operations`,
  `ai-browser-keys`, `ai-browser-chat`.
- `src/components/` — cross-cutting UI: `layout/` (top bar),
  `markdown/` (safe markdown pipeline), `pdf-viewer/`, `ui/` (shadcn
  primitives).
- `src/i18n/locales/` — `en.json` + `ar.json`. Every user-visible string
  goes through i18n; EN and AR land in the same commit, always.

## Backend (`src-tauri/src/`)

One Rust module per IPC concern, registered in `lib.rs`:

| Module       | IPC commands                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `papers/`    | `fetch_papers` (`mod`: routing + rate limits; `arxiv`: query sanitization + feed; `semantic_scholar`: search)                                                                                                             |
| `citations/` | `fetch_citations` (`mod`: S2 batch + OpenAlex fallback; `cache`: session + disk cache; `tests`: fetch-path suite)                                                                                                         |
| `ai/`        | explain/ask/stop, keychain (`save_api_key`, `get_key`, `has_api_key`, `delete_api_key`), provider test (`mod`: `ProviderConfig` + module wiring; `commands`, `keychain`, `prompts`, `registry`, `stream`; `tests`: suite) |
| `pdf/`       | `fetch_pdf` (`mod`: command + cache naming; `guard`: SSRF/DNS-pinning download pipeline)                                                                                                                                  |
| `history.rs` | `list_history`, `record_history`, `remove_history_entry`                                                                                                                                                                  |
| `cache.rs`   | `clear_app_cache`                                                                                                                                                                                                         |
| `export.rs`  | `export_data`, `import_data` (favorites + chats; never keys)                                                                                                                                                              |
| `notes.rs`   | `list_notes`, `upsert_note`, `delete_note` (app-data JSON, atomic write)                                                                                                                                                  |

Rules:

- Heavy logic lives in Rust; the webview only formats and displays.
- IPC args are camelCase in TS, serde `rename_all = "camelCase"` in Rust.
- New command args get `#[serde(default)]` so older frontends do not
  break mid-development.
- Rate limits for arXiv (3 s) and Semantic Scholar (1.1 s) are enforced
  in Rust, never in the webview.

## Security contracts (do not weaken)

- API keys live only in the OS keychain, read by Rust commands. The
  webview never stores or logs keys.
- The webview never gets a generic filesystem API. Persistence is always
  domain-scoped Tauri commands (notes.json via `notes.rs`, exports via
  `export.rs`, PDFs via `pdf.rs` cache); there is no free `read_json_file`
  / `write_json_file` IPC and there never will be.
- Remote providers must be HTTPS (loopback HTTP allowed for local models).
- The markdown pipeline escapes raw HTML; mermaid runs with
  `securityLevel: "strict"`.
- arXiv/S2 query strings are sanitized in Rust (`papers/`), never
  concatenated by the webview.
- Exports never contain secrets (no API keys, no provider configs).
- Tauri capabilities stay least-privilege (`capabilities/default.json`).

## Runtime flows

Paper, explanation, and key-storage flows:

- **Paper flow.** Picking a field (for example cs.AI) calls
  `fetch_papers`. Default source is the arXiv API (XML parsed into
  title, authors, date, abstract, categories, PDF link). The Settings
  source select switches to Semantic Scholar search (independent rate
  limits; citation counts, TLDRs, venues, PDF links mapped into the same
  `Paper` shape, automatic arXiv fallback). arXiv sends no CORS headers,
  so the browser cannot call it directly: fetching always happens in the
  backend.
- **Explanation flow.** Explain sends title + abstract with the key read
  from the OS keychain. Text streams back over a Tauri channel; Stop
  cancels through a typed signal. Keys never pass through the frontend.
- **Key storage.** Settings writes name, base URL, model, and key
  straight to the backend, which stores the key in the OS keychain. The
  frontend only ever knows whether a key exists, never its value.

## How to add a feature

1. Store first: `src/stores/<domain>.ts` with a domain-scoped
   `STORAGE_KEY` constant and persistence logic.
2. Backend if needed: Rust module + `tauri::generate_handler!` entry in
   `lib.rs`, with unit tests for validation and file IO.
3. UI: `src/features/<domain>/` components; prefer small focused
   components and props over new global stores.
4. i18n: add every string to `en.json` AND `ar.json` in the same commit.
5. RTL: logical CSS properties only (`ms`/`me`/`ps`/`pe`/`start`/`end`);
   paper titles, Latin author lists, PDF, mermaid, KaTeX and mono ids
   stay `dir="ltr"` islands.
6. Tests: unit tests for every store action and pure function; component
   tests for UI flows that can break RTL (with `dir="rtl"`).
7. Commit per logical concern, message format matching repo history
   (`feat(search): …`, `fix(rtl): …`).

## Design tokens

Theme colors, fonts, radii and density tokens live in `src/index.css`
(light / sepia / dark palettes via `data-theme` + `.dark`). Do not use
raw color utilities for theme surfaces; use the tokens. Density tokens:

```css
--space-card-y: 1rem;
--text-card-title: 0.9375rem; /* 15px card titles (plan 034) */
--text-card-meta: 0.75rem;
```
