# Papyrus 📜

**Latest research papers, explained simply — by your own AI.**

Papyrus is a free, open-source desktop app (Windows + macOS) that:

- Shows the **newest papers** from arXiv in the fields you care about (AI, ML, NLP, Vision…)
- **Explains any paper in plain language** using *your* AI provider — OpenAI, OpenRouter, DeepSeek, Groq, Ollama, or any OpenAI-compatible endpoint (custom base URL)
- Speaks **English and Arabic** natively, with full RTL support
- Keeps your API keys in the **OS keychain** (Windows Credential Manager / macOS Keychain) — nothing leaves your device except the request to the provider you configured

Built with **Tauri 2 · React · TypeScript · Tailwind CSS · shadcn/ui · Zustand · react-i18next**.

## Features

| | |
|---|---|
| 📄 Latest papers | arXiv API, newest first, 6 fields (AI, ML, NLP, CV, Neural, Stats) + refresh |
| ✨ AI explanations | Streaming, in the current UI language (English or Arabic), stop/regenerate |
| 🔑 Your providers | OpenAI, OpenRouter, DeepSeek, Groq, Ollama (local) or any custom base URL + model |
| 🔒 Privacy first | Keys stored in the OS keychain; paper fetching and AI calls happen in the Rust backend |
| 🌍 Bilingual | Instant EN ⇄ AR switching, full RTL, Cairo font |
| 🌗 Theme | Light & dark mode |

## Screenshots

Coming soon.

## Development

Prerequisites: [Rust](https://rustup.rs), Node.js ≥ 20 (which ships
[corepack](https://nodejs.org/api/corepack.html) — run `corepack enable pnpm`
to get pnpm), [pnpm](https://pnpm.io/installation) ≥ 9, and on Windows:
Visual Studio Build Tools (C++) + WebView2.

```bash
pnpm install
pnpm tauri dev
```

### Local mock AI server (no API key needed)

For development and testing the explain flow without spending tokens:

```bash
pnpm mock-ai
# then add it in Papyrus Settings:
#   Base URL: http://localhost:8765/v1
#   Model:    mock-model
#   API key:  anything (or empty)
```

## Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust: parsing, streaming, error paths
pnpm test                                          # Frontend unit tests (Vitest)
pnpm run build                                     # TypeScript strict + production build
```

A live arXiv fetch test is included but ignored by default (requires network):

```bash
cargo test --manifest-path src-tauri/Cargo.toml live_fetch_from_arxiv -- --ignored
```

## Project layout

```
src/                React frontend (components, features, hooks, i18n, lib, stores)
src-tauri/          Rust backend (arXiv fetching, AI streaming, keychain)
dev/                Dev-only tools (mock AI server)
```

## Security notes

- API keys are written to and read from the OS keychain by the Rust backend only — they never enter the webview.
- The webview runs with a restricted capability set (`core:default`, `opener:default`, `keyring:default`).
- AI responses are rendered as plain text (no HTML), so no sanitizer is needed.
- arXiv's rate limit (≥ 1 request per 3 s) is enforced in the Rust fetcher.

## Status

MVP complete ✅ — papers from arXiv, AI explanations (streaming, EN/AR), secure keychain storage, providers management, dark mode, Windows + macOS.

## License

[MIT](LICENSE)
