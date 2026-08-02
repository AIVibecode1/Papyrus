# Plan 001: Fix Rust SSE streaming to preserve multi-byte UTF-8 (Arabic)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: the repo has **no git commits yet** (all files
> untracked). Compare the "Current state" excerpts below against the live
> files; on any mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Papyrus's flagship feature is AI explanations of papers, and Arabic is a
first-class language. The Rust SSE parser decodes each network chunk with
`String::from_utf8_lossy` independently — when a multi-byte UTF-8 character
(such as an Arabic letter, 2–3 bytes) is split across two TCP chunks (which
happens routinely with streaming providers), the split byte sequence becomes
U+FFFD (�) garbage. The browser-preview path uses `TextDecoder(..., {stream:true})`
and handles this correctly — so the desktop app and the preview behave
differently, and Arabic explanations in the real app can be corrupted.
The fix makes the Rust parser byte-buffered: split on `\n` at the byte level
and decode only complete lines.

## Current state

- `src-tauri/src/ai.rs:124-159` — the SSE branch of `stream_chat`:

```rust
    if content_type.contains("text/event-stream") {
        let mut stream = response.bytes_stream();
        let mut buf = String::new();
        loop {
            let chunk = stream
                .next()
                .await
                .ok_or_else(|| "Stream ended unexpectedly".to_string())?
                .map_err(|e| format!("Stream error: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));   // <-- line 133: the bug
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim_end_matches('\r').to_string();
                buf.drain(..=pos);
                ...
```

The buffer is a `String`; the fix changes it to `Vec<u8>` and processes
complete lines. Repo conventions: error strings are plain `String` via
`map_err`; tests live in the same file under `#[cfg(test)] mod tests`
(see `ai.rs:306+`, pattern: `streams_sse_chunks_in_order`).

## Commands you will need

| Purpose    | Command                            | Expected on success   |
| ---------- | ---------------------------------- | --------------------- |
| Rust test  | `cd src-tauri && cargo test --lib` | all pass              |
| Rust check | `cd src-tauri && cargo check`      | Finished, no warnings |

## Scope

**In scope** (the only files you should modify):

- `src-tauri/src/ai.rs`

**Out of scope** (do NOT touch, even though they look related):

- `src/lib/ai.ts` — the browser parser; it is already correct and is
  handled by plan 016 (dedup), not here.
- The non-streaming JSON branch (`ai.rs:162+`) and everything else.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Rewrite the SSE buffer to byte-based line splitting

In `src-tauri/src/ai.rs`, replace the SSE branch body (lines 124–159) so that:

- `let mut buf: Vec<u8> = Vec::new();`
- On each `chunk` (`Bytes`): `buf.extend_from_slice(&chunk);`
- Loop: find `\n` via `buf.iter().position(|&b| b == b'\n')`. If found, take
  the complete line bytes `buf[..pos]`, strip a trailing `\r`
  (`.strip_suffix(b"\r")`), `buf.drain(..=pos)`, then decode the line with
  `std::str::from_utf8(&line_bytes)`.
  - On `Ok(line_str)` — process exactly as today: `strip_prefix("data:")`,
    `[DONE]` → `return Ok(full)`, JSON parse, delta content, cancel check,
    `full.push_str(content)`, `on_chunk(content)`.
  - On `Err(_)` — skip the line (invalid UTF-8 within a line is malformed
    SSE; do not emit U+FFFD into `full`).
- The cancel check after the inner line loop (`ai.rs:156-158`) stays.
- **Behavior change**: when the stream ends (`.next().await` → `None`)
  WITHOUT a `[DONE]` marker: if `!full.is_empty()` return `Ok(full)` (the
  content is complete enough — some providers/proxies close cleanly without
  the marker); if `full.is_empty()` return `Err("Stream ended unexpectedly")`.
  Keep the current behavior's spirit for the empty case.

Keep the existing structure, comments and error strings otherwise unchanged.

**Verify**: `cd src-tauri && cargo check` → Finished, no warnings.
Then `cargo test --lib` → all existing tests pass (7 passed; 1 ignored).

### Step 2: Add a regression test for split multi-byte UTF-8

In the `#[cfg(test)] mod tests` block of `src-tauri/src/ai.rs`:

- Extend `spawn_mock_server` (lines ~356–408) OR add a second helper
  `spawn_mock_server_chunked(response_parts: Vec<&str>)` that writes each
  part with a separate `write_all` call, sleeping ~5 ms between writes.
- Add a test `streams_utf8_split_across_chunks`: stream an SSE response whose
  content contains Arabic text, e.g. `"مرحبا بالعالم"` (7 chars, 21 bytes),
  and split the response **in the middle of one Arabic character** between
  two write parts. Assert:
  - `full` equals the exact Arabic string (no `\u{FFFD}` anywhere).
  - Every `on_chunk` string concatenated equals the same string.
- Keep the existing `streams_sse_chunks_in_order` test untouched (must still
  pass — the line-splitting contract is unchanged for ASCII).

**Verify**: `cargo test --lib` → all tests pass, including the new one.
`grep -c "FFFD" src-tauri/src/ai.rs` → 0.

## Test plan

- New test `streams_utf8_split_across_chunks` in `src-tauri/src/ai.rs`
  (pattern: existing `streams_sse_chunks_in_order` test, same file).
- Also verify `handles_non_streaming_json` and `surfaces_provider_errors`
  still pass (they exercise the same function).
- Verification command: `cd src-tauri && cargo test --lib` → all pass.

## Done criteria

- [ ] `cd src-tauri && cargo check` exits 0, no warnings
- [ ] `cd src-tauri && cargo test --lib` — all tests pass (7 existing + new UTF-8 test)
- [ ] The new test actually fails against the old code (verify by checking the
      test splits mid-character; if it passes trivially, the split point is wrong)
- [ ] No files outside `src-tauri/src/ai.rs` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `ai.rs:124-159` doesn't match the excerpt above (drift).
- A real provider response format appears that the new parser can't handle
  beyond what's described (e.g. multi-line `data:` payloads) — the current
  parser already assumes single-line data; do not extend scope.
- `cargo test` fails twice after a reasonable fix attempt.

## Maintenance notes

- Plan 016 (AI-layer dedup) will revisit both parsers — this fix establishes
  the correct Rust contract (complete-line decoding, clean-close tolerance)
  that 016 must preserve.
- If streaming formats evolve (e.g. provider sends `data:` lines with
  embedded newlines), the byte-buffer approach still holds; only the line
  parsing would need extension.
- Reviewer should scrutinize: the `[DONE]` return path, the empty-close
  error path, and that `full` contains no U+FFFD after a fragmented stream.
