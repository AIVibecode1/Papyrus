# Plan 009: Share one reqwest client across Tauri commands

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
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Every command call builds a fresh `reqwest::Client` — three sites
(`explain_paper`, `test_provider` in `ai.rs`, `fetch_papers` in
`papers.rs`). Each construction means a brand-new connection pool: every
DNS lookup, TCP handshake and TLS session is paid per call, with no
keep-alive reuse. Visible cost: repeated Settings "Test" clicks each
re-handshake (~50–300 ms), and time-to-first-token on explanations. It also
means three independent timeout configs that must be kept consistent.

## Current state

- `src-tauri/src/ai.rs:221-226` (explain_paper):

```rust
    let client = reqwest::Client::builder()
        .timeout(EXPLAIN_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
```

- `src-tauri/src/ai.rs:250-254` (test_provider): same pattern with
  `TEST_TIMEOUT`.
- `src-tauri/src/papers.rs:65-69` (fetch_papers): same pattern with
  `REQUEST_TIMEOUT` + `.user_agent(USER_AGENT)`.
- `src-tauri/src/lib.rs` — `run()` registers plugins and the invoke
  handler; no managed state.

## Commands you will need

| Purpose    | Command                            | Expected on success   |
| ---------- | ---------------------------------- | --------------------- |
| Rust test  | `cd src-tauri && cargo test --lib` | all pass              |
| Rust check | `cd src-tauri && cargo check`      | Finished, no warnings |

## Scope

**In scope** (the only files you should modify):

- `src-tauri/src/ai.rs`
- `src-tauri/src/papers.rs`
- `src-tauri/src/lib.rs` (only if registering managed state)

**Out of scope** (do NOT touch):

- Any frontend file. Any change to the public command signatures.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Create one client and share it

- In `src-tauri/src/papers.rs` or a new shared spot (simplest: a small
  `client.rs` module, or add to `papers.rs` and import from `ai.rs` —
  follow the existing module layout; `lib.rs` declares `mod papers; mod ai;`):

```rust
use std::sync::OnceLock;
use reqwest::Client;

/// Shared HTTP client with keep-alive across commands.
pub fn shared_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(crate::papers::USER_AGENT)
            .build()
            .expect("reqwest client build cannot fail at runtime")
    })
}
```

Notes:

- `USER_AGENT` is defined in `papers.rs` (line 8) — make it `pub(crate)`
  or move it to the shared module.
- Default timeouts are removed from the client; per-command timeouts move
  onto the individual requests (step 2).
- If a module-level `OnceLock` in `papers.rs` is cleaner for imports,
  that's fine — the requirement is ONE client total.

- `lib.rs`: no change needed for `OnceLock` (no managed state required).
  Do NOT use `tauri::Builder::manage` unless the OnceLock approach hits a
  problem — keep it simple.

**Verify**: `cd src-tauri && cargo check` → Finished, no warnings.

### Step 2: Apply per-request timeouts

- In `ai.rs` `explain_paper`: replace the client construction with
  `let client = shared_client();` and add
  `.timeout(EXPLAIN_TIMEOUT)` to the `RequestBuilder` chain (on `request`
  before `.json(&body)`, i.e. `client.post(url).timeout(EXPLAIN_TIMEOUT)`).
- Same for `test_provider` with `TEST_TIMEOUT`.
- In `papers.rs` `fetch_papers`: replace the client construction with the
  shared client and add `.timeout(REQUEST_TIMEOUT)` to the GET builder.
- Keep all error messages (`map_err` strings) identical to today's.

**Verify**: `cd src-tauri && cargo test --lib` → all pass (existing tests
exercise `stream_chat` with a locally-built client in tests — they pass a
`&Client` in, so they're unaffected; the commands themselves are covered by
the live ignored test and manual runs).

## Test plan

- Existing tests cover `stream_chat`; they remain valid (they construct
  their own client — that's fine for tests).
- Add nothing new; verification is `cargo test --lib` + `cargo check`.

## Done criteria

- [ ] `cd src-tauri && cargo test --lib` — all pass
- [ ] `cd src-tauri && cargo check` — no warnings
- [ ] `grep -n "Client::builder" src-tauri/src/` → at most one occurrence
      (in the shared client)
- [ ] All three commands use the shared client with per-request timeouts
- [ ] No files outside `ai.rs` / `papers.rs` / (optionally) `lib.rs` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Tests fail because `stream_chat`'s signature or the test helpers need the
  shared client (they shouldn't — tests pass their own client) — if so,
  report rather than changing the test helpers' semantics.
- A second `Client::builder()` appears necessary (e.g. different TLS or
  proxy settings per path) — report; the plan assumes one client suffices.

## Maintenance notes

- When plan 016 (dedup) lands, the TS browser path has no equivalent
  pooling concern (browsers pool natively).
- If a future feature needs a distinct proxy or TLS config, add a second
  client deliberately — do not silently rebuild per call.
- Reviewer: confirm timeouts still apply (a client-level default removed
  without a request-level replacement would hang streams forever).
