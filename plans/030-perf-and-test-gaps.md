# Plan 030: Skip redundant S2 citation batch and fix test gaps

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check**: `git diff --stat 7e26e2d..HEAD -- src/stores/papers.ts src-tauri/src/citations.rs src/lib/ai.ts src-tauri/src/pdf.rs`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf + tests
- **Planned at**: commit `7e26e2d`, 2026-08-04

## Why this matters

Every Semantic Scholar search triggers a citation batch lookup that
includes S2 paper ids (`s2:abc123`) — but the S2 batch endpoint only
resolves `ARXIV:` ids, so these calls return nothing and waste API
quota. The search payload already carries `citationCount`. Separately,
the browser failover loop and the SSRF redirect re-pinning path have
zero test coverage, leaving the app's most security-critical and
dev-facing paths unguarded.

## Current state

- **`src/stores/papers.ts:166-182`** — `loadCitations` seeds the
  citations map from `papers.filter(p => p.citationCount != null)`
  (171-176), then unconditionally calls `fetchCitations(ids)` (177) for
  ALL papers, including those already seeded.
- **`src-tauri/src/citations.rs:196-200`** — `fetch_citations_impl`
  builds `ARXIV:{id}` for every `missing` id, including `s2:` ids that
  S2 cannot resolve.
- **`src/lib/ai.ts:209-239`** — `streamExplanationBrowser` has the
  `delivered` flag and failover loop, but no tests exercise it (unlike
  the Rust side at `ai.rs:1031-1121`).
- **`src-tauri/src/pdf.rs:182-202`** — `download_pdf_guarded` (the real
  SSRF path with redirect re-pinning) is never tested because mock
  servers are plain HTTP.

## Commands you will need

| Purpose   | Command                           | Expected on success |
| --------- | --------------------------------- | ------------------- |
| Frontend  | `pnpm test`                       | all pass            |
| Rust      | `cargo test --lib` (in src-tauri) | all pass            |
| Typecheck | `pnpm run typecheck`              | exit 0              |

## Scope

**In scope**:

- `src/stores/papers.ts`
- `src-tauri/src/citations.rs`
- `src/lib/__tests__/ai-failover.test.ts` (create)
- `src-tauri/src/pdf.rs` (test-only additions to the test module)

**Out of scope**:

- `src/lib/ai.ts` (logic unchanged — just adding tests that exercise it)
- `src-tauri/src/ai.rs`

## Git workflow

- Branch: `advisor/030-perf-and-test-gaps`
- Conventional commits: `perf(citations): ...`, `test: ...`

## Steps

### Step 1: Skip fetchCitations for already-seeded ids

In `src/stores/papers.ts:177`, filter out ids that are already in the
`citations` map before calling `fetchCitations`:

```typescript
const known = new Set(Object.keys(get().citations));
const needed = ids.filter((id) => !known.has(id));
if (needed.length === 0) return;
void fetchCitations(needed).then((counts) => { ... });
```

**Verify**: `pnpm run typecheck` → exit 0, `pnpm test` → all pass

### Step 2: Skip non-arXiv ids in fetch_citations_impl

In `src-tauri/src/citations.rs`, in the section that builds the S2 batch
request (around line 196-200), filter `missing` to ids that look like
arXiv ids (contain a dot, no `s2:` prefix):

```rust
let arxiv_ids: Vec<&String> = missing.iter()
    .filter(|id| !id.starts_with("s2:") && id.contains('.'))
    .collect();
```

Only send `arxiv_ids` to the batch endpoint. S2 papers that already have
counts from the search payload don't need a batch lookup.

**Verify**: `cargo test --lib` → all pass

### Step 3: Add browser failover test

Create `src/lib/__tests__/ai-failover.test.ts`. Mock `fetch` with a
sequence: first provider streams one chunk then aborts, second provider
is ready. Assert the first provider's id is returned and the second is
never called (because `delivered` is true after the first chunk). Mirror
the Rust `failover_does_not_retry_after_first_chunk` test.

**Verify**: `pnpm test` → all pass

### Step 4: Add SSRF redirect re-pinning unit test

In `src-tauri/src/pdf.rs` test module, add a test that factors the
redirect hop decision into a pure function and tests the decision
sequence: hop 1 is a public https host, hop 2's `Location` points to a
private IP — the function must reject hop 2. If `download_pdf_guarded`
can't be called directly (needs an AppHandle), factor the hop logic
into a testable pure function `should_follow_redirect(location: &str,
pinned_host: &str) -> Result<String, String>` and test it.

**Verify**: `cargo test --lib` → all pass

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0; new failover test exists and passes
- [ ] `cargo test --lib` exits 0; new SSRF test exists and passes
- [ ] `pnpm run lint` exits 0
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- Factoring `should_follow_redirect` out of `download_pdf_guarded`
  changes the compiled behavior (test the extracted function in
  isolation, don't change the call site).
- The browser failover test's `fetch` mock doesn't produce the expected
  `delivered` flag behavior (report the mock setup that fails).

## Maintenance notes

- The `should_follow_redirect` helper should be used by
  `download_pdf_guarded` after extraction — keep them in sync.
- The citation-skip logic must handle the case where `citations` is
  cleared (e.g. after `clear_app_cache`) — the full batch lookup
  should still run for the first load after a clear.
