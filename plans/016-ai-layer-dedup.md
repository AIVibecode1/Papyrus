# Plan 016: De-duplicate the cross-language AI layer (prompts, URL build, contract)

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
- **Risk**: MED (flagship streaming path; done under a test net)
- **Depends on**: plans/001, 004, 005 (parser fix, characterization tests, typed cancellation)
- **Category**: tech-debt
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Four pieces of the AI layer exist twice — once in Rust
(`src-tauri/src/ai.rs`) and once in TypeScript (`src/lib/ai.ts`):

1. System prompts (verbatim copies; `ai.ts:33` even says "Keep in sync with
   src-tauri/src/ai.rs").
2. SSE line parsing (behavior already diverged: Rust errors on clean close
   without `[DONE]`, TS exits cleanly — plan 001 aligns them; cancellation
   checks exist only in Rust).
3. URL normalization (`build_chat_url` vs `normalizeBaseUrl`).
4. Message building.

Every prompt tweak or parser fix must be made twice, and the copies drift
in exactly the edge cases that matter. This plan makes the prompts a single
source of truth and documents the parser contract explicitly, so future
changes touch one place.

## Current state

- `src-tauri/src/ai.rs:18-27` — `SYSTEM_PROMPT_EN` / `SYSTEM_PROMPT_AR`.
- `src/lib/ai.ts:33-38` — same prompts verbatim.
- `src-tauri/src/ai.rs:124-159` — SSE parser (post-plan-001 shape).
- `src/lib/ai.ts:110-134` — browser SSE parser (plan 011 adds abort).
- `src-tauri/src/ai.rs:39-49` — `build_chat_url`; `src/lib/ai.ts:27-31` —
  `normalizeBaseUrl`.
- `src-tauri/src/ai.rs:51-69` — `build_messages`; `src/lib/ai.ts:40-55` —
  `buildMessages`.
- Plan 005 adds `CANCELLED_MARKER` in both places (same value, two files).

## Commands you will need

| Purpose   | Command                            | Expected on success |
| --------- | ---------------------------------- | ------------------- |
| Rust test | `cd src-tauri && cargo test --lib` | all pass            |
| TS test   | `pnpm test`                        | all pass            |
| Typecheck | `pnpm exec tsc --noEmit`           | exit 0              |
| Build     | `pnpm run build`                   | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src-tauri/src/ai.rs` (consume the shared prompt resource)
- `src/lib/ai.ts` (consume the shared prompt resource)
- A new shared prompt resource (see steps — one of the two options)
- Tests that assert prompt content (`ai.rs` `messages_follow_ui_language`,
  `src/lib/__tests__/` if any)

**Out of scope** (do NOT touch):

- The parser implementations themselves (plans 001/011 just fixed them —
  this plan only _documents_ their contract).
- Any UI file.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Choose and create the single source of truth

**Option A (recommended, zero new deps)**: a JSON file
`src-tauri/prompts.json` (next to `src/`) containing:

```json
{
  "systemPromptEn": "...",
  "systemPromptAr": "...",
  "cancelledMarker": "\u{1F6D1}PAPYRUS_CANCELLED"
}
```

- Rust: `const PROMPTS: &str = include_str!("../prompts.json");` parsed
  once with `serde_json` into a `static` (or parse per call — it's tiny;
  prefer `OnceLock<serde_json::Value>`), and `SYSTEM_PROMPT_EN` /
  `SYSTEM_PROMPT_AR` / marker constants replaced by lookups.
- TS: `import prompts from "../../src-tauri/prompts.json"` — Vite resolves
  JSON imports natively (`resolveJsonModule` is already on in tsconfig).
  Replace the two constants and the marker.

**Option B**: keep prompts in Rust as `pub const`, generate/export a TS
module via a small build script. More moving parts; only choose if Option A
hits a wall (report if so).

- Whatever the option, the marker from plan 005 must be the SAME string in
  both languages, sourced from the shared resource.

**Verify**: `cd src-tauri && cargo test --lib` → all pass (the
`messages_follow_ui_language` test still passes — it asserts prompt
content, which is unchanged). `pnpm test` → all pass.

### Step 2: Document the parser contract

In `src-tauri/src/ai.rs` above `stream_chat` and in `src/lib/ai.ts` above
`streamExplanationBrowser`, add an identical comment block — the shared
contract:

```
// SSE parser contract (both languages MUST match):
// - Lines are split on \n (stripping trailing \r).
// - Only lines starting with "data:" carry payloads; ": " comments and
//   blanks are ignored.
// - "[DONE]" ends the stream successfully.
// - A clean close WITHOUT [DONE] is SUCCESS if content was received
//   (Rust: Ok(full); TS: resolve) and an error if nothing was received.
// - Cancellation surfaces the CANCELLED_MARKER string (Rust: Err(marker);
//   TS: throw Error(marker)).
// - Delta payloads are JSON objects; content lives at choices[0].delta.content.
```

**Verify**: no behavior change — all tests still pass.

### Step 3: Align the remaining duplication checks

- `build_chat_url` / `normalizeBaseUrl`: keep both implementations (they
  run in different environments) but add a cross-check unit test in the TS
  suite that asserts `normalizeBaseUrl("https://x/v1")` matches the Rust
  contract from plan 008 (loopback http allowance is Rust-side only; the
  TS dev path may keep the simpler rule — document that divergence in the
  contract comment). If plan 008's rules are desired in TS too, mirror
  them and add tests.
- `build_messages` / `buildMessages`: leave as-is (they're tiny and
  environment-specific), but add a TS test asserting the user-message shape
  matches what `messages_follow_ui_language` asserts in Rust (title,
  authors, published, categories, abstract — exact field order).

**Verify**: `pnpm test` → all pass with the new cross-check tests.

## Test plan

- Update `ai.rs` `messages_follow_ui_language` if the prompt source changes
  the access pattern (keep the same assertions).
- New TS tests: prompt resource loads (both languages present),
  user-message shape matches the Rust contract, marker is exported and
  matches the resource.
- Verification: `cargo test --lib` + `pnpm test` both green.

## Done criteria

- [ ] Prompts and the cancellation marker exist in exactly ONE source
      (the shared resource); `grep -rn "SYSTEM_PROMPT_EN" src/` and
      `grep -rn "SYSTEM_PROMPT_EN\|SYSTEM_PROMPT_AR" src-tauri/src/` →
      no duplicate definitions (lookups may remain by name)
- [ ] The contract comment exists verbatim above both parsers
- [ ] `cd src-tauri && cargo test --lib` — all pass
- [ ] `pnpm test` — all pass (including new cross-check tests)
- [ ] `pnpm exec tsc --noEmit` and `pnpm run build` — exit 0
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Vite/TS can't import JSON from `src-tauri/` (it's outside `src/` — if
  the import path is rejected, move the resource into `src-tauri/src/`
  and adjust `include_str!` paths accordingly; that's within the plan's
  intent, report the path you used).
- A test exposes prompt-content drift (Rust vs TS differed before this
  plan) — reconcile to the Rust version (the backend is authoritative) and
  note it in the status row.

## Maintenance notes

- Future prompt edits happen in the shared resource only; the
  `messages_follow_ui_language`-style tests will catch accidental drift.
- Plan 025 (search) will extend `build_messages`/`fetch` — update the
  shared contract tests in the same change.
- Reviewer: verify no prompt text changed value (only location) — a
  changed prompt is a user-visible behavior change and would need its own
  review.
