# Plan 023: Isolate AI cancellation and expire citation memory

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src-tauri/src/ai.rs src-tauri/src/citations.rs src-tauri/Cargo.toml src-tauri/Cargo.lock`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 018 recommended
- **Category**: correctness | security | performance
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

The Rust AI backend currently uses one global cancellation flag for all explanation commands. Concurrent operations can therefore clear or trigger one another’s cancellation state. Citation counts also use a persisted seven-day TTL but can remain indefinitely in the in-memory cache after the disk snapshot is stale. Both issues are silent correctness failures in long-running desktop sessions.

## Current state

- `src-tauri/src/ai.rs:17` defines a process-wide `CANCEL_EXPLAIN` flag.
- `src-tauri/src/ai.rs:376-377,489-491,638-655` resets, stops, and reads that flag across explanation commands.
- `src-tauri/src/citations.rs:55-72` rejects stale disk data but does not invalidate already-loaded memory.
- `src-tauri/src/citations.rs:159-177` can serve existing in-memory citation counts without a freshness check.
- Existing Rust tests cover streaming and citation caching; extend those patterns rather than adding a new test framework.

## Commands you will need

| Purpose        | Command                                                                                                                         | Expected |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| AI tests       | `cargo test --manifest-path src-tauri/Cargo.toml --lib ai::tests`                                                               | all pass |
| Citation tests | `cargo test --manifest-path src-tauri/Cargo.toml --lib citations::tests`                                                        | all pass |
| Full Rust      | `cargo test --manifest-path src-tauri/Cargo.toml --lib`                                                                         | all pass |
| Quality        | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | exit 0   |

## Scope

**In scope**:

- `src-tauri/src/ai.rs` and AI tests
- `src-tauri/src/citations.rs` and citation tests
- Tauri command payloads only if an operation identifier is required
- `src/lib/ai.ts` or reader stores only when required to pass an operation ID consistently

**Out of scope**:

- Prompt changes
- New provider integrations
- Keychain storage changes
- Replacing SSE/Tauri channels

## Steps

### Step 1: Characterize concurrent cancellation

Add deterministic tests with two mocked explanation operations. Prove that stopping operation A cannot cancel B and starting B cannot reset A’s cancellation. Preserve the current typed cancellation marker.

**Verify**: the new tests fail against the current global flag and pass once isolation is implemented.

### Step 2: Replace global cancellation with per-operation ownership

Use a request-scoped cancellation token or an operation registry keyed by an ID. Ensure cleanup occurs on success, error, cancellation, and dropped channel. The stop command must identify the intended active operation; if the UI can only support one operation, enforce that explicitly rather than silently sharing a global flag.

**Verify**: AI tests cover stop, success, error, failover, late chunks, and cleanup for multiple operation IDs.

### Step 3: Align frontend and Rust operation identity

If the command payload changes, update the browser preview contract and reader/explanation stores together. Keep browser and packaged Tauri behavior equivalent. Do not expose key values or full provider error bodies.

**Verify**: frontend AI tests and Rust AI tests pass; cancellation marker remains identical in both paths.

### Step 4: Enforce citation freshness in memory

Store freshness metadata with each in-memory citation entry or invalidate the in-memory map whenever the persisted snapshot is expired. Preserve successful current-session fetches and test TTL boundaries with a controllable clock.

**Verify**: stale in-memory entries are not returned; fresh entries are returned; disk roundtrip tests remain green.

## Test plan

- Concurrent cancellation isolation.
- Operation cleanup after all terminal outcomes.
- Pre-first-chunk failover and post-first-chunk failure.
- Browser/Rust cancellation parity.
- Citation memory TTL fresh/expired boundaries.
- No secret values in errors or test diagnostics.

## Done criteria

- [ ] No process-wide cancellation flag controls unrelated operations.
- [ ] Stop targets the intended operation.
- [ ] Stale citation counts cannot survive beyond the documented TTL.
- [ ] Existing AI and citation behavior remains covered.
- [ ] Full Rust and frontend gates pass if frontend contracts changed.

## STOP conditions

- The supported UI truly guarantees one operation and no safe operation identity can be added without a coordinated API change; report the exact contract boundary.
- A cancellation test requires real provider credentials or network access; use deterministic mocks instead.
- Citation freshness cannot be determined from current cache metadata; add a migration design before changing behavior.

## Maintenance notes

Every new streamed AI command must own a cancellation token and define its operation identity. Every cache with a documented TTL must enforce that TTL in both persisted and in-memory paths.

## Evidence

- Backend audit findings CORRECTNESS-01 and CORRECTNESS-02 from the security/backend audit.
- Related Plan 018 for cross-language AI lifecycle contracts.

No secrets are included in this plan.

## Verification baseline

```text
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

All must exit 0.

## Rejected adjacent concern

The audit did not promote a hardcoded API key finding: current inspected paths use OS keychain storage. Do not weaken that design by moving keys into frontend persistence.
