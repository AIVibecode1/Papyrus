# Plan 008: Enforce HTTPS for provider keys and normalize arXiv PDF links

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
- **Category**: security
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Two plaintext-transport issues:

1. `build_chat_url` accepts `http://` for **any** host, and the API key is
   then sent as a bearer token over that URL. A user configuring a LAN or
   remote provider with `http://` (or a typo'd `http` when they meant
   `https`) sends their key in cleartext, readable by any on-path observer.
2. `papers.rs` takes the arXiv PDF link verbatim from the feed. While the
   real arXiv API currently serves `https://` links, the code should not
   depend on that: an `http://arxiv.org/...` link is a downgrade/MITM-able
   target and the test fixture currently asserts an `http://` URL.

## Current state

- `src-tauri/src/ai.rs:39-49`:

```rust
fn build_chat_url(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("Base URL must start with http:// or https://".into());
    }
    if base.ends_with("/chat/completions") {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/chat/completions"))
    }
}
```

- `src-tauri/src/papers.rs:128-134` (pdf_url extraction) and the test
  fixture at `papers.rs:196` asserting `"http://arxiv.org/pdf/2607.12345v1"`.
- `load_key` (`ai.rs:72-85`) already treats `localhost`/`127.0.0.1` as the
  no-key-required case.

## Commands you will need

| Purpose    | Command                            | Expected on success   |
| ---------- | ---------------------------------- | --------------------- |
| Rust test  | `cd src-tauri && cargo test --lib` | all pass              |
| Rust check | `cd src-tauri && cargo check`      | Finished, no warnings |

## Scope

**In scope** (the only files you should modify):

- `src-tauri/src/ai.rs`
- `src-tauri/src/papers.rs`

**Out of scope** (do NOT touch):

- `src/lib/ai.ts` — the browser path (`normalizeBaseUrl`) mirrors this
  logic and is dev-only; plan 016 (dedup) will align them. If the TS side
  diverges behaviorally it only affects the browser preview.
- The settings UI (no inline warning — the hard error is sufficient for
  this pass).

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Restrict `http://` to loopback hosts in `build_chat_url`

In `src-tauri/src/ai.rs`, rewrite `build_chat_url`:

- Parse the base with a small helper or `url` crate-free string checks
  (keep it dependency-free): after trimming, extract the host portion
  between `://` and the next `/`.
- Rules:
  - `https://` → allowed for any host.
  - `http://` → allowed only when the host is `localhost`, `127.0.0.1`,
    `::1`, or `[::1]`; otherwise return
    `Err("HTTP (plaintext) base URLs are only allowed for local servers (localhost). Use https:// for remote providers.".into())`.
- Keep the existing `ftp://`/garbage rejection and the
  `/chat/completions` suffix handling unchanged.
- Update the existing `chat_url_normalization` test (ai.rs tests): add
  cases for `http://localhost:11434/v1` (allowed), `http://192.168.1.5/v1`
  (rejected), `http://api.example.com/v1` (rejected).

**Verify**: `cd src-tauri && cargo test --lib` → all pass.

### Step 2: Normalize arXiv PDF links to https

In `src-tauri/src/papers.rs:128-134`: after extracting `pdf_url`, map any
`http://arxiv.org/...` (and `http://export.arxiv.org/...`) prefix to
`https://`. Implement as:

```rust
fn normalize_pdf_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("http://arxiv.org/") {
        format!("https://arxiv.org/{rest}")
    } else if let Some(rest) = url.strip_prefix("http://export.arxiv.org/") {
        format!("https://export.arxiv.org/{rest}")
    } else {
        url.to_string()
    }
}
```

Apply it to the extracted link value before the `unwrap_or_else` fallback
(the fallback already uses https). Update the test fixture
(`papers.rs:196`) and the `parses_atom_feed` assertion to expect
`"https://arxiv.org/pdf/2607.12345v1"`; add an assertion that an
`http://` link in the fixture is normalized (change the fixture's
`application/pdf` link to `http://` to prove the normalization).

**Verify**: `cd src-tauri && cargo test --lib` → all pass.

## Test plan

- Extend `chat_url_normalization` (loopback allow / remote http reject).
- Extend `parses_atom_feed` (fixture uses `http://` pdf link → asserts
  `https://` output).
- Verification: `cargo test --lib` all pass.

## Done criteria

- [ ] `cd src-tauri && cargo test --lib` — all pass
- [ ] `cd src-tauri && cargo check` — no warnings
- [ ] `http://` non-loopback base URLs return the documented error
      (covered by test)
- [ ] No `http://arxiv.org` or `http://export.arxiv.org` strings survive
      `normalize_pdf_url` in the code path (test-covered)
- [ ] No files outside `ai.rs` / `papers.rs` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A user-visible workflow legitimately requires a non-loopback `http://`
  provider (e.g. a LAN Ollama on a Raspberry Pi) — that's a product
  decision; report it rather than widening the rule silently.
- The `url` crate is already present and the executor prefers it — fine to
  use it, but it must not be added as a new dependency for this; string
  parsing is sufficient.

## Maintenance notes

- Plan 016 (dedup) must mirror these rules into the shared contract so the
  browser preview behaves identically.
- If the settings UI later wants to _warn_ instead of hard-error for
  http:// LAN providers, the error message is the extension point.
