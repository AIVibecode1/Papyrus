# Tomorrow: the Reader feature (whole-PDF) + Markdown and Mermaid rendering

This file is a handoff plan for the Papyrus app. If the chat history is
gone, feed this file to the agent and it has everything needed to start.
Delete this file when the work is done.

## STATUS (updated during execution)

ALL PHASES DONE (2026-08-03):

- Phase 1: markdown + mermaid + KaTeX rendering (committed `0efa145`).
- Phase 2: in-app PDF reader (pdf.js viewer, page nav, zoom, find-in-page
  search, selection; Rust fetch + disk cache).
- Phase 3: whole-paper mentor walkthrough (text extraction, section
  splitting, step-by-step explanations, final synthesis).
- Phase 4: grounded paper chat (Ask tab, selection as context, per-paper
  history).
- 87 frontend tests + 39 Rust tests, all gates green, installers rebuilt.
- This file can be deleted.

## Context: what Papyrus is

Papyrus is an open-source Tauri 2 desktop app (Windows + macOS) at
`C:\Users\Hp\Desktop\My Agent Space\Papyrus`:

- Fetches the latest arXiv papers per field (cs.AI, cs.LG, cs.CL, cs.CV,
  cs.NE, stat.ML) plus keyword search.
- Explains papers with the user's own AI provider (OpenAI-compatible:
  base URL + API key + model), streamed, in English or Arabic (full RTL).
- API keys live only in the OS keychain (Rust, `keyring` crate).
- Bilingual EN/AR, light and dark mode, warm paper-toned design with a
  single ink-blue accent (redesigned with taste skills).
- Features already shipped: search, favorites, browse-by-day with
  auto-collected daily history (14 days backfill, 30 kept), research-
  mentor explanation prompts, lint/format/pre-commit hooks/CI, 52
  frontend tests + 29 Rust tests, installers (msi + nsis) built.

Read `AGENTS.md` in the repo root first: it has mandatory rules
(project-local installs only, security first, RTL first-class, i18n for
every user-facing string, and the Changelog Rule: every change must
update README.md "What changed since the first version" in the same
commit, including test counts).

## The user mandate on AI explanations (already implemented, keep it)

`src-tauri/prompts.json` is the single source of truth for AI prompts
(edit the JSON, never the Rust code). It currently contains:

- `systemPromptEn` / `systemPromptAr`: research-mentor persona for the
  abstract-level explanation, with natural-language style rules (no
  AI cliches, no exclamation marks, no invented details, explain every
  technical term, researcher thinking).
- `fullPaperStructureEn` / `fullPaperStructureAr`: the mentor's full
  section-by-section structure for whole papers (plain summary, main
  idea, concepts, equations, figures, weaknesses, takeaways, end-of-paper
  summary, five questions, researcher addendum). Saved and ready for the
  Reader feature.

Keep both languages in sync whenever prompts change. The contract tests
in `src/lib/__tests__/ai-contract.test.ts` assert prompt content; update
them when prompts change.

## The plan

### Phase 1: Markdown + Mermaid rendering in the app (do this first)

Today explanations render as plain text, and the prompts forbid markdown
tables. With a renderer, the AI can answer with rich markdown.

1. Add project-local deps: `pnpm add react-markdown remark-gfm` plus
   `pnpm add remark-math rehype-katex katex` (recommended: renders LaTeX
   equations, the mentor prompt explains equations so they matter).
2. Build a `Markdown` component (e.g. `src/components/markdown/`) that
   wraps react-markdown with custom renderers:
   - Styled to the design system (headings, lists, bold, code, blockquote,
     tables via remark-gfm).
   - RTL-aware: the container follows the UI direction so Arabic answers
     render correctly; code and equations stay LTR inside.
   - Links route through `@tauri-apps/plugin-opener` `openUrl` (same as
     paper-card.tsx) with a fallback for the browser preview.
   - No raw HTML from AI responses: do not enable rehype-raw.
3. Mermaid: a custom code-block renderer that detects fences with
   `language-mermaid` and renders the diagram:
   - Lazy-load the `mermaid` package dynamically (`import("mermaid")`)
     only when a diagram appears, to keep startup bundle small.
   - Configure `securityLevel: "strict"` (AI output is untrusted).
   - Theme must follow app light/dark (re-render on theme change).
   - Wrap diagrams in a scrollable container (they can be wide).
4. Use the Markdown component in the explanation panel
   (`src/features/papers/explain-panel.tsx`). The explanation store
   already coalesces stream chunks, so re-rendering per chunk is fine.
5. Once rendering works, relax the "no markdown tables" rule in
   prompts.json (both languages) so the AI can use tables when useful.
   Update the ai-contract tests accordingly.
6. Tests: component tests for the markdown renderer (headings, tables,
   links, mermaid block detection, RTL class) and keep counts in sync in
   README.

### Phase 2: In-app PDF viewer

- Embed pdf.js (project-local) in a new Reader view: render the paper
  PDF inside the app with a text layer (required for selection and
  search) and find-in-page search.
- Replace the current external-browser flow (opener plugin) with
  "open in app"; keep opening externally as an option.
- PDFs are untrusted remote content: render in a sandboxed context,
  never inject extracted text as HTML.

### Phase 3: Whole-paper mentor explanations

- Rust command to extract PDF text (pdf-extract crate or similar) with
  an on-disk cache keyed by arXiv ID + version (app data dir via Rust,
  not localStorage; papers are megabytes).
- Chunked map-reduce: split into sections, summarize each with the
  mentor structure, then combine. Stream each section with progress.
  Reuse the existing SSE streaming client in `src-tauri/src/ai.rs`.
- The full-paper structure prompts (already in prompts.json) power the
  section-by-section walkthrough; "wait for me after each section"
  becomes a step-through UI.

### Phase 4: AlphaXiv-style chat with the paper

- Select any passage in the viewer and ask about it; answers are
  grounded in the paper (retrieve the relevant chunk, no vector DB
  needed at this scale) and streamed in the current UI language.
- Chat history per paper, cached.

## Verification gates (run every phase, before committing)

This Windows machine has quirks. Ground truth:

- `pnpm run <script>` may print a cmd banner and exit 0 without running.
  Use `pnpm exec <bin>` for vitest/tsc/eslint/prettier, or the direct
  node bin: `node node_modules/vite/bin/vite.js build`.
- Rust needs `export PATH="$HOME/.cargo/bin:$PATH"` in each shell.
- Background processes must be wrapped: `bash -c 'node ...'` or
  `bash -c 'pnpm exec vite'`.
- Kill orphaned node processes via wmic + PowerShell Stop-Process.

Full gate list before each commit:
`pnpm exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm exec eslint .`,
`pnpm exec prettier --check .`, `cargo test --lib`,
`cargo clippy -- -D warnings`, `cargo fmt -- --check`,
`node node_modules/vite/bin/vite.js build`.

Browser preview for manual checks: `bash -c 'pnpm exec vite'` in the
project root, open http://localhost:1420 (mock data, no live arXiv).

## Definition of done

- All four phases implemented with tests, gates green, README changelog
  updated (problems solved + features added + test counts), commits
  per phase, installers rebuilt at the end (pnpm exec tauri build).
- Delete this file when finished.
