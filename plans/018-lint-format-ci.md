# Plan 018: Add lint, format, pre-commit hooks, typecheck-in-dev, and CI before commit #1

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: the repo has **no git commits yet**. Compare
> the "Current state" excerpts against the live files; on any mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (config-only; worst case is rule tuning)
- **Depends on**: plans/014 (removes the dangling eslint-disable so lint passes on first run)
- **Category**: dx
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

The repo is about to be published as OSS with a claimed Windows+macOS
story and zero automated verification: no lint, no formatter, no pre-commit
hooks, no CI, and the `pnpm tauri dev` loop never type-checks (typecheck
only runs inside `build`). REF2.md:78 (the repo's own plan) promised
"GitHub Actions for Windows + Mac builds". Tooling added before commit #1
costs nothing; added after, it touches every future diff. Verified
standards (retrieved 2026-08-02): typescript-eslint flat config is the
current ESLint standard (typescript-eslint.io/getting-started); the
standard Tauri 2 CI workflow uses `tauri-apps/tauri-action`
(v2.tauri.app/distribute/pipelines/github).

## Current state

- `package.json` scripts (lines 6-12): `dev`, `build`, `preview`,
  `mock-ai`, `tauri` — no `lint`, `typecheck`, `format`, or `test`
  (test lands in plan 002).
- No `eslint.config.*`, `.prettierrc`, `.editorconfig`, `.github/`.
- `src-tauri/` has no `rustfmt.toml`/`clippy` config; `cargo fmt` and
  `cargo clippy` are available (rustup minimal profile — verify: if
  `cargo fmt`/`clippy` are missing, `rustup component add rustfmt clippy`
  is a project-local toolchain addition, allowed).
- `pnpm tauri dev` runs `pnpm dev` → vite only.
- Repo conventions: pnpm, strict TS, kebab-case files, AGENTS.md governance.

## Commands you will need

| Purpose   | Command                                                                           | Expected on success |
| --------- | --------------------------------------------------------------------------------- | ------------------- |
| Install   | `pnpm add -D eslint typescript-eslint @eslint/js prettier eslint-config-prettier` | exit 0              |
| Lint      | `pnpm lint`                                                                       | exit 0              |
| Format    | `pnpm format`                                                                     | exit 0              |
| Typecheck | `pnpm exec tsc --noEmit`                                                          | exit 0              |
| CI checks | see steps                                                                         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `package.json` (scripts + devDependencies)
- `eslint.config.mjs` (create), `.prettierrc.json` (create), `.editorconfig` (create)
- `src-tauri/src/` (only if `cargo fmt` reformats — that's expected and in scope)
- `.github/workflows/ci.yml` (create)
- `README.md` (dev section: document lint/format/typecheck)

**Out of scope** (do NOT touch):

- App behavior; store/component logic; Rust logic. `pnpm test` wiring is
  plan 002's scope (do not add vitest here).

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it. (CI
validates on push; with no commits yet, CI verification is by workflow
lint + local replication of its steps.)

## Steps

### Step 1: ESLint flat config

1. `pnpm add -D eslint typescript-eslint @eslint/js eslint-config-prettier`
   (project-local).
2. Create `eslint.config.mjs`:

```js
// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/target/**", "node_modules/**", ".venv/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true } },
  },
  prettier, // disables style rules prettier owns
);
```

(If `projectService` typing complains, use the non-type-checked
`tseslint.configs.recommended` only — the important rules are the base
ones plus `react-hooks` if the plugin installs cleanly; keep it minimal
and working over maximal.) 3. Add scripts: `"lint": "pnpm exec eslint ."`,
`"typecheck": "pnpm exec tsc --noEmit"`. 4. Change the `build` script to use the new typecheck script:
`"build": "pnpm typecheck && pnpm exec vite build"` (or keep inline —
either is fine; the point is `pnpm run typecheck` exists standalone). 5. Also add `"dev:check": "pnpm typecheck && pnpm lint"`? No — keep the
script list minimal (lint, typecheck, format).

**Verify**: `pnpm lint` → exit 0 (fix any pre-existing violations the
rules flag; plan 014 removed the known one). If `react-hooks` rules were
added and flag the effect in `settings-page.tsx`, apply plan 014's
`providerIds` fix if not already landed.

### Step 2: Prettier + EditorConfig

1. `pnpm add -D prettier`
2. `.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": false,
  "printWidth": 100,
  "trailingComma": "all"
}
```

(Match the existing code style — the current code uses double quotes,
semicolons, ~90-100 width. Adjust if the existing style differs.) 3. Add `"format": "pnpm exec prettier --write ."` and
`"format:check": "pnpm exec prettier --check ."`. 4. Run `pnpm format` — expect it to reformat files; review the diff is
style-only. 5. Create `.editorconfig` (indent 2 spaces, utf-8, lf — standard).

**Verify**: `pnpm format:check` → exit 0; `pnpm lint` → exit 0;
`pnpm exec tsc --noEmit` → exit 0.

### Step 3: Pre-commit hook (lefthook or husky+lint-staged)

Choose **lefthook** (single binary, less config) or husky+lint-staged
(more familiar). Default: lefthook.

1. `pnpm add -D lefthook` + `pnpm exec lefthook install`.
2. `lefthook.yml`:

```yaml
pre-commit:
  parallel: true
  commands:
    typecheck:
      run: pnpm exec tsc --noEmit
    lint:
      run: pnpm exec eslint {staged_files}
    format:
      run: pnpm exec prettier --check {staged_files}
    rust-fmt:
      glob: "*.rs"
      run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

(Adjust `{staged_files}` syntax to the lefthook version installed —
check `pnpm exec lefthook --version` docs if it errors.)

**Verify**: `pnpm exec lefthook run pre-commit` (dry run) → all commands pass.

### Step 4: CI workflow

Create `.github/workflows/ci.yml` modeled on the official tauri-action
example (v2.tauri.app/distribute/pipelines/github, retrieved 2026-08-02):

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm exec prettier --check .

  desktop:
    strategy:
      matrix:
        include:
          - platform: windows-latest
            args: ""
          - platform: macos-latest
            args: ""
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with: { components: clippy, rustfmt }
      - run: pnpm install --frozen-lockfile
      - run: cargo test --manifest-path src-tauri/Cargo.toml --lib
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Note: `pnpm test` requires plan 002 to have landed. If it hasn't, omit
that line and add it when 002 lands (note in the status row).
Rust toolchain: `cargo fmt`/`clippy` need the components; locally
`rustup component add rustfmt clippy` if missing.

**Verify**: workflow file is valid YAML (`node -e "require('yaml')"` is
not available — validate by inspection or `python -c "import yaml"` if
PyYAML exists; otherwise eyeball). No push is made by this plan — CI runs
after the operator's first push.

### Step 5: README

- Prerequisites: add pnpm (see plan 020 — if it lands first, skip here).
- Dev section: add `pnpm lint`, `pnpm typecheck`, `pnpm format`,
  `pnpm test` to the "Tests" section; mention pre-commit hooks.

**Verify**: `pnpm run build` → exit 0.

## Test plan

- No new tests; the gates ARE the verification: `pnpm lint`,
  `pnpm format:check`, `pnpm exec tsc --noEmit`, `pnpm test` (if landed),
  `cargo clippy -D warnings`, `cargo fmt --check` — all must exit 0.

## Done criteria

- [ ] `pnpm lint` exits 0
- [ ] `pnpm format:check` exits 0
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm run build` exits 0
- [ ] `lefthook run pre-commit` (or husky equivalent) passes
- [ ] `.github/workflows/ci.yml` exists with frontend + windows/macos desktop jobs
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` exits 0
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` exits 0
- [ ] No app behavior changed (diff is config/tooling only)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Clippy flags real code issues beyond style (e.g. `needless_return`
  clusters are fine to fix; a semantic clippy lint like `unwrap_used`
  would be a judgment call — report it).
- The chosen hook tool fails to install/run in this environment — switch
  to the other (husky) and note it; if both fail, ship configs without
  hooks and mark that in the status row.
- `pnpm install --frozen-lockfile` in CI would fail because the lockfile
  is out of date after adding devDeps — run `pnpm install` locally first
  so the lockfile is committed fresh.

## Maintenance notes

- Plan 002 adds `test`; CI's frontend job should gain `pnpm test` then
  (already in the sketch).
- Keep `.prettierrc.json` aligned with what prettier formats — if the team
  later prefers single quotes, one line changes everything.
- The desktop CI job is the only proof of the macOS build story
  (AGENTS.md: no local Mac testing) — treat red `macos-latest` as a real
  signal, not noise.
