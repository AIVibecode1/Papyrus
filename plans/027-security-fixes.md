# Plan 027: Security — fix is_local_base_url substring match and redaction gaps

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check**: `git diff --stat 7e26e2d..HEAD -- src-tauri/src/ai.rs src/lib/ai.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `7e26e2d`, 2026-08-04

## Why this matters

`is_local_base_url` uses `contains("localhost")` so a crafted URL like
`https://localhost.evil.com` passes as "local", skipping the API key
requirement and sending requests to a remote host with an empty auth
header. Separately, `redact_tokens` only redacts keys with known
prefixes (`sk-`, `ghp_`, etc.), so custom-gateway keys with no
recognizable prefix pass through to the UI unredacted.

## Current state

- **`src-tauri/src/ai.rs:163-165`** — `is_local_base_url`:
  ```rust
  fn is_local_base_url(base_url: &str) -> bool {
      base_url.contains("localhost") || base_url.contains("127.0.0.1")
  }
  ```
- **`src-tauri/src/ai.rs:105-118`** — `is_loopback_host`: a stricter
  check that strips brackets/ports and matches exactly `localhost`/
  `127.0.0.1`/`::1`.

- **`src-tauri/src/ai.rs:356-384`** — `redact_tokens`: replaces runs
  after known prefixes. No generic long-opaque-run fallback.

- **`src/lib/ai.ts:66-68`** — `redactTokens`: the TS mirror with the
  same prefix list.

Conventions: Rust error handling follows `Result<T, String>`. Keychain
is the credential store (never log keys). The contract test
`ai-contract.test.ts` pins shared behavior between Rust and TS.

## Commands you will need

| Purpose   | Command                           | Expected on success |
| --------- | --------------------------------- | ------------------- |
| Typecheck | `pnpm run typecheck`              | exit 0              |
| Rust      | `cargo test --lib` (in src-tauri) | all pass            |
| Frontend  | `pnpm test`                       | all pass            |
| Lint      | `pnpm run lint`                   | exit 0              |

## Scope

**In scope**:

- `src-tauri/src/ai.rs`
- `src/lib/ai.ts`
- `src/lib/__tests__/ai-contract.test.ts` (add parity tests)

**Out of scope**:

- `src-tauri/src/pdf.rs` — SSRF guard (separate plan if needed)
- Any keychain code beyond `load_key`'s use of `is_local_base_url`

## Git workflow

- Branch: `advisor/027-security-fixes`
- Conventional commits: `fix(security): ...`

## Steps

### Step 1: Replace is_local_base_url with is_loopback_host on the parsed host

Delete `is_local_base_url` (lines 163-165). Add a helper that extracts
the host from a base URL and calls `is_loopback_host`:

```rust
fn base_url_host(base_url: &str) -> &str {
    let after_scheme = base_url
        .strip_prefix("https://")
        .or_else(|| base_url.strip_prefix("http://"))
        .unwrap_or(base_url);
    after_scheme.split('/').next().unwrap_or(after_scheme)
}
```

Update `load_key` (which currently calls `is_local_base_url`) to call
`is_loopback_host(base_url_host(&provider.base_url))`.

Add tests for:

- `https://localhost.evil.com` → NOT loopback
- `https://localhost:11434` → loopback
- `http://127.0.0.1:8080/v1` → loopback
- `https://attacker.com/127.0.0.1/v1` → NOT loopback

**Verify**: `cargo test --lib` → all pass

### Step 2: Add generic long-opaque-run redaction fallback

After the prefix-based pass in `redact_tokens` (Rust) and `redactTokens`
(TS), add a fallback regex that masks any run of >=32 chars of
`[A-Za-z0-9_-.]` that is not a known common word. This catches
custom-gateway keys with no standard prefix.

Rust pattern: iterate the text, find runs matching the char class, and
if the run is >=32 chars and not in a small skip-list (common words like
"comprehensive", "responsibility"), replace with `«redacted»`.

Keep the TS regex in sync. Add the same skip-list.

**Verify**: `cargo test --lib` → all pass, `pnpm test` → all pass

### Step 3: Add parity tests

In `ai-contract.test.ts`, add a test that feeds a shared fixture of
`(input, expected)` pairs through `redactTokens` (TS). For the Rust
side, add a test with the same pairs. Include:

- A key with `sk-` prefix (existing behavior)
- A 48-char hex string with no prefix (new fallback)
- A normal sentence with no secrets (should pass through)
- A base64 JWT (`eyJ...` pattern)

**Verify**: `pnpm test` → all pass, `cargo test --lib` → all pass

## Done criteria

- [ ] `cargo test --lib` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] No `contains("localhost")` substring match remains in `ai.rs`
- [ ] Parity tests exist for both Rust and TS redaction

## STOP conditions

Stop and report if:

- The redaction fallback regex has false positives on normal AI output.
- `is_loopback_host` is used by other code that depends on it accepting
  URLs (not bare hosts).

## Maintenance notes

- The `base_url_host` helper should be reused if any new check needs
  to inspect the host portion of a provider URL.
- The skip-list for the redaction fallback should be kept short — it
  only needs to avoid masking very common long English words.
