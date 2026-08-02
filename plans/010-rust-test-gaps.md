# Plan 010: Close Rust test gaps — fragmented streams, cancellation, edge units

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
- **Depends on**: plans/001 (UTF-8 fix changes the same parser — run 001 first so these tests target the fixed code)
- **Category**: tests
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

The riskiest Rust code has the weakest coverage. The mock server
(`spawn_mock_server`) writes its whole response in one `write_all`, so the
incremental line-reassembly loop (`buf` / `find('\n')` / `drain`) is never
exercised with split or partial lines — exactly what real networks do. The
cancel flag path, keep-alive lines, the clean-close-without-`[DONE]`
behavior, and several small units (`load_key`, `validate_provider`,
malformed-entry skip, pdf-link fallback) have no tests. Plan 001 changes
the parser; this plan pins the rest of the behavior.

## Current state

- `src-tauri/src/ai.rs` — `spawn_mock_server` (tests, ~lines 356-408)
  writes `stream.write_all(response.as_bytes())` once; `stream_chat`
  lines 124-159 (see plan 001 for the parser); `load_key` lines 72-85;
  `validate_provider` lines ~194-206; `stop_explaining` lines 268-270.
- `src-tauri/src/papers.rs` — `parse_feed` skips malformed entries
  (`title.is_empty() && summary.is_empty()` → `continue`); pdf fallback at
  line 134.

## Commands you will need

| Purpose    | Command                            | Expected on success   |
| ---------- | ---------------------------------- | --------------------- |
| Rust test  | `cd src-tauri && cargo test --lib` | all pass              |
| Rust check | `cd src-tauri && cargo check`      | Finished, no warnings |

## Scope

**In scope** (the only files you should modify):

- `src-tauri/src/ai.rs` (tests only)
- `src-tauri/src/papers.rs` (tests only)

**Out of scope** (do NOT touch):

- Non-test code — if a test exposes a bug in non-test code, report it
  (STOP condition) instead of fixing silently; the fix belongs in its own
  plan.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Chunked-write mock server variant

- Add `spawn_mock_server_chunked(parts: Vec<&str>)` in `ai.rs` tests:
  same accept loop as `spawn_mock_server`, but writes each part with a
  separate `write_all` and a `thread::sleep(Duration::from_millis(5))`
  between parts, then closes the stream.
- Keep `spawn_mock_server` unchanged (other tests use it).

**Verify**: `cargo test --lib` → still all green (no new tests yet).

### Step 2: Parser robustness tests (after plan 001's parser is in place)

Using `spawn_mock_server_chunked`, add tests:

1. `streams_content_split_mid_line`: split the SSE response so a `data:`
   line is cut between two parts — assert full text is intact.
2. `ignores_keepalive_and_comment_lines`: include `: ping\n\n` and blank
   lines between events — assert content only.
3. `clean_close_without_done_returns_content`: response ends after a
   content event with NO `[DONE]` — assert `Ok(full)` with the content
   (this is the behavior introduced by plan 001).
4. `cancel_flag_stops_stream_with_marker`: after plan 005, assert the
   returned `Err` equals the cancellation marker when `CANCEL_EXPLAIN` is
   set mid-stream (use a chunked mock with a slow second part so the flag
   can be set between writes). Reset the flag afterwards (set false in the
   test or use a scoped helper).

**Verify**: `cargo test --lib` → all pass.

### Step 3: Unit tests for the small untested units

- `load_key` — needs an `AppHandle` (hard to construct in tests). Test the
  _logic_ instead: extract the local-host detection into a testable
  function if it isn't already (e.g. `fn is_local_base_url(url: &str) ->
bool`) — if extraction is needed, it's a tiny refactor of `ai.rs:77`;
  then test: `localhost` → true, `127.0.0.1` → true, `https://api.x.com` →
  false. (Do NOT mock the keyring; only the pure function.)
- `validate_provider` — direct unit tests: valid config passes; empty id /
  empty name / empty model / bad scheme → each `Err`.
- `parse_feed` edge cases in `papers.rs`:
  - `skips_malformed_entries`: feed with one good entry + one entry with
    empty title AND empty summary → only the good entry returned.
  - `pdf_link_fallback_uses_id`: entry with no `application/pdf` link →
    `pdf_url == "https://arxiv.org/pdf/<id>"` (note: plan 008 normalizes
    http→https; write against the post-008 behavior if it landed, else the
    current fallback string).
  - (If plan 008 already landed: `normalizes_http_pdf_links` is covered
    there — don't duplicate.)

**Verify**: `cargo test --lib` → all pass; `cargo check` → no warnings.

## Test plan

- All tests in-file (`#[cfg(test)] mod tests`), following the existing
  patterns (`streams_sse_chunks_in_order`, `parses_atom_feed`).
- Verification: `cargo test --lib` → all pass (expect ~8-10 new tests).

## Done criteria

- [ ] `cd src-tauri && cargo test --lib` — all pass, including the new tests
- [ ] `cd src-tauri && cargo check` — no warnings
- [ ] New tests cover: mid-line split, keep-alive lines, clean close
      without [DONE], cancel marker, `validate_provider` errors,
      `parse_feed` malformed-entry skip, pdf fallback
- [ ] No non-test code modified (unless the `is_local_base_url` extraction,
      which must be behavior-preserving)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A new test exposes a real bug in non-test code (other than the
  `is_local_base_url` extraction) — report the bug and STOP; do not fix
  it inside this plan.
- Plan 001 or 005 haven't landed and the parser/cancel behavior differs
  from what these tests assume — run 001 and 005 first.

## Maintenance notes

- The chunked mock server is the standard tool for any future streaming
  work — reuse it, don't duplicate.
- When plan 016 (dedup) revisits the parser, these tests define the Rust
  contract that the TS side must mirror.
