# Plan 077: Add dependency audit gates to CI

> **Executor instructions**: Audits must be read-only reporting. Do not force unrelated major upgrades in this plan unless audit fails on a **reachable high/critical** issue with a clear patch version.
>
> **Drift check**: Read `.github/workflows/ci.yml`.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (CI may go red on existing advisories — handle with allowlist or fix)
- **Depends on**: none
- **Category**: dependencies | dx
- **Planned at**: Papyrus snapshot v1.1.8 (2026-08-07)

## Why this matters

CI already runs typecheck, lint, tests, prettier, release integrity, cargo test/clippy/fmt, and Tauri build. It does **not** run `pnpm audit` or `cargo audit`, so known vulnerable dependencies can ship unnoticed.

## Current state

- Frontend job: install → typecheck → lint → test → prettier → integrity.
- Desktop job: cargo test/clippy/fmt + tauri-action.

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| JS audit | `pnpm audit --prod` (or `pnpm audit`) | document baseline |
| Rust audit | `cargo audit` (may need `cargo install cargo-audit` in CI) | document baseline |

## Scope

**In scope**

- `.github/workflows/ci.yml`
- Optionally `docs/` or comment in workflow on how to suppress accepted risks
- Dependency patches **only** if required to make a newly added gate pass and the fix is a semver-compatible bump

**Out of scope**

- Full framework major upgrades
- Replacing package manager

## Git workflow

- Branch: `advisor/077-ci-audit`
- Commit: `ci: run pnpm audit and cargo audit on PRs`

## Steps

### Step 1: Baseline locally

Run audits; record high/critical counts in the PR body (do not paste secret material).

### Step 2: Frontend CI step

Add after install (or at end of frontend job):

```yaml
- name: pnpm audit
  run: pnpm audit --audit-level=high
```

If the project uses a newer pnpm audit CLI flag, match current pnpm 10 docs.

### Step 3: Rust CI step

On desktop job (or a small linux job):

```yaml
- name: cargo audit
  run: |
    cargo install cargo-audit --locked
    cargo audit --manifest-path src-tauri/Cargo.toml
```

Prefer `dtolnay/rust-toolchain` already present; install cargo-audit each run or use a cached action if one is standard.

### Step 4: Handle existing findings

- If audit fails on transitive noise: use `pnpm.overrides` / `cargo update` carefully, or an explicit ignore file with **expiry comment** (not a permanent blind ignore).
- Do not weaken the gate to `continue-on-error: true` without stating why in the PR (prefer fixing or scoped ignores).

**Verify**: empty PR CI green on the branch.

## Test plan

- CI configuration review; no app unit tests required.
- Optional: script `pnpm run audit` in package.json pointing at the same command for local DX.

## Done criteria

- [ ] CI runs a JS dependency audit at high+ severity
- [ ] CI runs cargo audit on the Tauri crate
- [ ] Known failures either fixed or documented ignores with reason
- [ ] Main app tests still green

## STOP conditions

- Audit requires a major breaking upgrade of React/Tauri to clear a CVE — stop and open a separate migration plan rather than sneaking it into this PR.
- `cargo audit` unavailable on a matrix OS — run it on ubuntu only.

## Maintenance notes

- Revisit ignores every 90 days.
- Pair with `check-release-integrity` before tagged releases.
