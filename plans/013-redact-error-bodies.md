# Plan 013: Redact bearer-token-shaped strings from provider error bodies

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
- **Category**: security (defensive)
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Non-2xx provider responses are embedded (up to 300 chars) into the error
string that renders in the explanation panel and the Settings test result.
Some API gateways echo the submitted key in 401/400 bodies (e.g.
`{"error": "invalid key sk-abc123..."}`). The key then sits in the UI and
can be copied or screen-captured. On the user's own machine this is
low-severity, but for a privacy-first app it's an unnecessary echo path —
and the error text is also the seed for the fragile contract plan 005
removes.

## Current state

- `src-tauri/src/ai.rs:106-113`:

```rust
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "Provider returned HTTP {status}: {}",
            truncate(&text, 300)
        ));
    }
```

- `src/lib/ai.ts:104-107` (browser path, stream) and `:152-155`
  (browser path, test): `throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)`.
- API keys: user-supplied `sk-...`-style strings stored in the OS keychain;
  no known key format is enforced (any string allowed), so redaction must
  target *token-like substrings* rather than a specific prefix.

## Commands you will need

| Purpose   | Command                            | Expected on success |
|-----------|------------------------------------|---------------------|
| Rust test | `cd src-tauri && cargo test --lib` | all pass            |
| Rust check| `cd src-tauri && cargo check`      | Finished, no warnings |
| TS test   | `pnpm test`                        | all pass            |
| Typecheck | `pnpm exec tsc --noEmit`           | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src-tauri/src/ai.rs`
- `src/lib/ai.ts`
- Tests for both (in-file Rust tests; `src/lib/__tests__/` for TS)

**Out of scope** (do NOT touch):
- The keychain store; the settings UI; any other error path.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Redaction helper in Rust

In `src-tauri/src/ai.rs`:

- Add a pure function:

```rust
/// Masks token-like substrings (e.g. API keys) inside provider error text.
fn redact_tokens(text: &str) -> String {
    // Matches common key shapes: sk-..., key-..., ghp_..., xai-..., long base64-ish runs
    let token_patterns = [
        "sk-", "sk_", "key-", "key_", "ghp_", "xai-", "Bearer ", "bearer ",
    ];
    let mut out = text.to_string();
    for pat in token_patterns {
        while let Some(pos) = out.find(pat) {
            let rest = &out[pos + pat.len()..];
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '}' || c == ',' || c == ')')
                .unwrap_or(rest.len());
            let token = &rest[..end];
            if token.len() >= 6 {
                out.replace_range(pos..pos + pat.len() + end, &format!("{pat}***"));
            } else {
                break; // not a real token; avoid mangling words like "sk-8"
            }
        }
    }
    out
}
```

  (Adjust the pattern list to what's reasonable; the goal is masking
  `sk-<run>`, not language policing. Keep it dependency-free.)
- Apply it in the error path: `truncate(&redact_tokens(&text), 300)`.
- Add unit tests: a body containing `sk-abcdef123456` → the output contains
  `sk-***` and does NOT contain `abcdef123456`; a body without tokens →
  unchanged.

**Verify**: `cd src-tauri && cargo test --lib` → all pass (existing
`surfaces_provider_errors` test asserts the error contains "401" — still
true).

### Step 2: Mirror in the browser path

In `src/lib/ai.ts`:

- Add a `redactTokens(text: string): string` with the same pattern list and
  semantics (keep it small; a regex like
  `/(sk-|sk_|key-|key_|ghp_|xai-|Bearer\s)[A-Za-z0-9_\-]{6,}/g` →
  `"$1***"` is acceptable if it matches the Rust behavior for the same
  inputs; document that the two must stay in sync).
- Apply in both browser error throws (`:106` and `:154`).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: TS tests

- Add to `src/lib/__tests__/ai-parser.test.ts` (plan 004's suite) or a new
  `ai-redact.test.ts`:
  - `redacts token-shaped substrings`: input with `sk-abc123def456` →
    output contains `sk-***`, not the raw token.
  - `leaves normal error text untouched`.
- If `redactTokens` is not exported, export it (it's a pure util; fine).

**Verify**: `pnpm test` → all pass.

## Test plan

- Rust: 2 unit tests for `redact_tokens` (in-file).
- TS: 2 tests for `redactTokens` (in `src/lib/__tests__/`).
- Verification: `cargo test --lib` + `pnpm test` both green.

## Done criteria

- [ ] `cd src-tauri && cargo test --lib` — all pass
- [ ] `pnpm test` — all pass
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] Both error paths apply redaction before surfacing (code + tests)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The redaction regex/pattern mangles legitimate non-secret text in tests
  in a way that breaks a real error message (e.g. `"sk-8"` short tokens) —
  prefer the length guard over broadening patterns.
- Plan 004's parser suite doesn't exist yet — the TS tests can live in a
  standalone new file instead; note it in the status row.

## Maintenance notes

- Key formats evolve (providers add prefixes) — the pattern list is the
  extension point; keep Rust and TS lists identical.
- If the app later enforces key formats on input (plan 012-adjacent), the
  redaction can target the exact format instead of heuristics.
