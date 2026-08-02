# Plan 027: Design spike — provider failover chain (DIR-3)

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. Your
> deliverable is a written design (a new markdown file, see Step 2), plus
> minimal throwaway experiments if needed to validate the approach. Do not
> implement the feature in the app.
>
> **Drift check (run first)**: the repo has **no git commits yet**. Compare
> the "Current state" excerpts against the live files; on any mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3 (direction — stated nice-to-have, REF2.md:30 "Multiple
  AI providers with fallback")
- **Effort**: S-M (spike; the eventual feature is S-M)
- **Risk**: LOW-MED (design only)
- **Depends on**: plans/005 (typed cancellation — failover must preserve
  cancel semantics), 007 (keyring capability trimmed — keys stay Rust-side)
- **Category**: direction (design spike)
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

The explain feature — the app's reason to exist — is a single point of
failure: the UI picks `activeProviderId ?? providers[0]` (`paper-card.tsx:48`)
and if that provider is down, rate-limited, or out of credits, the user
must manually open Settings and switch. The app already manages N
providers with per-provider Test, and `stream_chat` already returns typed
per-provider errors (`ai.rs:104-113`). A failover loop in Rust turns
"feature broken" into "feature degraded with a message".

## Current state

- `src/features/papers/paper-card.tsx:44-52`:

```ts
  const handleExplain = () => {
    if (expanded) {
      toggle(paper.id);
      return;
    }
    toggle(paper.id);
    const provider = providers.find((p) => p.id === activeProviderId) ?? providers[0];
    if (provider) {
      void start(paper, provider, i18n.language);
    }
  };
```

- `src-tauri/src/ai.rs` — `explain_paper(provider, paper, language, on_chunk)`
  single provider; `stream_chat` returns `Err(String)` for network/HTTP/
  stream errors; `CANCEL_EXPLAIN` global flag (plan 005 adds the marker).
- `src/stores/explanation.ts` — `start(paper, provider, language)` — the
  store passes ONE provider; status/error handling per paper.
- `src/stores/settings.ts` — `providers: ProviderConfig[]`,
  `activeProviderId`.

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Rust check| `cd src-tauri && cargo check`        | Finished, no warnings |
| Typecheck | `pnpm exec tsc --noEmit`             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `docs/spikes/provider-failover.md` (create — THE DELIVERABLE)
- Optionally a throwaway scratch file under `dev/spike-*` (deleted before
  finishing; never committed into `src/` or `src-tauri/src/`)

**Out of scope** (do NOT touch):
- Any app source file. The feature itself.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it. Delete
scratch files before finishing.

## Steps

### Step 1: Investigate the three design questions

Answer these in writing, using the code as evidence:

1. **Where does failover live?** Rust (`explain_paper` iterates providers
   internally) vs frontend (store retries with the next provider) vs
   hybrid. Consider: keys must stay in Rust (plan 007); the store owns the
   per-paper status machine; `on_chunk` streaming means a mid-stream
   failure can't cleanly retry (partial text already delivered) — so
   failover applies only to *pre-first-chunk* failures. Which layer can
   express "retry only if zero chunks were delivered"?
2. **Ordering & selection**: try active first, then the rest in
   configuration order? Should the store remember "last provider that
   worked" per paper or globally? What does the UI show — "explained by
   <name>"? Does `explanation.providerId` (already stored) suffice?
3. **Cancel semantics**: plan 005's marker + generation counters — how
   does Stop interact with a provider that's mid-failover-retry (the
   cancel must abort the whole chain, not just the current attempt)?

Also check: `stream_chat`'s error types — are pre-first-chunk failures
distinguishable from mid-stream ones today (they are: `full.is_empty()`
at error time)? Note what the Rust signature would look like
(`explain_paper(providers: Vec<ProviderConfig>, ...)` vs a retry loop
inside `stream_chat`'s caller).

### Step 2: Write the design doc

Create `docs/spikes/provider-failover.md` containing:

- The recommendation with a 3-4 sentence rationale (layer, ordering, UI
  surface).
- The proposed API/signature changes (Rust command + store shape) — code
  sketches, not implementations.
- The UX spec: what the user sees on failover (toast? inline note?
  provider name in the panel), in both languages' spirit (i18n keys to
  add — name them, don't write the feature).
- Edge cases: all providers fail (final error = aggregate?); no providers;
  local-only Ollama with no key; cancel during failover; the plan-005
  marker contract.
- Open questions for the maintainer (max 5, each with a recommended
  answer).
- Effort estimate for the eventual implementation (S/M/L) and which
  existing tests would cover it.

**Verify**: the file exists and addresses all three questions + edge
cases; no app code changed (`git status` shows only the new doc).

### Step 3: Validate the riskiest assumption with a scratch experiment (optional)

If uncertain about the "retry only pre-first-chunk" distinction, write a
tiny scratch test in `dev/spike-failover.rs`-style (or a `#[test]` you
DELETE afterwards) that feeds a mock server returning 500 on the first
request and 200 on the second, and confirm `stream_chat` returns the
error cleanly so a retry loop is feasible. Then delete the scratch file.

**Verify**: scratch file deleted before finishing; `git status` clean
except `docs/spikes/`.

## Test plan

- None (spike). The design doc's "which tests would cover it" section IS
  the test plan for the future implementation.

## Done criteria

- [ ] `docs/spikes/provider-failover.md` exists with recommendation,
      signatures, UX spec, edge cases, open questions, effort estimate
- [ ] No app source files modified
- [ ] No scratch files left behind
- [ ] `cd src-tauri && cargo check` still passes (if scratch touched it)
- [ ] `plans/README.md` status row updated (spike done; feature pending
      maintainer decision)

## STOP conditions

Stop and report back (do not improvise) if:

- The investigation reveals failover conflicts with a settled decision
  (e.g. AGENTS.md's "Don't force users to use a specific AI provider" is
  compatible; a conflict would be surprising — report it).
- Plan 005/007 haven't landed and the design depends on their shapes —
  design against their specified outcomes (markers, trimmed capability)
  and note the dependency in the doc.

## Maintenance notes

- The spike's output feeds a future build plan; when the maintainer picks
  it up, this doc is the spec.
- The failover feature interacts with plan 025 (search) only through the
  shared store patterns — no coupling expected.
