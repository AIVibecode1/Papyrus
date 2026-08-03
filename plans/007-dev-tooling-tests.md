# Plan 007: Test the development tooling (mock AI server, screenshot capture)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- dev`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S-M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

`dev/mock-ai-server.mjs` defines the streaming contract (SSE chunking,
Arabic detection via the "اللغة العربية" marker, markdown-rich replies,
CORS) that every browser-based E2E session depends on, and
`dev/capture-screenshots.mjs` regenerates the README images. Neither has a
single test. If the mock's chunking or the capture script's waits drift,
the developer experience silently degrades (screenshots come out blank or
streams never finish) and the failures look like app bugs. A tiny test
harness (node:test, zero new dependencies) pins the mock's HTTP behavior
and the capture script's pure helpers.

## Current state

- `dev/mock-ai-server.mjs` — Node http server on `:8765`; POST
  `/v1/chat/completions` with `stream: true` replies with SSE chunks
  (word-by-word, 35 ms interval); CORS headers set; the Arabic branch
  triggers when the system prompt contains "اللغة العربية"; the demo
  replies contain the marker string "شرح تجريبي" used by the screenshot
  script's wait condition. Verify the exact reply constants when
  implementing (read the file).
- `dev/capture-screenshots.mjs` — puppeteer-core script; contains pure
  helpers (e.g. `findButtonByText(page, text)`, the `MIN_BYTES` check at
  line ~180) plus the sequential capture flow.
- Repo convention: no test runner for plain Node scripts today; the
  project uses vitest for TS. For `.mjs` dev scripts, `node:test`
  (built-in) keeps zero new dependencies — run with
  `node --test dev/`.

## Commands you will need

| Purpose   | Command                        | Expected on success          |
| --------- | ------------------------------ | ---------------------------- |
| Dev tests | `node --test dev/`             | all pass                     |
| Typecheck | `pnpm exec tsc --noEmit`       | exit 0                       |
| Lint      | `pnpm exec eslint .`           | exit 0 (dev/*.mjs is linted) |
| Format    | `pnpm exec prettier --check .` | all files match              |
| App tests | `pnpm exec vitest run`         | all pass                     |

## Scope

**In scope**:

- `dev/mock-ai-server.test.mjs` (create — node:test)
- `dev/capture-screenshots.test.mjs` (create — node:test, pure helpers only)
- `dev/mock-ai-server.mjs` / `dev/capture-screenshots.mjs` (ONLY small
  refactors to export testable pieces: e.g. export `handleRequest` and the
  reply builder from the mock; export pure helpers from the capture script)
- `package.json` (add a `test:dev` script: `node --test dev/`)
- `plans/README.md` (status row)

**Out of scope**:

- Spinning up real browsers in tests (puppeteer against the live app).
- Changing the mock's streaming behavior or reply texts (the "شرح تجريبي"
  marker is a contract used by the capture script and the README flow).
- `dev/make-sample-pdf.py` (Python, separate toolchain).

## Git workflow

- Branch: `advisor/007-dev-tooling-tests`
- Commit style: `test: cover the mock AI server and capture helpers`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Export testable pieces from the mock server

In `dev/mock-ai-server.mjs`, extract (without changing behavior):

- `buildReply(systemPrompt)` → returns the EN or AR reply string (the
  Arabic branch keyed on "اللغة العربية").
- `createHandler(replyBuilder)` or export the request handler function so a
  test can call it with a fake `req`/`res` or start the server on an
  ephemeral port (`server.listen(0)`).

**Verify**: `node --test dev/mock-ai-server.test.mjs` (after Step 2) passes.

### Step 2: Mock server tests

Create `dev/mock-ai-server.test.mjs` (node:test + built-in `http`):

1. Starting the server on port 0, POST `/v1/chat/completions` with a
   stream request → 200, `content-type` includes `text/event-stream`, CORS
   header `access-control-allow-origin` present, and the body contains
   `data: ` SSE lines including the first chunk and a final `[DONE]`.
2. The Arabic branch: system prompt containing "اللغة العربية" → the reply
   text contains the Arabic demo markers (assert on the known strings from
   the file, e.g. "شرح تجريبي").
3. Non-streaming request (`stream: false` or absent) → a single JSON
   response with a `choices[0].message.content` (read the file for the
   actual shape and assert accordingly).
4. Unknown route → 404.
5. A request whose body is not valid JSON → 400 (if that is the current
   behavior — check the file; if it currently 500s, fix the handler to 400
   as part of this plan and say so in the commit).

**Verify**: `node --test dev/mock-ai-server.test.mjs` → all pass.

### Step 3: Capture-script helper tests

Create `dev/capture-screenshots.test.mjs` covering the pure helpers:

1. `findButtonByText` selection logic if extractable (exact text match vs
   trim) — otherwise test whatever pure functions the file exposes after
   the small refactor.
2. The `MIN_BYTES` size check: a size above/below the threshold returns the
   expected verdict (export the check as a function if it is inline).

If the file has no pure functions worth exporting after inspection, keep
this step to the size-check helper and document the rest as covered by the
manual capture runs.

**Verify**: `node --test dev/capture-screenshots.test.mjs` → all pass.

### Step 4: Wire the script and run everything

Add `"test:dev": "node --test dev/"` to `package.json` scripts. Do NOT
wire it into the main `test` script or CI without asking the operator —
dev-tooling tests are a local convenience; CI inclusion is a judgment call
(they are fast, so it is a reasonable follow-up question).

**Verify**:

1. `pnpm exec vitest run` → all pass
2. `pnpm exec eslint .` → exit 0 (the new .mjs files must pass lint)
3. `pnpm exec prettier --check .` → clean
4. `node --test dev/` → all pass

## Test plan

- New: the two `dev/*.test.mjs` files (5-6 cases total).
- No changes to the app's test suites; they must stay green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node --test dev/` → all pass
- [ ] `package.json` has a `test:dev` script
- [ ] The mock server's wire behavior (SSE, Arabic branch, JSON branch) is asserted by a test
- [ ] `pnpm exec vitest run`, `pnpm exec tsc --noEmit`, `pnpm exec eslint .`, `pnpm exec prettier --check .` all clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The mock server's reply constants or route behavior differ from this
  plan's description (drift — read the file first and adjust the test
  expectations to the ACTUAL contract; if the actual contract is
  internally inconsistent, report).
- The capture script has no pure helpers worth testing after the refactor
  (then trim Step 3 to the size check and note it).
- Adding exports to the mock server changes its behavior in any way (a
  failing E2E smoke in the dev preview is a STOP signal — revert the
  refactor and report).

## Maintenance notes

- The "شرح تجريبي" marker is load-bearing: the capture script's wait
  condition and the README flow depend on it. Any future mock rewrite must
  keep it; the test in Step 2 pins it.
- If the app later moves to a structured error contract (see the failover
  spike, open question 3), the mock server must mirror it — extend these
  tests in the same commit.
- Reviewer focus: tests must assert the wire contract (headers, SSE framing,
  Arabic detection), not the mock's internal implementation.
