# Plan 018: Make AI stream lifecycle and provider contracts explicit

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src/lib/ai.ts src/lib/reader-ai.ts src/stores/reader.ts src/stores/explanation.ts src-tauri/src/ai.rs`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: correctness | architecture | tests
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

The AI layer has separate browser and Rust implementations, a single global browser `AbortController`, typed cancellation, provider failover, SSE parsing, and multiple reader actions. That is a high-risk contract surface. A future stream can be aborted by an unrelated action or can diverge between preview and packaged app. The code comments already identify the single-active-stream assumption; it should become an explicit tested lifecycle contract before more providers or reader features are added.

## Current state

- `src/lib/ai.ts:13-15` keeps one global browser controller; `src/lib/ai.ts:108-114` stops that controller.
- `src/lib/ai.ts:89-103` uses a Tauri channel for the Rust path, while `src/lib/ai.ts:126-190` parses browser SSE separately.
- `src-tauri/src/ai.rs` contains the Rust stream parser, timeout, cancellation marker, failover, and keychain access.
- `src/stores/reader.ts` and `src/stores/explanation.ts` maintain separate generation/buffer state machines.
- Existing tests cover parser chunks, cancellation, failover, reader walkthrough, and multi-flush behavior, but the single-active-stream assumption and cross-action cancellation contract should be tested directly.

## Commands you will need

| Purpose           | Command                                                                                                               | Expected |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| AI frontend tests | `pnpm exec vitest run src/lib/__tests__ src/stores/__tests__/reader.test.ts src/stores/__tests__/explanation.test.ts` | all pass |
| Full frontend     | `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run format:check`                                       | all pass |
| Rust AI tests     | `cargo test --manifest-path src-tauri/Cargo.toml --lib ai::tests`                                                     | all pass |
| Rust quality      | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                                                    | exit 0   |

## Scope

**In scope**:

- `src/lib/ai.ts`, `src/lib/reader-ai.ts`
- `src/stores/reader.ts`, `src/stores/explanation.ts`
- Existing frontend/Rust AI tests and new focused contract tests
- `src-tauri/src/ai.rs` only as needed to make the contract explicit

**Out of scope**:

- New provider integrations
- Keychain storage format changes
- Prompt/content redesign
- Replacing SSE or Tauri channels

## Steps

### Step 1: Write the lifecycle contract tests first

Specify and test: one operation owns one cancellation handle; Stop cancels only the current operation; a stopped operation cannot append late chunks; a provider failover never retries after the first delivered chunk; clean close with content succeeds; clean close without content fails; browser and Rust classify cancellation with the same marker.

**Verify**: targeted frontend and Rust tests pass before behavior changes.

### Step 2: Decide whether single-active-stream is a hard product constraint

Inspect the UI to determine whether explanation, reader walkthrough, reader synthesis, and Ask can overlap. If overlap is impossible by design, document and enforce ownership with an operation ID. If overlap is possible, replace the singleton controller with an operation registry keyed by operation ID. STOP and report if this requires a public API change not covered by current tests.

**Verify**: tests prove an unrelated stream cannot be aborted or receive chunks.

### Step 3: Align browser and Rust error taxonomy

Create a small shared conceptual contract, not a cross-language dependency: cancellation marker, pre-first-chunk retry rule, post-first-chunk terminal rule, clean-close rule, redaction rule, and bounded error text. Preserve the existing security rule that keys never enter frontend persistent storage.

**Verify**: parser and failover tests pass in both implementations.

### Step 4: Add observability without secrets

Add only safe diagnostics useful for user-facing status or tests: provider label, phase, elapsed bucket, and whether content started. Never log URLs with credentials, request bodies, keys, or full provider error bodies.

**Verify**: security tests assert known token-shaped inputs are redacted and diagnostics contain no key value.

## Test plan

- Stop one operation while another mock operation is active.
- Late chunks after cancellation are ignored.
- Failover before/after first content.
- Browser and Rust malformed SSE/clean-close parity.
- Error redaction and bounded message length.

## Done criteria

- [ ] Stream ownership is explicit and tested.
- [ ] Stop cannot affect an unrelated operation.
- [ ] Browser/Rust lifecycle rules are documented and tested.
- [ ] No secrets appear in diagnostics or persistent browser state.
- [ ] Full frontend and Rust gates pass.

## STOP conditions

- The UI actually supports concurrent reader operations and the current public command shape cannot carry an operation ID without a coordinated interface change.
- A proposed diagnostic would require logging provider keys, full URLs with credentials, or full error bodies.
- Browser and Rust behavior cannot be aligned without changing the cancellation marker; report before changing the marker.

## Maintenance notes

Every new AI action must declare its operation ownership, cancellation behavior, retry boundary, and persistent-history behavior before implementation. Keep browser preview behavior intentionally equivalent to the packaged Tauri path.
