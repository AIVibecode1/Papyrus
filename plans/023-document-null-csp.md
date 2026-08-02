# Plan 023: Document the deliberate null-CSP decision in the README

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

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (docs only)
- **Depends on**: plans/007 (capability trimming — the README security
  section's claims should reflect the post-007 state)
- **Category**: docs (security posture)
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

`tauri.conf.json` sets `"csp": null` while the README's Security notes
section claims "The webview runs with a restricted capability set" — the
biggest webview hardening decision is invisible. A security-forward OSS
project's README should say why CSP is null (the app loads only local
bundled assets; provider responses render as plain text, never HTML; users
configure arbitrary provider base URLs, so a static `connect-src`
whitelist is impossible) so contributors don't "fix" it without context or
assume protection that doesn't exist.

## Current state

- `src-tauri/tauri.conf.json:22-24`:

```json
    "security": {
      "csp": null
    }
```

- `README.md:71-76` — "Security notes" bullet list (keys in keychain,
  restricted capabilities, plain-text rendering, arXiv rate limit).

## Commands you will need

| Purpose | Command | Expected on success |
| ------- | ------- | ------------------- |
| None    | —       | — (docs-only)       |

## Scope

**In scope** (the only files you should modify):

- `README.md`

**Out of scope** (do NOT touch):

- `src-tauri/tauri.conf.json` — this plan documents the decision; a
  future hardening plan may revisit it (see SECURITY-02 in the audit).

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Add the CSP bullet

In `README.md`'s "Security notes" list, after the capabilities bullet,
add:

```md
- The webview ships without a Content-Security-Policy (`"csp": null` in
  `src-tauri/tauri.conf.json`) by design: the UI loads only local bundled
  assets, AI responses are rendered as plain text (never HTML), and users
  configure arbitrary provider base URLs, which a static `connect-src`
  whitelist cannot express. Script execution is limited by the capability
  set (see above). Revisit if HTML rendering (e.g. markdown) is ever added.
```

**Verify**: the section reads correctly and the bullet matches the actual
config (`grep -n '"csp"' src-tauri/tauri.conf.json` → `"csp": null`).

## Test plan

- None (docs).

## Done criteria

- [ ] README Security notes contains the CSP bullet with the rationale
- [ ] No files other than `README.md` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The CSP config value has changed since this plan was written (drift) —
  report; the doc must match reality.
- Plan 007 hasn't landed and the capabilities bullet differs — write the
  CSP bullet to be consistent with whatever the capabilities section says
  at execution time.

## Maintenance notes

- If a future plan sets a real CSP (partial hardening with
  `script-src 'self'`), this bullet must be rewritten — do it in the same
  change that sets the CSP.
- The README is the contract for security-conscious contributors; keep
  every claim here verifiable against `tauri.conf.json` and
  `capabilities/default.json`.
