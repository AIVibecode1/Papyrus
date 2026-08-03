# Plan 014: Make PDF fetching and caching robust against URL and cache attacks

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src-tauri/src/pdf.rs src-tauri/src/papers.rs src-tauri/Cargo.toml`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security | correctness
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

The PDF command accepts an S2 URL supplied by frontend paper data, validates its DNS result once, then passes the original hostname to the HTTP client. DNS can resolve differently between validation and connection, so validation is not a complete SSRF boundary. The cache filename also removes unsafe characters rather than hashing the complete identity, which can cause distinct IDs to share a cache file. PDFs are user-controlled network data and are an important security boundary.

## Current state

- `src-tauri/src/pdf.rs:64-107` implements `ensure_public_https` by resolving the host and rejecting private IPs.
- `src-tauri/src/pdf.rs:127-134` validates the S2 URL and then downloads the original URL through `shared_client()`.
- `src-tauri/src/pdf.rs:140-155` creates a cache path by filtering characters from `paper_id` and appending `.pdf`.
- `src-tauri/src/pdf.rs:24-31` checks the size only after `response.bytes()` has buffered the complete body.
- Existing PDF tests are in `src-tauri/src/pdf.rs:192-309`; follow their local TCP-server style and do not add external network tests.

## Commands you will need

| Purpose        | Command                                                                         | Expected           |
| -------------- | ------------------------------------------------------------------------------- | ------------------ |
| Rust tests     | `cargo test --manifest-path src-tauri/Cargo.toml --lib pdf::tests`              | all PDF tests pass |
| Clippy         | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`              | exit 0             |
| Format         | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`                     | exit 0             |
| Frontend gates | `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run format:check` | all pass           |

## Scope

**In scope**:

- `src-tauri/src/pdf.rs`
- PDF unit tests in that file
- `src-tauri/Cargo.toml` only if an already-present dependency feature is needed

**Out of scope**:

- Frontend PDF UI and pdf.js rendering
- Provider URL policy
- Any secret/keychain code
- New dependencies unless the executor stops and reports why an existing crate cannot solve it

## Steps

### Step 1: Characterize identity and size behavior

Add tests proving that two distinct paper IDs cannot resolve to the same cache path and that a response whose declared or streamed body exceeds `MAX_PDF_BYTES` is rejected before unbounded buffering. Preserve the existing 30 MB user-facing limit.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib pdf::tests` → all pass, including the new regression tests.

### Step 2: Replace filtered cache names with collision-resistant names

Derive the cache filename from a stable hash of the complete source identity: source plus paper ID, and for S2 papers the validated URL if URL identity affects content. Keep the cache directory unchanged and preserve cache hits for the chosen identity format. Do not put raw URLs in filenames.

**Verify**: add a unit test for stable same-input output and different-output for distinct IDs/URLs; run the PDF test command.

### Step 3: Enforce the network boundary during download

Use a single validated request path that prevents DNS rebinding between validation and connection. Prefer resolving and connecting to an approved public address while preserving the HTTPS certificate/Host semantics. If the existing HTTP client cannot do this safely without a substantial transport rewrite, STOP and report the limitation instead of weakening the guard. Keep redirects disabled or validate every redirect target before following it.

**Verify**: local tests cover plaintext, credentials, loopback, private IPv4, link-local, IPv6 loopback/link-local, invalid host, and redirect policy. Run clippy and the PDF test suite.

### Step 4: Stream the body with a hard limit

Read response chunks incrementally and stop when the accumulated size exceeds `MAX_PDF_BYTES`; do not call an unbounded whole-body method before applying the limit. Preserve useful HTTP status errors and clean cancellation behavior.

**Verify**: a local server test sends an oversized body and proves the command returns the size error; all Rust gates pass.

## Test plan

- Cache identity collision and stability.
- Oversized body rejected while streaming.
- Existing URL validation cases remain rejected.
- Redirect behavior cannot bypass validation.
- Normal small PDF still downloads unchanged.

## Done criteria

- [ ] No cache filename is produced by character filtering alone.
- [ ] Body size is bounded while reading, not after full buffering.
- [ ] Redirects cannot bypass the public HTTPS policy.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` passes.
- [ ] clippy, rustfmt, and all frontend gates pass.
- [ ] Only in-scope files are modified.

## STOP conditions

- The HTTP stack cannot pin/validate the destination without changing a shared client used by paper fetching.
- A proposed fix requires trusting frontend-supplied source identity or adding a broad Tauri capability.
- Existing cache files would need silent migration with no deterministic compatibility strategy.

## Maintenance notes

Review redirects, DNS behavior, and cache identity whenever another paper source is added. Never replace the streaming size guard with `bytes()` for convenience.
