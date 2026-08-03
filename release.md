# Papyrus releases

This file tracks every release of Papyrus: what shipped, what it was built
from, and the exact bullet points for the GitHub release description. It is
written for humans and for AI agents working in this repo.

Rules:

- Every release adds a section below and never edits old sections.
- The bullet points here are the source of truth for the GitHub release
  description. Copy them as-is.
- The test counts in each section must match the README "Testing and
  quality gates" row at the time of the release.
- Installer artifacts live in `src-tauri/target/release/bundle/` after a
  build. Attach the MSI and the NSIS setup exe to the GitHub release.

---

## v1.0.0 - 2026-08-03

Status: installers built, not yet published on GitHub.
Built from: e64b24e
Quality gates: 140 frontend tests, 73 Rust tests, clippy, rustfmt, ESLint,
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
