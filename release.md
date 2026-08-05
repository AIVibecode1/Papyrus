# Papyrus releases

This file tracks every release of Papyrus: what shipped, what it was built
from, and the exact bullet points for the GitHub release description. It is
written for humans and for AI agents working in this repo.

Rules:

- Every release adds a section below and never deletes or truncates old
  sections: this file is a tracking log, like a quick changelog.
- Each section keeps its version number and the list of what was fixed
  or added in that version.
- The bullet points here are the source of truth for the GitHub release
  description. Copy them as-is.
- The test counts in each section must match the README "Testing and
  quality gates" row at the time of the release.
- Installer artifacts live in `src-tauri/target/release/bundle/` after a
  build. Attach the MSI and the NSIS setup exe to the GitHub release.

---

## v1.0.11 - 2026-08-05

Status: installers built, not yet published on GitHub.
Built from: a69fa84
Quality gates: 247 frontend tests, 96 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, release-integrity checker, CI on Windows and
macOS (artifacts uploaded on every run; tag v1.0.11 triggers a draft
release with both installers).

Live-verification round: every fix below was reproduced and verified in
the running app (dev preview and the built exe over WebView2 CDP) with a
real 74-page arXiv paper and real wheel input, not just unit tests.

- Fixed the black PDF pages for good: a page whose render was cancelled
  (zoom/refit) kept receiving the cancelled task's residual drawing, and
  the next render on the SAME canvas interleaved with it — the promise
  resolved "OK" while the canvas stayed 100% black or blank (reproduced
  pixel-by-pixel: white at t=1600ms, black at t=2000ms after the refit).
  Every render run now mounts fresh canvas elements, so a stale task's
  residual paint lands on the detached old element, invisible. Verified:
  73/73 pages painted after load, resize, and two zoom steps — zero
  black pages.
- Fixed the filter bar "floating" over the papers: the sticky bar left a
  transparent 16px gap below its box and paper cards showed through it
  while scrolling, reading as a bar floating over the list. The bar's
  box is now fully opaque and extends below its content (pb-4 +
  border-b), and the list sits in its own wrapper directly under the
  bar. Verified with real wheel input: the list scrolls 736px while the
  bar's position stays pixel-identical.
- Fixed the search box's ghost rectangle: in dark mode the box had a
  translucent background (dark:bg-input/30) that rendered as a faint
  transparent rectangle over the sort option. The box is now fully
  transparent with a clean border, and the sort dropdown keeps the
  opaque background-matching popover surface.
- Fixed "Most cited" appearing dead after a search: the citation batch
  (Semantic Scholar's shared pool 429s often) resolved empty and the UI
  spun "Citation counts are loading..." forever. The store now tracks
  the batch attempt and clears it on completion, showing an honest
  "counts unavailable - feed order kept" hint instead of an eternal
  spinner (verified live in the built app; search itself verified
  working: skeleton -> new results in ~1.5s).
- tooling: plan.md (private attachment) is excluded from Prettier so
  format:check is deterministic again; round-3 audit plans 032-037
  committed (PDF virtualization, citation disk cache, design pass,
  search UX, deep logic review, this release).

---

## v1.0.10 - 2026-08-04

Status: installers built, not yet published on GitHub.
Built from: a087ea9
Quality gates: 244 frontend tests, 96 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, release-integrity checker, CI on Windows and
macOS.

Provider IPC and UI hardening round (5 commits): the provider object sent
over Tauri IPC never matched what Rust expected, so every explain/test
call crashed in the built app; the PDF canvas gained HiDPI support and a
per-page surface state; Settings gained guided setup and test memory.

- Fixed a crash that broke ALL AI features in the desktop app:
  ProviderConfig was serialized by the frontend as camelCase (baseUrl)
  but Rust parsed snake_case (base_url), so explain_paper,
  explain_section, explain_synthesis, ask_about_paper and test_provider
  all failed with "missing field base_url". The struct now uses
  serde rename_all = "camelCase" (matching the Paper struct) with a
  wire-contract test, and the frontend passes every provider through an
  explicit toIpcProvider() at each invoke site.
- PDF pages render sharp on HiDPI displays: the canvas backing store is
  scaled by devicePixelRatio while the CSS size stays the pdf.js
  viewport, with the matching render transform. Pages also carry a
  surface lifecycle (pending/painting/ready/failed): a page that can
  never paint shows a Retry button on a paper-white surface instead of
  a silent blank rectangle, and the page wrapper is always
  paper-white so dark/sepia themes never show a black hole.
- Settings shows a persistent "Last test: OK / Failed (auth|network|...)"
  chip per provider, restored across sessions (papyrus-provider-test-v1,
  truncated and redacted, no secrets), and the empty providers state
  offers one-click quick-add CTAs (Add DeepSeek / OpenRouter / OpenAI)
  that open the add form with the preset prefilled.
- The reader's no-provider panel now has an Open Settings button inside
  it; the PDF/AI split panes have a 280px minimum width so the divider
  can never crush them; the papers filter row is sticky under the
  scrolling list and no longer reflows when loading ends.
- Stream errors in the reader UI are redacted as defense in depth
  (truncateError + redactSecrets) so secret-shaped text can never reach
  the screen even if an upstream path regresses.
- CI now uploads the installers it builds: every push exposes fresh
  Windows (msi + nsis) and macOS (dmg + app) bundles as workflow-run
  artifacts (tauri-action discards them unless a release is configured),
  and pushing a `vX.Y.Z` tag builds both platforms and attaches the
  bundles to a draft GitHub release. macOS builds are unsigned, so the
  first open needs right-click -> Open (or `xattr -dr com.apple.quarantine`).
- The three correctness fixes from v1.0.9 (rate limiter serialization,
  load-more generation guard, stop compare-and-swap) were re-verified
  against the acceptance checklist with their test suites.

---

## v1.0.9 - 2026-08-04

Status: installers built, not yet published on GitHub.
Built from: aafdf6d
Quality gates: 236 frontend tests, 95 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, release-integrity checker, CI on Windows and
macOS.

Deep audit round 2 (7 plans, commits 720ca6f..7d5ea90): the PDF reader's
black-page bug was traced to five interacting render races and fixed at
the root; three correctness bugs (rate limiter, stale load-more,
cancellation clobber) and two security gaps (loopback check, key
redaction) were closed; the design system got a palette/ARIA/sizing
cleanup; ai.rs was split into five submodules; and the app gained
walkthrough persistence plus data import.

- PDF pages can no longer turn black on resize: renders are gated by
  cancellation checks (a stale run never touches a canvas), the wait
  for a previous render is bounded so a dead task cannot wedge a page,
  retries use a real backoff and failed pages are repainted on the next
  frame, and cancelled tasks are dropped from the queue instead of
  blocking future runs. Three regression tests cover the failure modes.
- arXiv politeness is enforced under concurrency: the per-source rate
  limiter serializes callers across the sleep and stamps the time after
  firing; a stale "load more" response can no longer be appended to a
  newer list; and stopping a stream can no longer break cancellation of
  a newer stream started during the stop.
- Security: the local-server check now parses the actual host, so
  https://localhost.evil.com can never skip the API-key requirement;
  key redaction gained a generic fallback for prefixless long keys
  (custom gateways), mirrored in Rust and TypeScript.
- The warm monochrome design system is now consistent: raw amber and
  emerald alert colors were replaced with theme tokens, plain buttons
  gained visible focus rings, the top bar aligns with the content
  width, reader tabs expose the proper tablist semantics, dark-mode
  borders are stronger, cards are crisper, and markdown headings have
  real hierarchy.
- ai.rs (1880 lines) was split into ai/registry, keychain, prompts,
  stream and commands modules: prompt edits now touch only prompts.rs.
- Reopening a paper restores its section walkthrough and synthesis from
  local storage instead of re-streaming ~10 provider calls.
- New "Import data" action in Settings: pick a Papyrus export file and
  it validates it, merges the saved papers (existing entries win) and
  appends the chat transcripts. Providers and keys are never exported.
- Redundant citation batch lookups are skipped for Scholar results that
  already carry counts (fewer API calls); the browser failover loop and
  the SSRF redirect re-validation chain gained regression tests.

---

## v1.0.8 - 2026-08-04

Status: installers built, not yet published on GitHub.
Built from: 9458b9f
Quality gates: 218 frontend tests, 86 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, release-integrity checker, CI on Windows and
macOS.

Bullet points for the GitHub release description:

- All AI prompts updated (English and Arabic): a sharper mentor voice
  with tone examples to aim for and to avoid, explanations calibrated
  to a working researcher, strict anti-AI-cliche writing rules, LaTeX
  equations, and natural Arabic with English terms in parentheses. The
  prompts live in src-tauri/prompts.json and can be edited without any
  code changes
- New Sort control inside the search box: pick Newest or Most cited
  from a dropdown at the end of the search field, so searching a topic
  can surface the original or most influential paper instead of only
  the newest hits (works for arXiv search, Scholar search and day
  browsing, in English and Arabic). Scholar results reorder instantly
  with the counts they already carry; arXiv results reorder as the
  counts arrive, with a "loading" hint so the sort never looks broken
- Settings gained a "Clear cache and saved data" action: it wipes the
  downloaded PDFs, the daily digest, saved papers, chat history and
  reading positions with a confirmation step, and always keeps your
  providers and API keys

---

## v1.0.7 - 2026-08-04

Status: installers built, not yet published on GitHub.
Built from: 37ced61
Quality gates: 212 frontend tests, 84 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, release-integrity checker, CI on Windows and
macOS.

Bullet points for the GitHub release description:

- PDF pages no longer turn black after resizing the window or dragging
  the split: page renders are now serialized per canvas (a cancelled
  render is fully finished before the next one starts), and a transient
  render failure is retried instead of leaving the page blank
- In Arabic, your question in the Ask chat now appears on the right like
  the answer (it used to sit on the left)
- Arabic AI answers stay right-aligned even when a line starts with an
  English word; equations keep their own correct left-to-right layout
- The prompts that shape every explanation (English and Arabic) are
  documented in the README: they live in src-tauri/prompts.json and can
  be edited without touching code

---

## v1.0.6 - 2026-08-04

Status: installers built, not yet published on GitHub.
Built from: f1a2663
Quality gates: 208 frontend tests, 84 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, release-integrity checker, CI on Windows and
macOS.

Bullet points for the GitHub release description:

- The app window no longer scrolls as a whole: the top bar and the field
  list stay fixed, and only the papers column scrolls, so the "Today's
  picks" strip (and its own horizontal scrolling) no longer drags the
  entire interface
- Test hardening: the provider preset tests now tolerate slow Radix
  menu opens under machine load, so the full suite is stable

---

## v1.0.5 - 2026-08-04

Status: published on GitHub (release v1.0.5, installers attached).
Built from: fd3d842
Quality gates: 208 frontend tests, 84 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, release-integrity checker, CI on Windows and
macOS.

Bullet points for the GitHub release description:

- "Today's picks" strip: a quick look at the five newest papers in your
  field above the feed, dismissible for the session, never citation-based
- Clearer paper actions: Read is now the primary action, Explain is
  secondary, and the external PDF is a quiet link; every card shows its
  provenance (arXiv or Scholar) and flags when the summary is a TLDR
  instead of an abstract
- Reader context row: the active mode (Walkthrough or Ask), live section
  progress, and the selected passage are always visible, in English and
  Arabic
- Opening a paper is faster: the PDF appears right away and the whole-
  paper text is extracted only when you start the Walkthrough or Ask
  (previously every open parsed the PDF twice)
- Fixed: a fresh install opened with the PDF pane squeezed to 30% width
  (the intended 62% default now applies until you drag the split)
- AI streaming is safer: stopping one explanation can never cancel
  another running one, and citation counts expire after 7 days even when
  the app stays open for weeks
- PDF downloads are hardened: the destination is validated and pinned
  against DNS tricks, redirects are re-checked at every hop, oversized
  files are refused while downloading, and the cache uses collision-free
  names
- Settings got clearer: fields validate inline with Arabic-friendly
  messages, test failures explain the fix (URL, key, network, model),
  and the sections are grouped by task
- Fixes: stale reader opens can no longer overwrite the paper you are
  reading, favorites keep saving even when storage is full, and the
  daily digest backfills per field so switching fields never skips the
  backfill

---

## v1.0.4 - 2026-08-03

Status: installers built, not yet published on GitHub.
Built from: df3f773
Quality gates: 146 frontend tests, 75 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, CI on Windows and macOS.

Bullet points for the GitHub release description:

- Bilingual by design: full English and Arabic interfaces with proper RTL
  support, switchable instantly
- Browse the latest arXiv papers in six fields (AI, ML, NLP, CV, neural
  evolution, stats), search arXiv, and step back through any past day with
  real paper counts
- The day picker always reaches the current day: today's papers are
  selectable the moment they appear (previously the newest day lagged one
  day behind), and an empty today refetches automatically once papers land
- Arabic mode: paper titles, dates and English terms inside AI answers
  keep their correct direction, no more flipped text
- Semantic Scholar as a second source: search with citation counts, TLDRs
  and venues, with an automatic honest fallback to arXiv when the free
  rate limit is busy; a friendly translated hint guides you when a search
  term is needed
- Read mode: built-in PDF reader with find-in-page, a draggable split
  between the paper and the explanation panel, and a section-by-section
  walkthrough
- Walkthrough controls: after stopping or finishing a section you can
  Regenerate it (re-run the explanation in place) or Continue to the next
- The PDF viewer re-fits when the window or split is resized, which also
  clears the black-canvas glitch some resizes caused
- PDF pages paint fast: long papers render several pages at once, so the whole document appears in about a second instead of one page at a time
- Black pages are gone: a failing page no longer kills the render queue (in-flight renders are cancelled cleanly when you zoom or resize, failed pages are skipped), so the whole PDF always paints
- Your zoom level survives resizing: re-sizing re-fits only while you have not zoomed manually; after a manual zoom it just repaints so nothing is undone
- The split stays exactly where you dragged it while explanations stream:
  the AI panel can no longer grow wider than its share of the reader
- AI explanations powered by your own providers: OpenAI-compatible
  (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, OpenCode Go, or any custom
  endpoint), with preset URLs locked and providers named by their model
- Ask questions about the paper in a chat panel with history; equations
  in answers render as real math (KaTeX)
- Resilient AI streams: long explanations survive provider resets and
  gateway timeouts (partial answers are kept, streaming timeout is 10
  minutes)
- Three themes: light, sepia and dark
- Save favorites and export your data to a timestamped JSON file
- Privacy first: API keys live only in the OS keychain (Windows
  Credential Manager / macOS Keychain), never in files or logs
- The Settings page shows the app version (1.0.4)
- Installers for Windows: MSI and NSIS setup

---

## v1.0.3 - 2026-08-03

Status: superseded before publishing. Per the version-pump
rule (every user-facing change bumps the version), its fixes rolled
into v1.0.4. Kept here as a tracking log entry.
Built from: c110295
Quality gates: 146 frontend tests, 75 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, CI on Windows and macOS.

Bullet points for the GitHub release description:

- Bilingual by design: full English and Arabic interfaces with proper RTL
  support, switchable instantly
- Browse the latest arXiv papers in six fields (AI, ML, NLP, CV, neural
  evolution, stats), search arXiv, and step back through any past day with
  real paper counts
- The day picker always reaches the current day: today's papers are
  selectable the moment they appear (previously the newest day lagged one
  day behind), and an empty today refetches automatically once papers land
- Arabic mode: paper titles, dates and English terms inside AI answers
  keep their correct direction, no more flipped text
- Semantic Scholar as a second source: search with citation counts, TLDRs
  and venues, with an automatic honest fallback to arXiv when the free
  rate limit is busy; a friendly translated hint guides you when a search
  term is needed
- Read mode: built-in PDF reader with find-in-page, a draggable split
  between the paper and the explanation panel, and a section-by-section
  walkthrough
- Walkthrough controls: after stopping or finishing a section you can
  Regenerate it (re-run the explanation in place) or Continue to the next
- The PDF viewer re-fits when the window or split is resized, which also
  clears the black-canvas glitch some resizes caused
- AI explanations powered by your own providers: OpenAI-compatible
  (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, OpenCode Go, or any custom
  endpoint), with preset URLs locked and providers named by their model
- Ask questions about the paper in a chat panel with history; equations
  in answers render as real math (KaTeX)
- Resilient AI streams: long explanations survive provider resets and
  gateway timeouts (partial answers are kept, streaming timeout is 10
  minutes)
- Three themes: light, sepia and dark
- Save favorites and export your data to a timestamped JSON file
- Privacy first: API keys live only in the OS keychain (Windows
  Credential Manager / macOS Keychain), never in files or logs
- The Settings page shows the app version (1.0.3)
- Installers for Windows: MSI and NSIS setup

---

## v1.0.2 - 2026-08-03

Status: superseded before publishing. Per the version-pump
rule (every user-facing change bumps the version), its fixes rolled
into v1.0.3. Kept here as a tracking log entry.
Built from: 6b32b79
Quality gates: 146 frontend tests, 75 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, CI on Windows and macOS.

Bullet points for the GitHub release description:

- Bilingual by design: full English and Arabic interfaces with proper RTL
  support, switchable instantly
- Browse the latest arXiv papers in six fields (AI, ML, NLP, CV, neural
  evolution, stats), search arXiv, and step back through any past day with
  real paper counts
- The current day heals itself: if it was fetched before arXiv announced anything, it refetches automatically once papers arrive
- The day picker always reaches the current day: today's papers are
  selectable the moment they appear (previously the newest day lagged one
  day behind)
- Arabic mode: paper titles, dates and English terms inside AI answers
  keep their correct direction, no more flipped text
- Semantic Scholar as a second source: search with citation counts, TLDRs
  and venues, with an automatic honest fallback to arXiv when the free
  rate limit is busy; a friendly translated hint guides you when a search
  term is needed
- Read mode: built-in PDF reader with find-in-page, a draggable split
  between the paper and the explanation panel, and a section-by-section
  walkthrough
- AI explanations powered by your own providers: OpenAI-compatible
  (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, OpenCode Go, or any custom
  endpoint), with preset URLs locked and providers named by their model
- Ask questions about the paper in a chat panel with history; equations
  in answers render as real math (KaTeX)
- Resilient AI streams: long explanations survive provider resets and
  gateway timeouts (partial answers are kept, streaming timeout is 10
  minutes)
- Three themes: light, sepia and dark
- Save favorites and export your data to a timestamped JSON file
- Privacy first: API keys live only in the OS keychain (Windows
  Credential Manager / macOS Keychain), never in files or logs
- The Settings page shows the app version (1.0.2)
- Installers for Windows: MSI and NSIS setup

---

## v1.0.1 - 2026-08-03

Status: superseded before publishing. Per the version-pump
rule (every user-facing change bumps the version), its fixes rolled
into v1.0.2. Kept here as a tracking log entry.
Built from: 9d9ff0e
Quality gates: 146 frontend tests, 75 Rust tests, clippy, rustfmt, ESLint,
Prettier, strict typecheck, CI on Windows and macOS.

Bullet points for the GitHub release description:

- Bilingual by design: full English and Arabic interfaces with proper RTL
  support, switchable instantly
- Browse the latest arXiv papers in six fields (AI, ML, NLP, CV, neural
  evolution, stats), search arXiv, and step back through any past day with
  real paper counts
- Semantic Scholar as a second source: search with citation counts, TLDRs
  and venues, with an automatic honest fallback to arXiv when the free
  rate limit is busy
- Read mode: built-in PDF reader with find-in-page, a draggable split
  between the paper and the explanation panel, and a section-by-section
  walkthrough
- AI explanations powered by your own providers: OpenAI-compatible
  (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, OpenCode Go, or any custom
  endpoint), with preset URLs locked and providers named by their model
- Ask questions about the paper in a chat panel with history; equations
  in answers render as real math (KaTeX)
- Three themes: light, sepia and dark
- Save favorites and export your data to a timestamped JSON file
- Semantic Scholar is search-only: switching to it without a search term now shows a clear hint in your language, and the search box switches to "Search Semantic Scholar…"
- The day picker now includes today: the newest day is always the current day (previously it lagged one day behind)
- Arabic mode: English paper titles and terms inside AI answers keep their correct direction, no more flipped text
- The PDF reader's AI stream no longer fails with "error decoding response body" when a provider resets a long stream: partial answers are kept, and the streaming timeout was raised to 10 minutes
- The Settings page shows the app version (1.0.1)
- Privacy first: API keys live only in the OS keychain (Windows
  Credential Manager / macOS Keychain), never in files or logs
- Installers for Windows: MSI and NSIS setup

---

## Template for future releases

Copy this block, fill it in, and keep the older sections untouched.

## vX.Y.Z - YYYY-MM-DD

Status: (planned / built / published)
Built from: <commit sha>
Quality gates: <frontend> frontend tests, <rust> Rust tests, clippy,
rustfmt, ESLint, Prettier, strict typecheck, CI on Windows and macOS.

Bullet points for the GitHub release description:

- (what changed for users, in plain language, one bullet per change)

---

## Release checklist (for AI agents)

1. Run all gates: pnpm run test, pnpm run typecheck, pnpm run lint,
   pnpm run format:check, cargo test --lib, cargo clippy -- -D warnings,
   cargo fmt -- --check
2. Bump the version if needed in package.json, src-tauri/tauri.conf.json
   and src-tauri/Cargo.toml (keep all three in sync)
3. Build: node node_modules/vite/bin/vite.js build, then
   pnpm exec tauri build
4. Verify the binaries are newer than the sources:
   ls -la src-tauri/target/release/papyrus.exe src-tauri/src/papers.rs
5. Update this file and the README changelog with the same information
6. Commit, push, tag (git tag vX.Y.Z && git push origin vX.Y.Z)
7. On GitHub: Releases -> Create new release -> pick the tag -> paste the
   bullet points -> attach the MSI and NSIS exe from
   src-tauri/target/release/bundle/
