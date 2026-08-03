# Plan 005: Persist citation counts on disk with a TTL

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src-tauri/src/citations.rs src/stores/papers.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

Citation counts are fetched from Semantic Scholar on every list refresh and
every "load more", and the Rust side keeps only an in-memory session cache
(`CITATION_CACHE`). The design docs (`docs/spikes/second-source.md`, §A,
verified 2026-08-02) document that keyless Semantic Scholar is unreliable in
practice — repeated 429s observed from two IPs. Citation counts for a given
paper change slowly (days/weeks), so refetching them on every refresh wastes
the most flaky API call the app makes and makes the "Cited by" badges
appear and disappear between refreshes. A small on-disk cache with a TTL
(7 days) makes the badges stable across sessions and cuts API calls to a
handful per week.

## Current state

- `src-tauri/src/citations.rs:25-28` — session-only cache:
  ```rust
  static CITATION_CACHE: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
  fn cache() -> &'static Mutex<Option<HashMap<String, u32>>> {
      &CITATION_CACHE
  }
  ```
  `fetch_citations` (line ~45) merges fresh results into it; nothing
  survives a restart.
- `src/stores/papers.ts` — `loadCitations(ids)` (line ~140) is called from
  `refresh()` and `loadMore()` with the visible paper ids; failures are
  silent by design.
- The disk-cache pattern already exists in the repo:
  `src-tauri/src/pdf.rs:51-67` `cache_path()` builds a sanitized path under
  `app_data_dir()/pdfs`. Match that pattern (sanitized filename, best-effort
  writes, no failure propagation).

## Commands you will need

| Purpose    | Command                                                                                                       | Expected on success |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --lib` (with `export PATH="$HOME/.cargo/bin:$PATH"` in bash) | all pass            |
| Rust lint  | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                                            | clean               |
| Rust fmt   | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`                                                   | clean               |
| Tests      | `pnpm exec vitest run`                                                                                        | all pass            |
| Typecheck  | `pnpm exec tsc --noEmit`                                                                                      | exit 0              |

## Scope

**In scope**:

- `src-tauri/src/citations.rs` (disk cache + TTL)
- `src-tauri/src/citations.rs` tests (extend the existing test module)
- `plans/README.md` (status row)

**Out of scope**:

- `src/stores/papers.ts` — no frontend change needed; the command is
  called the same way.
- The S2 batch endpoint, request shape, or the failure-proof contract.
- The future "second source" feature (plan 011) — this cache will serve it,
  but it is not built here.

## Git workflow

- Branch: `advisor/005-citation-disk-cache`
- Commit style: `perf: cache citation counts on disk with a 7-day TTL`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Add the disk cache

In `src-tauri/src/citations.rs`:

1. Add a `citations_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String>`
   mirroring `pdf.rs` `cache_path` (same `app_data_dir()` + subdir, e.g.
   `citations`). The file holds one JSON object:
   ```json
   { "savedAt": 1754200000000, "counts": { "2607.00001v1": 42 } }
   ```
2. In `fetch_citations`, the command currently takes only `ids` — it must
   now take `app: tauri::AppHandle` too (the frontend invoke gains no new
   args; Tauri injects `AppHandle` automatically). Read the cache file at
   entry:
   - If `savedAt` is older than `CITATION_TTL` (7 days = 7 * 24 * 3600 *
     1000 ms) or the file is missing/corrupt → ignore it.
   - Otherwise treat it as the seed for the session `CITATION_CACHE` and
     return ONLY the ids present in it (do not hit the network for cached
     ids — that is the whole point).
   - Ids not present in the cache are fetched from the API as today.
3. After merging fresh results, write the whole map back
   (best-effort `fs::write`, like `pdf.rs:47` — a full disk must not fail
   the read path).
4. Keep the existing `ENV_LOCK`/`PAPYRUS_S2_URL` test override working:
   tests must be able to point the cache at a temp dir or disable it.
   Simplest: a `PAPYRUS_CACHE_DIR` env override read in
   `citations_cache_path` (test-only override, mirroring the S2 URL
   override pattern already in the file). Tests set it to a fresh temp dir
   per test.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all
pass (existing 45 + new).

### Step 2: Tests

Extend the `#[cfg(test)]` module:

1. `disk_cache_serves_counts_without_network` — prime the cache file with a
   known entry, call `fetch_citations` with a URL override that would fail
   (a listener that returns 500), assert the cached id's count comes back
   and the network was never hit (the mock server can assert zero
   connections by refusing to accept — use a bound listener with a short
   accept timeout, or simply point `PAPYRUS_S2_URL` at a port with no
   listener and assert the cached id still resolves).
2. `disk_cache_expires_after_ttl` — write a cache file with a
   `savedAt` older than the TTL (use a `PAPYRUS_CACHE_TTL_MS` env override
   or construct the timestamp directly), assert the API is consulted.
3. `corrupt_cache_file_is_ignored` — write garbage bytes, assert no panic
   and the API is consulted.
4. `cache_is_rewritten_after_fetch` — after a successful fetch, the file
   exists and contains the new counts (read it back).

Keep the existing tests' env-lock discipline: the cache dir env var is
process-global, so serialize cache-touching tests with the same
`ENV_LOCK` pattern already used for `PAPYRUS_S2_URL` (see
`fetch_with_override`, `citations.rs:250`).

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass, including the new tests.

### Step 3: Full gates

**Verify**:

1. `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` → clean
2. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` → clean
3. `pnpm exec tsc --noEmit` → exit 0 (the frontend invoke payload is
   unchanged — confirm no TS change is needed)
4. `pnpm exec vitest run` → all pass

## Test plan

- The four new Rust tests above; pattern to model after: the existing
  `citations.rs` tests (`spawn_mock_s2`, `fetch_with_override`) and
  `pdf.rs`'s `cache_path` tests if present.
- No frontend tests needed (no frontend change).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `fetch_citations` serves cached ids without network (test 1 passes)
- [ ] TTL expiry, corrupt-file, and rewrite tests pass
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` and fmt check clean
- [ ] `pnpm exec vitest run` and `pnpm exec tsc --noEmit` clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `fetch_citations` signature in the live file differs from the plan's
  description (drift — especially if an `app` param was already added).
- The TTL/cache-dir env overrides conflict with the existing `ENV_LOCK`
  pattern in a way that makes tests flaky after one reasonable fix attempt.
- The frontend invoke breaks (TS error) — the command's `app` parameter is
  injected by Tauri and must NOT appear in the JS invoke payload; if it
  does, report.

## Maintenance notes

- When plan 011 (Semantic Scholar as a second source) lands, this cache
  becomes its count source too — the TTL and file format are shared, so
  review both together.
- Reviewer focus: the cache must never make the failure-proof contract
  worse — a corrupt or expired cache degrades to today's behavior
  (network or empty map), never to an error.
- TTL choice: 7 days matches arXiv paper churn; revisit if the app adds
  "citation trend" UI, which would need a longer history than one number.
