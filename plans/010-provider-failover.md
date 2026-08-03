# Plan 010: Provider failover chain (build from the spike spec)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src-tauri/src/ai.rs src/lib/ai.ts src/stores/explanation.ts src/stores/settings.ts src/features/papers`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (coordinate with plan 003 only if both land in the
  same window — see Maintenance notes)
- **Category**: direction (build from `docs/spikes/provider-failover.md`)
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

The design is fully specified in `docs/spikes/provider-failover.md`
(verified against the live tree 2026-08-02, section §0). When a user's
active provider fails (bad key, out of credits, network), the app today
shows an error and stops. Failover tries the user's other configured
providers automatically — "don't force users to use a specific AI
provider" (AGENTS.md) becomes "always try the one they picked, fall back
only when it fails". The spike's §1-§6 cover the API sketch, UX, edge
cases, and the test plan; this plan executes it. Read the spike FIRST —
it is the spec; this plan is the execution checklist that adds the
missing multi-request mock server the spike itself identified (§4
finding: `spawn_mock_server` answers ONE connection).

## Current state

- `src-tauri/src/ai.rs` — `explain_paper` (single `ProviderConfig`),
  `stream_chat` (stateless, takes `cancel_flag`), `CANCEL_EXPLAIN` global,
  `load_key` (Rust-side keychain), `validate_provider`, `build_chat_url`,
  `CANCELLED_MARKER` (typed cancellation contract).
- `src/stores/explanation.ts` — `start(paper, provider, language)` builds
  one invoke; `providerId` stored per paper; generation counters handle
  stop/restart.
- `src/features/papers/paper-card.tsx:42-52` — `handleExplain` picks
  `activeProviderId ?? providers[0]` and calls `start`.
- `src/lib/ai.ts` — `streamExplanation(opts)` (Tauri invoke) and
  `streamExplanationBrowser` (dev preview).
- `src/i18n/locales/en.json` / `ar.json` — `explain.*` key family.
- The spike's target signature (from `docs/spikes/provider-failover.md`
  §2): `explain_paper(providers: Vec<ProviderConfig>, paper, language,
on_chunk) -> Result<String /*winner id*/, String>`; internal
  `explain_with_failover` loop with a `delivered: bool` discriminator;
  marker propagated verbatim; aggregate error `All N providers failed: ...`
  (truncated 500 chars).

## Commands you will need

| Purpose    | Command                                                            | Expected on success |
| ---------- | ------------------------------------------------------------------ | ------------------- |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --lib`            | all pass            |
| Rust lint  | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | clean               |
| Rust fmt   | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`        | clean               |
| Tests      | `pnpm exec vitest run`                                             | all pass            |
| Typecheck  | `pnpm exec tsc --noEmit`                                           | exit 0              |
| Lint       | `pnpm exec eslint .`                                               | exit 0              |

## Scope

**In scope**:

- `src-tauri/src/ai.rs` (signature change + `explain_with_failover` + tests)
- `src/lib/ai.ts` (options shape: `providers` chain; browser loop parity)
- `src/stores/explanation.ts` (chain building + winner recording)
- `src/i18n/locales/en.json` + `ar.json` (`explain.byProvider`)
- `src/features/papers/explain-panel.tsx` (the "Explained by {{provider}}"
  note when winner ≠ picked)
- `plans/README.md` (status row)

**Out of scope**:

- `test_provider` (Settings Test stays single-provider — the spike says so).
- Structured error codes (spike open question 3 — deferred by design).
- Cross-run "last provider that worked" memory (spike open question 1 —
  rejected by design).
- 429 backoff (spike open question 5 — deferred by design).

## Git workflow

- Branch: `advisor/010-provider-failover`
- Commit style: `feat: fail over to the next AI provider when the active one fails`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Read the spike and port the Rust core

Read `docs/spikes/provider-failover.md` §2 (the `explain_with_failover`
sketch is the target shape). Implement in `src-tauri/src/ai.rs`:

- `explain_paper(providers: Vec<ProviderConfig>, paper, language,
on_chunk: Channel<String>) -> Result<String, String>` returning the
  WINNING provider id.
- The loop: for each provider — check `CANCEL_EXPLAIN` between attempts,
  `validate_provider`, `load_key`, `build_chat_url`, then
  `stream_chat(..., &mut |c| { delivered = true; on_chunk(c); })`.
  `Ok` → return the provider id; `Err` starting with `CANCELLED_MARKER` →
  propagate verbatim; `Err` with `delivered == true` → propagate (partial
  text is on screen); otherwise record and continue.
- Empty providers → `Err("No providers configured")`.
- Aggregate: `All {n} providers failed: {truncated 500-char joined list}`.
- Keep `#[allow(clippy::too_many_arguments)]` if the arg count crosses 7
  (the existing pattern on `ask_about_paper`).

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` compiles and existing tests pass.

### Step 2: Multi-request mock server + Rust tests

The existing `spawn_mock_server` (`ai.rs`, test module) answers ONE
connection. Add a `spawn_scripted_server(responses: Vec<u16 /*statuses*/>)`
helper that loops `accept()` over a canned status queue (or a
"500 then 200" mode). New tests:

1. `failover_tries_next_provider_after_http_error` — statuses [500, 200];
   assert `Ok(winner_id)` is the SECOND provider's id and both providers
   were contacted (the server records request order).
2. `failover_returns_winner_on_first_success` — [200]; winner is the
   active provider; no second request (one connection accepted).
3. `failover_aggregates_when_all_fail` — [500, 500]; `Err` contains
   "All 2 providers failed" and each provider name.
4. `failover_propagates_marker_verbatim` — first provider's body triggers
   the cancel flag mid-stream (reuse the existing cancel test pattern);
   assert the returned `Err` starts with `CANCELLED_MARKER` and the second
   provider is NEVER contacted.
5. `failover_does_not_retry_after_first_chunk` — a stream that delivers
   chunks then errors; assert the error propagates and no second provider
   is contacted.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass (45 + 5 new).

### Step 3: Frontend — store and lib

- `src/lib/ai.ts`: `ExplainOptions` gains `providers: ProviderConfig[]`
  (keep `provider` for the browser mock path or migrate both — read the
  file and choose the shape that keeps `streamExplanationBrowser`
  mirroring the chain with a local `delivered` flag, per spike open
  question 4: implement parity, do not degrade).
- `src/stores/explanation.ts` `start()`: build the chain
  `[provider, ...providers.filter(p => p.id !== provider.id)]` from
  `useSettingsStore.getState().providers`; record the resolved winner id
  into `providerId`.
- `src/features/papers/explain-panel.tsx`: when `providerId !== picked
provider id`, show `t("explain.byProvider", { provider: <winner name> })`
  under the panel header. The winner id must be resolved to a name from
  the settings store (missing name → hide the note).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 4: Store tests + i18n

- Extend `src/stores/__tests__/explanation.test.ts`: mock
  `streamExplanation` to reject-then-resolve; assert (a) the chain order
  passed, (b) `providerId` updated to the winner, (c) no retry once
  `onChunk` fired, (d) marker → `"stopped"` unchanged.
- Add `explain.byProvider` to `en.json` ("Explained by {{provider}}") and
  `ar.json` ("الشرح بواسطة {{provider}}") under the `explain` key.

**Verify**: `pnpm exec vitest run` → all pass (94 + new store tests).

### Step 5: Gates + manual smoke

**Verify**:

1. `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` and `cargo fmt -- --check` clean
2. `pnpm exec eslint .` and `pnpm exec prettier --check .` clean
3. Manual (dev preview with two mock providers whose base URLs point at
   `dev/mock-ai-server.mjs` — one wrong port, one correct): Explain fails
   over and the note appears; Stop during the chain aborts both attempts
   (the marker path).

## Test plan

- Rust: the 5 failover tests (Step 2).
- Frontend: the extended explanation store tests (Step 4).
- The spike's §6 lists the existing tests that must stay green — run the
  full suites.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `explain_paper` returns the winner provider id; `grep -n "explain_with_failover" src-tauri/src/ai.rs` → match
- [ ] 5 new Rust failover tests pass
- [ ] Explanation store chain + winner tests pass
- [ ] `explain.byProvider` exists in both locale files
- [ ] `cargo test`, `cargo clippy`, `cargo fmt --check`, `pnpm exec vitest run`, `pnpm exec tsc --noEmit`, `pnpm exec eslint .` all clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `ai.rs` no longer matches the spike's §0 drift table (the spike was
  verified 2026-08-02 against a tree that predates commit `692c0d0` by a
  day — re-verify `load_key`/`stream_chat`/`CANCEL_EXPLAIN` shapes).
- The `delivered` discriminator cannot be expressed with the current
  `stream_chat` closure signature (report the signature; do not change
  `stream_chat`'s public contract without checking the spike's
  "stream_chat itself is unchanged" line).
- A store test requires changing the marker contract — the marker is
  load-bearing (plan 005 history); report instead.

## Maintenance notes

- The spike's §7 interaction notes: plan 016 (AI-layer dedup) and plan 011
  (browser abort) are historical — the dedup and abort already landed in
  earlier rounds; if this plan's browser-loop parity conflicts with the
  shipped `streamChatBrowser` abort logic, prefer the shipped abort
  behavior.
- When the Ask tab and walkthrough get failover too (they use
  `streamSectionExplanation` / `streamAsk`), the same chain pattern
  extends — the spike scoped v1 to `explain_paper` only; note the gap in
  the commit message.
- Reviewer focus: the marker contract (never retried, never aggregated)
  and the `delivered` boundary (partial text never duplicated) are the
  two behaviors that must survive review.
