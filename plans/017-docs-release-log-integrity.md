# Plan 017: Restore release-log integrity and automate version consistency checks

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- release.md README.md plans/README.md package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs | dx | correctness
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

`release.md` is the source of truth for humans and AI agents, but its historical sections currently contain duplicated `Built from` lines and superseded sections that do not retain their original version heading. That makes release provenance ambiguous and can cause an agent to attach the wrong notes to a tag. Version consistency is also only a written rule; a simple automated check would prevent future installer/release mismatches.

## Current state

- `release.md:22-78` contains v1.0.4 followed by an unheaded superseded block that appears to be an older release and includes duplicate `Built from` lines.
- Additional superseded blocks repeat the same issue around v1.0.3 and v1.0.2.
- `package.json:4`, `src-tauri/tauri.conf.json:4`, `src-tauri/Cargo.toml:3`, and the lockfile carry version data that should agree before a release.
- `AGENTS.md` requires every user-facing change to update README/release notes and bump all three manifests.
- `plans/README.md` was already refreshed to the current audit SHA; this plan must not reintroduce historical plan duplication.

## Commands you will need

| Purpose        | Command                                                             | Expected                          |
| -------------- | ------------------------------------------------------------------- | --------------------------------- |
| JSON parse     | `pnpm exec prettier --check package.json src-tauri/tauri.conf.json` | exit 0                            |
| Version check  | `node dev/check-release-integrity.mjs`                              | exit 0 and reports equal versions |
| Docs format    | `pnpm run format:check`                                             | exit 0                            |
| Frontend gates | `pnpm run typecheck && pnpm run lint && pnpm run test`              | all pass                          |

## Scope

**In scope**:

- `release.md`
- `README.md` only if its current version/count references are corrected
- `dev/check-release-integrity.mjs` and its test
- `package.json` scripts only if needed to expose the check
- `plans/README.md` only to update this plan’s status

**Out of scope**:

- Rewriting old release bullet points
- Deleting any historical release entry
- Changing application behavior
- Bumping the version as part of this docs/tooling plan unless a mismatch is found; if a mismatch is found, STOP and report it first

## Steps

### Step 1: Repair release section boundaries without deleting history

Give every historical section its original `## vX.Y.Z - date` heading, exactly one status, exactly one built-from commit, and its original gate counts. Keep all old sections and bullets. Mark unpublished superseded entries clearly, but never merge their content into a newer section.

**Verify**: a script or targeted text check finds one heading per historical version and no duplicate `Built from:` line in any section.

### Step 2: Add a read-only release integrity checker

Create `dev/check-release-integrity.mjs`. It must parse the three manifests and the lockfile, compare versions, verify that the top `release.md` section names the same version, verify the README current version reference, and fail with actionable output on mismatch. It must not mutate files or contact the network.

**Verify**: run the checker on the current repo and add fixtures/tests for matching and mismatching versions.

### Step 3: Wire the check into release verification

Add a package script only if it matches existing command style, and add the check to the release checklist/CI without making every normal commit depend on a published release tag. Do not make a docs check block unrelated local development.

**Verify**: checker, docs formatting, and all frontend gates pass.

## Test plan

- Equal versions across package, Tauri config, Cargo manifest, and lockfile.
- Mismatched package/Tauri version exits non-zero and names both paths.
- Top release heading mismatch exits non-zero.
- Duplicate built-from lines are detected.
- No network or file mutation occurs.

## Done criteria

- [ ] Historical sections retain their version heading and provenance.
- [ ] No duplicate built-from lines remain.
- [ ] Integrity checker is read-only and tested.
- [ ] README/release/package versions are consistent.
- [ ] Full frontend gates pass and only scoped files change.

## STOP conditions

- A historical built-from SHA cannot be established from git history; preserve the ambiguity explicitly and report it rather than guessing.
- Correcting README counts would require inventing test results; run the canonical suite first.
- The lockfile has a version format the checker cannot parse safely; report the exact shape before changing it.

## Maintenance notes

Run the checker before every release build. When a release is published, freeze its section and add the next version below it without editing historical content.
