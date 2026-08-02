# Plan 002: Add a frontend test runner (Vitest) and `test` script

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

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

The frontend — stores, SSE parser, IPC wiring — has **zero automated tests**.
The only gate is `tsc --noEmit` inside `pnpm run build`. Every store/UI
regression is currently found by hand. This plan adds Vitest and a
one-command verification path; it is the prerequisite for plans 003, 004,
005, 011, 012, 015, 016, 017, 025 and 026, which fix real bugs in those
untested state machines.

## Current state

- `package.json` scripts (lines 6-12):

```json
  "scripts": {
    "dev": "pnpm exec vite",
    "build": "pnpm exec tsc --noEmit && pnpm exec vite build",
    "preview": "pnpm exec vite preview",
    "mock-ai": "node dev/mock-ai-server.mjs",
    "tauri": "tauri"
  },
```

- `package.json` devDependencies (lines 30-38): `@tauri-apps/cli`,
  `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `shadcn`,
  `typescript`, `vite` — no test runner.
- `src/` contains no `*.test.ts`/`*.test.tsx` files.
- Repo conventions: TypeScript strict mode; path alias `@/*` → `./src/*`
  (tsconfig.json `paths`); pnpm as package manager; all packages installed
  locally (never globally).

## Commands you will need

| Purpose   | Command                    | Expected on success |
|-----------|----------------------------|---------------------|
| Install   | `pnpm add -D vitest`       | exit 0              |
| Typecheck | `pnpm exec tsc --noEmit`   | exit 0, no errors   |
| Test      | `pnpm test`                | all pass            |
| Build     | `pnpm run build`           | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `package.json` (add `test` script; add vitest devDependency)
- `vite.config.ts` (add `test` config block)
- `src/lib/__tests__/smoke.test.ts` (create — the smoke test proving the runner works)
- `src/test/setup.ts` (create — minimal vitest setup, if needed)

**Out of scope** (do NOT touch):
- Any app source file (`src/` outside the new test file), any Rust code.
- Installing any other test tooling (no jest, no testing-library yet —
  plan 004 adds suites; they may add testing-library if needed).

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Install Vitest and configure it

1. `pnpm add -D vitest` (project-local, per AGENTS.md).
2. Add a `test` script to `package.json`:
   `"test": "pnpm exec vitest run"` (run once, no watch).
3. In `vite.config.ts`, add to the `defineConfig` object:

```ts
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
```

   Note: `vite.config.ts` is a `defineConfig(async () => ({...}))` — add the
   `test` key inside the returned object. If TypeScript complains about the
   `test` key type, add `/// <reference types="vitest/config" />` at the top
   of the file (this is the standard Vitest+Vite typing).

4. Run `pnpm exec tsc --noEmit` → must still pass.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Add a smoke test that imports a real module

Create `src/lib/__tests__/smoke.test.ts`:

- Import `normalizeBaseUrl` from `@/lib/ai` (pure function, no Tauri/browser
  APIs at import time — verify this is true before using it; if importing
  `@/lib/ai` pulls `@tauri-apps/api/core` at module top level and fails in
  node, mock it with `vi.mock` or import only via `await import` after
  stubbing `window` — the module guards Tauri calls behind `isTauri()` at
  call time, so top-level import should be safe).
- Assert at least 3 behaviors of `normalizeBaseUrl`:
  - `"https://api.openai.com/v1"` → `"https://api.openai.com/v1/chat/completions"`
  - trailing slash variant
  - already-full URL passes through unchanged
- Keep the file small — it proves the runner works; real suites land in
  plan 004.

**Verify**: `pnpm test` → 1 test file, 3 assertions, all pass, exit 0.

### Step 3: Wire into the project docs

- Add to `README.md` "Tests" section (lines ~50-55): a line documenting
  `pnpm test` for frontend tests alongside `cargo test`.

**Verify**: `pnpm run build` → exit 0 (build still green with the new config).

## Test plan

- `src/lib/__tests__/smoke.test.ts` — the runner smoke test (3 assertions).
- Verification: `pnpm test` → pass; `pnpm run build` → pass.

## Done criteria

- [ ] `pnpm test` exits 0 with the smoke test passing
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm run build` exits 0
- [ ] `package.json` has a `test` script; `vite.config.ts` has a `test` block
- [ ] No app source files modified (only the new test file + configs)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm add -D vitest` fails (network/registry issue) — report, do not fall
  back to another runner.
- Importing `@/lib/ai` in the smoke test fails in ways that mocking can't
  cleanly solve — report the exact error instead of restructuring app code.
- The `test` key in vite.config.ts can't be typed without changing app code.

## Maintenance notes

- Plans 003, 004, 005, 011, 012, 015, 016, 017, 025, 026 all depend on this
  runner existing. Land this first and verify the smoke test passes before
  starting any of them.
- Vitest picks up `vite.config.ts` automatically; future suites just drop
  `*.test.ts` files next to their modules.
- If a future plan needs DOM rendering (components), switch the environment
  to `happy-dom` for those files via a per-file `// @vitest-environment happy-dom`
  comment — do not change the global default now.
