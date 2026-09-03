# Spike: Provider failover chain (plan 027, DIR-3)

> Note (2026-09-03): the backend has since been split into module dirs
> (`ai.rs` → `src-tauri/src/ai/`, `papers.rs` → `src-tauri/src/papers/`).
> File and line references below are against the pre-split tree.

> Design spike output — feeds a future build plan. When the maintainer picks
> it up, this document is the spec. See `plans/027-provider-failover-spike.md`
> for the spike brief. No app code was changed by this spike.

## 0. Drift check (plan vs. live tree)

| Plan claim                                                                      | Live tree (verified 2026-08-02)                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Repo has no git commits yet"                                                   | Stale — 15 commits exist (baseline + plans 001–022). Commit workflow per operator instruction.                                                         |
| `paper-card.tsx:44-52` `handleExplain` picks `activeProviderId ?? providers[0]` | Accurate — `src/features/papers/paper-card.tsx:42-52`.                                                                                                 |
| Plan 005 marker landed                                                          | Yes — `CANCELLED_MARKER` in `src-tauri/src/ai.rs:22`, mirrored/exported in `src/lib/ai.ts:7`; 3 marker sites in `stream_chat` (`ai.rs:203, 212, 228`). |
| Plan 007 capability trim landed                                                 | Yes — no `keyring:default` in `src-tauri/capabilities/default.json`; keys are fetched Rust-side via `tauri_plugin_keyring` (`ai.rs:113-126`).          |
| `stream_chat` errors are `Err(String)` (`ai.rs:104-113`)                        | Accurate but line-shifted — `stream_chat` is `ai.rs:130-239`; `load_key` is `ai.rs:113-126`.                                                           |
| `explanation.providerId` already stored                                         | Yes — `src/stores/explanation.ts:11`, set at `start` (`:41`).                                                                                          |
| "Multiple AI providers with fallback" is a stated nice-to-have                  | Yes — `docs/research/REF2.md:34` (archived, line 30 in the plan brief).                                                                                |

**Stop-condition check**: AGENTS.md's "Don't force users to use a specific AI
provider" is compatible with failover (the user's active provider is always
tried _first_; fallback only engages when it fails). No conflict found, so no
stop was triggered. Plans 005 and 007 have landed; this design builds on their
actual shapes (marker contract, Rust-side keys).

## 1. Recommendation

**Implement failover in Rust: change `explain_paper` to accept an ordered
`Vec<ProviderConfig>` and iterate internally, retrying only failures that
occurred before the first content chunk was delivered. The frontend keeps its
single-`start` status machine unchanged and learns the winning provider from
the command's return value.**

Rationale, in four sentences: keys live in the Rust keychain layer (`load_key`,
`ai.rs:113`), so only Rust can cheaply skip providers that have no key without
extra IPC round-trips or check-then-use races. The "retry only if zero chunks
were delivered" condition is exact in Rust (a wrapper around the `on_chunk`
closure tracks delivery), whereas a frontend retry loop would have to classify
plain `Err(String)` messages by string matching — brittle, and philosophically
opposed to plan 005's typed-marker contract. The store's per-paper status
machine (`explanation.ts`) keeps working untouched: one `start()` → one invoke
→ one resolve/reject, with the existing generation counter and marker
classification handling Stop correctly across the whole chain. Ordering and
the "explained by" surface stay frontend-owned: the store builds the chain as
`[active, ...rest in config order]`, and the UI shows a note only when the
winning provider differs from the one the user picked.

### Why not the alternatives

- **Frontend-only retry** (store loops over providers, calling
  `streamExplanation` per attempt): the store cannot know which providers have
  keys without N `has_api_key` invokes (TOCTOU race included), cannot tell a
  401 from a network error without parsing Rust error strings, and would need
  to re-implement the cancel-across-attempts semantics the Rust loop gets for
  free from the global `CANCEL_EXPLAIN` flag. Rejected.
- **Hybrid** (Rust returns a structured per-provider error; store picks next
  provider): workable, but it splits one state machine across two layers and
  forces a structured-error IPC redesign now. Keep as the fallback option if
  the maintainer later wants per-attempt UI progress (see Open questions).

## 2. Proposed API / signature changes (sketches only)

### Rust — `src-tauri/src/ai.rs`

The command takes an ordered provider list and returns the winner's id on
success. `Err(String)` is unchanged (keeps the plan-005 marker contract).

```rust
/// New return shape: Ok(winner provider id) on success; Err(String) otherwise.
#[tauri::command]
pub async fn explain_paper(
    app: tauri::AppHandle,
    providers: Vec<ProviderConfig>, // ordered chain: [active, ...fallbacks] (deduped)
    paper: Paper,
    language: String,
    on_chunk: Channel<String>,
) -> Result<String, String> {
    CANCEL_EXPLAIN.store(false, Ordering::SeqCst); // reset stays at entry (ai.rs:274)
    explain_with_failover(&app, &providers, &paper, &language, &mut |c| {
        let _ = on_chunk.send(c.to_string());
    })
    .await
}

/// Internal chain: try each provider; retry ONLY pre-first-chunk failures.
async fn explain_with_failover(
    app: &tauri::AppHandle,
    providers: &[ProviderConfig],
    paper: &Paper,
    language: &str,
    on_chunk: &mut (dyn FnMut(&str) + Send),
) -> Result<String, String> {
    let mut failures: Vec<String> = Vec::new();
    for provider in providers {
        // A Stop pressed between attempts must abort the whole chain.
        if CANCEL_EXPLAIN.load(Ordering::SeqCst) {
            return Err(CANCELLED_MARKER.into());
        }
        validate_provider(provider)?;                        // defense in depth
        let key = match load_key(app, provider) {
            Ok(k) => k,
            Err(e) => { failures.push(format!("{}: {e}", provider.name)); continue; }
        };
        let url = match build_chat_url(&provider.base_url) {
            Ok(u) => u,
            Err(e) => { failures.push(format!("{}: {e}", provider.name)); continue; }
        };
        let body = json!({
            "model": provider.model,
            "messages": build_messages(paper, language),
            "stream": true,
            "temperature": 0.4,
        });
        let mut delivered = false;                            // ← the discriminator
        let result = stream_chat(
            &shared_client(), &url, &key, body, EXPLAIN_TIMEOUT,
            &mut |c| { delivered = true; on_chunk(c); },
        ).await;
        match result {
            Ok(_) => return Ok(provider.id.clone()),
            // Plan-005 contract: the marker is terminal — never retried, never
            // folded into the aggregate. It must propagate verbatim.
            Err(e) if e.starts_with(CANCELLED_MARKER) => return Err(e),
            // Partial text is already on screen — retrying would duplicate it.
            Err(e) if delivered => return Err(e),
            Err(e) => failures.push(format!("{}: {e}", provider.name)),
        }
    }
    Err(format!(
        "All {} providers failed: {}",
        providers.len(),
        truncate(&failures.join(" | "), 500)
    ))
}
```

`stream_chat` itself is unchanged. `test_provider` is unchanged (Settings Test
stays single-provider — that is its job). `stop_explaining` is unchanged (one
global flag still aborts whatever attempt is in flight, and the loop's
between-attempt check aborts the rest of the chain).

### Frontend — `src/lib/ai.ts` + `src/stores/explanation.ts`

```ts
// src/lib/ai.ts — signature change only; Tauri path becomes:
export async function streamExplanation(opts: ExplainOptions): Promise<string> {
  // ExplainOptions.providers: ProviderConfig[] (ordered chain) instead of provider
  // invoke("explain_paper", { providers, paper, language, onChunk: channel })
  //   → resolves with the WINNING provider id; rejects with Err(String)
}

// src/stores/explanation.ts — start() builds the chain, then records the winner:
start: async (paper, provider, language) => {
  // ... existing loading/generation setup (lines 33-43) unchanged ...
  const chain = [
    provider,
    ...useSettingsStore.getState().providers.filter((p) => p.id !== provider.id),
  ];
  try {
    const winnerId = await streamExplanation({ providers: chain, paper, language, onChunk });
    set((s) => ({
      byPaper: {
        ...s.byPaper,
        [id]: { ...s.byPaper[id], status: "done", providerId: winnerId },
      },
    }));
  } catch (err) {
    // ... existing marker classification (lines 75-87) unchanged ...
  }
},
```

`paper-card.tsx` needs **no change** (still resolves `activeProviderId ??
providers[0]` and calls `start` — the chain is built in the store, which owns
the full provider list via `useSettingsStore`). The browser-preview path
(`streamExplanationBrowser`) should mirror the chain loop (~15 lines) or be
documented as degraded in dev only (Open question 4).

## 3. UX spec

| Moment               | What the user sees                                                                                              | Notes                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Chain running        | Existing `explain.explaining` ("Explaining…") spinner                                                           | One continuous run; no per-attempt progress in v1 (Rust-internal). Worst case N × 120 s (per-attempt timeout); Stop always works. |
| Failover succeeded   | Inline note under the panel header: **"Explained by {{provider}}"**                                             | Shown only when the winning provider ≠ the provider the user picked. The Select keeps showing the user's active choice.           |
| All providers failed | Existing error box (`explain.error` header + raw message)                                                       | Message is the Rust aggregate: `All 3 providers failed: OpenAI: HTTP 401 …                                                        | DeepSeek: Network error …` (truncated 500 chars). English, consistent with today's Rust error strings (see Open question 3). |
| Stop during chain    | Existing `explain.stopped` ("Stopped.")                                                                         | Marker propagates; partial text from the aborted attempt stays.                                                                   |
| No providers         | Existing guards: Explain button disabled (`paper-card.tsx:89-90`), `explain.noProvider` panel (already shipped) | Rust defense-in-depth: empty `Vec` → `Err("No providers configured")`.                                                            |

**i18n keys to add** (both `en.json` and `ar.json`; names only — no feature):

```jsonc
// en.json → "explain"
"byProvider": "Explained by {{provider}}",
// optional, v1:
"fallbackLoading": "Falling back to another provider…"
```

```jsonc
// ar.json → "explain"
"byProvider": "الشرح بواسطة {{provider}}",
// optional, v1:
"fallbackLoading": "جارٍ التحويل إلى مزوّد آخر…"
```

No new keys are needed for the aggregate error (Rust-side string, same pattern
as today's raw errors) or for Stop (marker → `explain.stopped` already).

Settings UI: no changes. Chain order = configuration order (`addProvider`
appends, `settings.ts:71-76`); the active provider is always first.

## 4. Edge cases

1. **All providers fail** — aggregate `Err` (sketch above). Each provider is
   tried exactly once (deduped chain); failures are recorded per provider so
   the user sees _which_ provider said what. The store maps it to `status:
"error"` and the panel shows the error box. No infinite loops possible (the
   chain is a finite pre-built list).
2. **No providers** — frontend guards already exist (button disabled,
   `paper-card.tsx:89-90`; `explain.noProvider` in the panel). Rust side gets
   an empty `Vec` only via a stale/corrupt frontend; the empty-list `Err` is
   defense in depth. Also: providers deleted from Settings mid-session cannot
   break the chain — `load_key`/`build_chat_url` failures are per-attempt
   `continue`s, and the store builds the chain from live `providers` at
   `start()` time.
3. **Local-only Ollama without a key** — `load_key` already returns `Ok("")`
   for local base URLs (`ai.rs:119-121`) and `stream_chat` skips the bearer
   header for empty keys (`ai.rs:139-141`). Ollama participates in the chain
   like any provider. Mixed local+remote chains work; a remote provider with
   no key fails fast at `load_key` and the chain moves on (recorded in the
   aggregate).
4. **Cancel during failover** — `stop_explaining` sets the single global flag
   (`ai.rs:318-320`). Three abort points: the existing in-stream checks
   (`ai.rs:203, 212, 228`) kill the current attempt with the marker; the new
   between-attempt check kills the chain if Stop lands in the gap. The loop
   treats the marker as terminal (never retried, never aggregated). The store
   is untouched: generation bump (`explanation.ts:90-113`) drops in-flight
   chunks, marker rejection maps to `"stopped"` with `error: null`
   (`explanation.ts:75-87`). The next `start()` resets the flag (entry line
   kept).
5. **Plan-005 marker contract** — preserved exactly: the marker carries
   its fixed prefix and is collision-proof, and the chain returns it _verbatim_
   (`e.starts_with(CANCELLED_MARKER)` short-circuit, same prefix semantics as
   `explanation.ts:77`). Provider error strings can never be mislabeled as
   stops (they cannot start with the marker), and the marker can never be
   swallowed into the aggregate or retried.
6. **Mid-stream failure after chunks** — NOT retried. `delivered == true` →
   the error propagates as today; the partial text stays on screen under the
   error box. This is the deliberate contract: retrying would duplicate or
   interleave partial text in the panel.
7. **Non-streaming fallback responses** — `stream_chat`'s JSON branch
   (`ai.rs:216-236`) delivers the whole answer as one chunk, so
   `delivered == true` before any error could occur there; behavior is
   consistent.

### The "retry only pre-first-chunk" assumption (Step-3 verification)

The plan's brief suggested `full.is_empty()` at error time is the
discriminator. **Correction found in the code**: `full.is_empty()` is checked
only in the EOF-without-`[DONE]` branch (`ai.rs:175-178`). The mid-read
`Stream error: {e}` branch (`ai.rs:172`) can fire _after_ chunks were already
delivered. So the reliable, string-independent signal is a
`delivered: bool` flag flipped by the `on_chunk` wrapper in the caller — which
is exactly what the sketch above uses. The existing unit test
`surfaces_provider_errors` (`ai.rs:591-606`) already proves HTTP failures
return as clean `Err(String)` (no panic, no partial state), so a retry loop
around `stream_chat` is trivially feasible: `stream_chat` keeps no state
between calls (all locals; only the intentional globals `CANCEL_EXPLAIN` and
`shared_client`).

**Scratch experiment**: skipped deliberately. The spike brief marks it
optional, and this spike ran under a constraint that `src-tauri/` is owned by
a concurrent executor — a temporary `#[test]` in `ai.rs` risked colliding with
their working tree. The static evidence above (existing error-propagation
test + stateless `stream_chat`) is conclusive; no experiment was needed. One
concrete finding for the future build plan: the existing test helper
`spawn_mock_server` (`ai.rs:425-488`) answers **one** connection — the
implementation's "500 then 200" test needs a multi-request variant (loop
`accept()` N times, or a canned response queue).

## 5. Open questions (for the maintainer)

1. **Cross-run memory of "last provider that worked"?** _Recommendation: none
   in v1._ Every run starts at the active provider (the user's explicit
   choice — AGENTS.md "don't force providers"); per-paper `providerId` already
   records the winner and Regenerate naturally re-uses it (current
   `explain-panel.tsx:67` behavior). Global or per-paper memory would silently
   override the user's active choice.
2. **Are auth failures (401/403) retryable?** _Recommendation: yes_ — a
   failed key on the active provider is exactly the "out of credits / bad key"
   case the chain exists for; the next provider may be valid. Cost: one extra
   round-trip. Only the marker and post-first-chunk errors are terminal.
3. **Aggregate error language (bilingual)?** _Recommendation: defer._ Today
   all Rust errors are English strings; an i18n-able aggregate needs
   structured error codes (`ExplainError { code, attempts }`) — a breaking
   IPC change that also touches the marker contract's transport. Keep the
   English aggregate consistent with today, revisit with a structured-error
   plan.
4. **Browser-preview (non-Tauri) parity?** _Recommendation: implement the
   same loop in `streamExplanationBrowser` in the same commit_ (~15 lines,
   local `delivered` flag, same chain input). If cut for scope, the dev
   preview silently lacks failover — acceptable but should be noted in the
   panel in dev builds only.
5. **Rate-limit backoff on 429?** _Recommendation: none in v1._ Fail over to
   the next provider immediately; a 429 usually returns fast, and the 120 s
   per-attempt timeout bounds the worst case. Add backoff only if real-world
   usage shows chained 429s burning attempts.

## 6. Effort estimate & test coverage

**Effort: S–M.** Core (Rust chain + signature, store update, "Explained by"
note, ~4 new Rust tests + 2 store tests): **S** (~half a day). Grows to **M**
if Open-question 3's structured errors or browser-parity (Q4) are included.

**Existing tests that cover it** (per plan 027, the doc _is_ the test plan):

- Rust (`src-tauri/src/ai.rs`, `#[cfg(test)]`):
  - `surfaces_provider_errors` (`:591`) — the per-attempt HTTP-failure path.
  - `cancel_returns_marker` (`:707`) — the chain-abort semantics (extend: also
    assert a Stop between attempts returns the marker).
  - `streams_sse_chunks_in_order` (`:491`), `clean_close_without_done_returns_content`
    (`:679`), `handles_non_streaming_json` (`:565`) — the delivered-content
    boundary (post-first-chunk success must NOT be retried).
  - `detects_local_base_urls` (`:763`) — Ollama no-key participation.
- Frontend (Vitest): `src/stores/__tests__/explanation.test.ts` — extend the
  mocked `streamExplanation` to reject-then-resolve and assert (a) the chain
  order passed to `streamExplanation`, (b) `providerId` updated to the winner,
  (c) no retry once `onChunk` fired, (d) marker → `"stopped"` unchanged.
  `src/stores/__tests__/settings.test.ts` — unchanged (ordering/active
  selection semantics untouched).
- **New tests needed**: multi-request mock server (see finding above) for
  "500 then 200 → success with winner id", all-fail aggregate string, and
  between-attempt cancel.

## 7. Interaction notes

- Plan 025 (search): no coupling — both touch the shared store patterns only.
- Plan 016 (AI-layer dedup): the chain loop is a natural consumer of a
  deduped `stream_chat` contract; coordinate if 016 lands first.
- Plan 011 (browser Stop via AbortController): independent — browser failover
  (Q4) uses the same abort signal per attempt.
