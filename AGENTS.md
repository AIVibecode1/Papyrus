# AGENTS.md

## Project Overview

This is an open-source cross-platform desktop application (Windows + macOS) built with **Tauri 2**.

**Core purpose:**

- Fetch the latest research papers (primarily from arXiv) in user-selected fields (AI, ML, CS, etc.)
- Explain selected papers using the user's own AI providers / API keys
- Fully bilingual: English + Arabic with proper RTL support
- Simple, clean, and modern UI/UX
- Privacy-first (user provides their own API keys)

The app prioritizes **simplicity**, **security**, **bilingual experience**, and good developer experience.

---

## Critical Rules (Must Follow)

### 1. Package Installation Rule

- **Never** install any packages globally.
- **Never** install packages outside the project folder.
- All dependencies must be installed **locally** inside the project using:
  - `npm install` / `pnpm add` / `yarn add` (frontend)
  - `cargo add` (Rust)
  - `pip install` only inside a virtual environment created **inside** the project folder
- Always prefer project-local tools and virtual environments.

### 2. Security First

- Always prioritize security practices.
- Never hardcode API keys or secrets.
- Store all user API keys using the OS keychain via the `keyring` crate (Windows Credential Manager / macOS Keychain).
- Never log or expose API keys in the console or UI.
- Validate and sanitize all external inputs (especially paper content and AI responses).
- Follow the principle of least privilege in Tauri capabilities.
- Prefer secure defaults in every feature.

### 3. Platform Reality

- The main developer is building and testing on **Windows**.
- Do **not** assume Mac-specific behavior can be tested.
- Write cross-platform code, but prioritize Windows compatibility and testing.
- Avoid Mac-only APIs or assumptions unless clearly marked as optional.

### 4. When in Doubt

- If you have any doubt about the best approach, libraries, patterns, or current best practices → **search** first.
- You are allowed and encouraged to use **Tavily search** (or web search) to verify information before implementing.
- Prefer verified, up-to-date information over assumptions.

---

## Tech Stack

- **Desktop Framework**: Tauri 2
- **Frontend**: React + TypeScript + Tailwind CSS + shadcn/ui
- **State Management**: Prefer Zustand (keep it simple)
- **Internationalization**: react-i18next with full RTL support
- **Paper Source**: arXiv API (primary). Semantic Scholar / OpenAlex can be added later
- **AI Layer**: OpenAI-compatible client (supports OpenRouter, DeepSeek, OpenCode, Ollama, custom base URLs, etc.)
- **Backend Logic**: Rust commands (pure Rust preferred over Python sidecar: one toolchain, simpler packaging)
- **Secure Storage**: OS keychain via the `keyring` crate (Windows Credential Manager / macOS Keychain)

---

## Architecture Guidelines

- Keep the frontend focused on UI and user experience.
- Heavy logic (fetching papers, calling AI models, parsing) should live in the backend (Rust commands).
- Support multiple AI providers through a flexible configuration:
  - Provider name
  - Base URL
  - API Key
  - Model name
- All API keys must be stored securely. Never in plain text, localStorage, or config files.

---

## UI / UX Rules

- Design must be clean, modern, and minimal.
- Support both Light and Dark mode.
- **Arabic (RTL) is a first-class citizen**:
  - Always use logical CSS properties (`ms-`, `me-`, `ps-`, `pe-`, `start`, `end`, `text-start`, etc.)
  - Every component must work correctly in both LTR and RTL.
  - Use high-quality Arabic fonts (Noto Naskh Arabic, Cairo, or IBM Plex Sans Arabic recommended).
- Prefer shadcn/ui components.
- Keep the interface simple and focused:
  1. Paper list
  2. Paper detail
  3. AI Explanation panel
  4. Settings

---

## Coding Standards

- Use TypeScript in strict mode.
- Prefer functional components and hooks.
- Keep components small and focused.
- Use clear and meaningful names.
- Prefer readability over cleverness.
- Use early returns and guard clauses.
- Add comments only when the "why" is not obvious.

## Changelog Rule (must follow)

- `README.md` contains a **"What changed since the first version"**
  section: a changelog of problems solved and features added.
- **Every change, fix, or upgrade MUST update that section** in the same
  commit: for fixes, add the problem and how it was solved; for features,
  add what was added.
- Keep the test counts in the "Technical choices" table ("Testing and
  quality gates" row) in sync with reality whenever tests are added.
- If a change is too small to warrant a changelog row, say so in the
  commit message instead of silently skipping the rule.

## Release Notes Rule (must follow)

- `release.md` tracks every release: bullet points, build provenance,
  quality gate counts, and the release checklist. It is written for
  humans and for AI agents.
- **Every change that reaches users (feature, fix, upgrade) MUST be
  reflected in the current release's bullet points in `release.md`**,
  updated in the same commit as the change. Each update adds the version
  number and what was fixed or added.
- **Never delete or truncate older release sections**: `release.md` is a
  tracking log, like a quick changelog. Old versions stay forever.
- When a release is tagged and published, freeze its section (status,
  built-from commit, gate counts) and never edit old sections afterwards.
- New releases are added by copying the template section in `release.md`.
- If a change is too small to warrant a release bullet, say so in the
  commit message instead of silently skipping the rule.

---

## Internationalization Rules

- Every user-facing string must go through the i18n system.
- Never hardcode English or Arabic text inside components.
- Support instant language switching.
- When generating AI explanations, the response language must match the current UI language (English or Arabic).

---

## Important Do's and Don'ts

**Do:**

- Make the app feel fast and responsive.
- Handle loading, empty, and error states properly.
- Keep API key management clear and secure.
- Write code that is easy for other open-source contributors to understand.
- Search (or use Tavily) when unsure.

**Don't:**

- Don't install any packages globally or outside the project.
- Don't force users to use a specific AI provider.
- Don't store API keys insecurely.
- Don't break RTL support when adding new features.
- Don't over-engineer. Prefer simple and maintainable solutions.
- Don't assume Mac testing is possible.

---

## Preferred Project Structure

```
src/                    # Frontend (React)
  components/
  features/
  hooks/
  lib/
  i18n/
  stores/
src-tauri/              # Tauri + Rust
  src/
  capabilities/
python/                 # Optional Python sidecar (if used)
  venv/                 # Local virtual environment only
```

---

## Current MVP Priorities

1. Solid Tauri 2 + React + Tailwind + shadcn/ui setup with working RTL
2. Fetch and display latest papers from arXiv by category
3. Allow users to add and manage their own AI providers + API keys securely
4. Generate clear paper explanations in the current language (EN or AR)
5. Clean and usable Settings page
6. Strong focus on security and local package management

---

## Notes for AI Agents

- Always check existing code style before writing new code.
- Prefer editing existing files over creating many new ones.
- When in doubt → search first (Tavily or web search is allowed and encouraged).
- This project values **security**, **clarity**, **bilingual support**, and **simplicity**.
- Never install packages globally.
