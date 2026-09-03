# Development

Prerequisites: [Rust](https://rustup.rs), Node.js 20 or newer (which ships
[corepack](https://nodejs.org/api/corepack.html); run `corepack enable
pnpm` to get pnpm), [pnpm](https://pnpm.io/installation) 9 or newer, and on
Windows: Visual Studio Build Tools (C++) and WebView2.

```bash
pnpm install
pnpm tauri dev
```

## Local mock AI server (no API key needed)

To develop and test the explain flow without spending tokens:

```bash
pnpm mock-ai
# then add it in Papyrus Settings:
#   Base URL: http://localhost:8765/v1
#   Model:    mock-model
#   API key:  anything (or empty)
```

## Regenerating the screenshots

With the dev server and mock AI server running (see above):

```bash
pnpm exec node dev/capture-screenshots.mjs
```

## Tests, lint and formatting

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust: parsing, streaming, error paths
pnpm test                                          # Frontend unit tests (Vitest)
pnpm run build                                     # TypeScript strict check + production build
pnpm lint                                          # ESLint
pnpm typecheck                                     # TypeScript strict (tsc --noEmit)
pnpm format                                        # Prettier, write formatting fixes
pnpm format:check                                  # Prettier, verify formatting
```

Pre-commit hooks (via [lefthook](https://lefthook.dev)) run typecheck,
lint, formatting checks and `cargo fmt --check` automatically on every
commit. CI (GitHub Actions) runs the same gates plus the Rust test suite
and desktop builds on Windows and macOS.

A live arXiv fetch test is included but ignored by default (it needs a
network connection):

```bash
cargo test --manifest-path src-tauri/Cargo.toml live_fetch_from_arxiv -- --ignored
```

## Editing the AI prompts

Every explanation (quick explanation, whole-paper walkthrough, final
synthesis, and Ask answers) is shaped by the prompts in
`src-tauri/prompts.json`. There are English and Arabic versions of each
prompt, plus the cancellation marker the app matches when a stream is
stopped. Edit the JSON directly (for example to adjust the mentor style
or add instructions) and rebuild; the Rust backend loads the file at
compile time through `include_str!`, so no code changes are needed. Keep
the English and Arabic versions in sync.
