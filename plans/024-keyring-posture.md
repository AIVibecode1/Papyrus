# Plan 024: De-risk the keyring dependency and correct the "official" claim

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
- **Effort**: S-M
- **Risk**: MED (keychain error types/behaviors differ; must re-test save/read/delete)
- **Depends on**: none (but do NOT run before the first commit if a key
  save/read/delete manual test is part of the operator's acceptance —
  coordinate)
- **Category**: dependencies
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

`tauri-plugin-keyring` 0.1.0 (the sole storage for user API keys) is a
community plugin — not a tauri-apps plugin — with its last release on
2024-12-23 (~19 months stale as of this plan; crates.io data retrieved
2026-08-02, https://crates.io/crates/tauri-plugin-keyring). AGENTS.md's
Tech Stack calls the storage "Tauri official secure storage / keychain
plugins", which is inaccurate. The plugin is a thin wrapper over the
`keyring` crate (the dependency posture risk is bounded), but: (a) the
security-critical path rests on a pre-1.0 community wrapper with no
releases, (b) the docs misrepresent it, and (c) a Tauri/OS-keychain
breaking change would silently turn key reads into errors (the explain
flow dies).

## Current state

- `src-tauri/Cargo.toml:28`: `tauri-plugin-keyring = "0.1.0"`.
- `src-tauri/src/ai.rs:8,72-85,283-310` — the only consumer: `KeyringExt`
  (`app.keyring().get_password/set_password/delete_password` with
  `KEYRING_SERVICE = "papyrus"` and `provider.id` as the account).
- `AGENTS.md` Tech Stack: "Secure Storage: Tauri official secure storage /
  keychain plugins".

## Commands you will need

| Purpose    | Command                            | Expected on success   |
| ---------- | ---------------------------------- | --------------------- |
| Rust test  | `cd src-tauri && cargo test --lib` | all pass              |
| Rust check | `cd src-tauri && cargo check`      | Finished, no warnings |
| Build      | `cd src-tauri && cargo build`      | exit 0                |

## Scope

**In scope** (the only files you should modify):

- `src-tauri/Cargo.toml`
- `src-tauri/src/ai.rs` (if adopting the direct `keyring` crate)
- `AGENTS.md` (correct the "official" claim)
- `README.md` (Security notes: name the storage mechanism accurately)

**Out of scope** (do NOT touch):

- Any frontend file; the keychain API surface of the commands
  (`save_api_key`/`delete_api_key`/`has_api_key` signatures stay).

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Decide the approach — vendor the thin wrapper

**Chosen default: replace the plugin with the `keyring` crate directly.**
The plugin is a ~200-line wrapper; the app uses 3 of its methods. Direct
use removes the stale-community-plugin risk with no feature loss.

1. `cargo remove tauri-plugin-keyring`
2. `cargo add keyring --features windows-native` (on Windows the
   `windows-native` feature uses Credential Manager; on macOS the default
   uses the Keychain — check the crate's current feature docs:
   https://crates.io/crates/keyring, verify the feature name at execution
   time and adjust).
3. In `ai.rs`, replace the `KeyringExt` calls:

```rust
use keyring::Entry;

fn get_key(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(service, account)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read key from the system keychain: {e}")),
    }
}
```

with parallel `set_password` / `delete_password` helpers, and update the
4 call sites (`load_key` at ai.rs:72-85, `save_api_key`, `delete_api_key`,
`has_api_key`). Keep all error strings close to today's. 4. Remove `keyring:default` from capabilities if plan 007 hasn't landed
yet — coordinate: plan 007's file becomes redundant here; both plans
end with the same final state (no keyring plugin permission).

**Verify**: `cd src-tauri && cargo check` → Finished, no warnings.
`cargo test --lib` → all pass.

### Step 2: Correct the docs

- `AGENTS.md` Tech Stack, Secure Storage line: replace "Tauri official
  secure storage / keychain plugins" with something accurate, e.g.:
  "Secure Storage: OS keychain via the `keyring` crate (Windows Credential
  Manager / macOS Keychain)".
- `README.md` Security notes first bullet: ensure it names the mechanism
  (currently says "OS keychain" — adjust only if it mentions the plugin).

**Verify**: `grep -rn "official" AGENTS.md README.md` → no matches related
to keychain storage.

### Step 3: Manual acceptance (operator)

The plan's automated gates are compile + tests; the real keychain
behavior needs a human or a Tauri-run check:

- Run the app (`pnpm exec tauri dev`), add a provider with a key, confirm
  "Key saved", Test works, delete works, and the key is gone from Windows
  Credential Manager (control panel → Credential Manager → Windows
  Credentials → `papyrus` entry).
- If the operator can't run it now, mark the plan DONE-with-caveat in the
  index and flag the manual test as required before release.

## Test plan

- Unit tests can't reach the OS keychain (they'd need a real credential
  store); the existing `load_key` tests are behavioral-only (plan 010
  extracts `is_local_base_url` — unaffected). The acceptance test is the
  manual flow in Step 3.

## Done criteria

- [ ] `tauri-plugin-keyring` absent from `Cargo.toml` and `Cargo.lock`
- [ ] `keyring` crate present; no `KeyringExt`/`tauri_plugin_keyring` references in `src/`
- [ ] `cd src-tauri && cargo check` and `cargo test --lib` pass
- [ ] `AGENTS.md` no longer claims the storage is "Tauri official"
- [ ] Manual key save/read/delete flow verified (or explicitly deferred in the index)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `keyring` crate's feature names differ from the sketch (verify at
  execution time via docs.rs and use the correct ones — that's within
  intent; report the names used).
- `Entry::new` semantics differ (service/account order, error variants)
  such that the `NoEntry` detection sketch doesn't compile — adapt to the
  crate's actual API and report the divergence.
- Plan 007 hasn't landed and removing the plugin breaks the capability
  reference (`keyring:default` would become unknown) — remove that
  permission line in the same change (that's the plan 007 outcome anyway).

## Maintenance notes

- The `keyring` crate is the de-facto standard for OS keychains in Rust —
  if it ever needs replacing (e.g. for Linux secret-service support),
  the 3 helpers in `ai.rs` are the only touch points.
- On macOS the default keychain prompts may surface on first use — that's
  expected OS behavior; do not "fix" it silently.
