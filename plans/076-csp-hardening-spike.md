# Plan 076: CSP hardening spike for Tauri webview

> **Executor instructions**: This is a **spike + minimal safe hardening**. Acceptable outcome is a written decision to keep `csp: null` with rationale if strict CSP breaks pdf.js / mermaid / Vite assets.
>
> **Drift check**: `src-tauri/tauri.conf.json` → `app.security.csp`.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED–HIGH (CSP can blank the UI)
- **Depends on**: none
- **Category**: security
- **Planned at**: Papyrus snapshot v1.1.8 (2026-08-07)

## Why this matters

`csp: null` disables Content-Security-Policy on the webview. For a local desktop app with trusted asset pipeline the risk is lower than a public website, but defense-in-depth still matters if attacker-controlled content (AI markdown, future plugins) runs in the same webview.

## Current state

```json
"security": {
  "csp": null
}
```

Frontend needs: Vite-built JS/CSS, workers (`pdf.worker`), possible `blob:` / `worker-src` for pdf.js, KaTeX CSS, mermaid SVG inject, IPC.

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Dev run | `pnpm tauri dev` (Windows primary) | UI loads, PDF opens, mermaid renders |
| Build | `pnpm build` + tauri build if used | succeeds |

## Scope

**In scope**

- `src-tauri/tauri.conf.json` CSP string **or** documented decision file `docs/spikes/csp.md`
- Minimal asset adjustments only if required for CSP (e.g. worker paths)

**Out of scope**

- Electron migration
- iframe sandboxing product features
- Changing markdown HTML policy (still no rehype-raw)

## Git workflow

- Branch: `advisor/076-csp-spike`
- Commit either:
  - `security: set restrictive Tauri CSP compatible with pdf.js` **or**
  - `docs: record CSP null decision and threat model`

## Steps

### Step 1: Threat model note (short)

Write in the PR or `docs/spikes/csp.md`:

- Threats mitigated by CSP vs already mitigated (no rehype-raw, link allowlist from 071, SSRF guards).
- What breaks if `script-src 'self'` is enforced.

### Step 2: Propose a CSP

Start restrictive and loosen only with evidence:

- `default-src 'self'`
- `script-src 'self'`
- `style-src 'self' 'unsafe-inline'` (KaTeX/inline may need it — verify)
- `img-src 'self' data: blob:`
- `worker-src 'self' blob:`
- `connect-src 'self' https: http://127.0.0.1:* http://localhost:*` only if the webview itself fetches (most fetches are Rust — keep tight)
- `object-src 'none'`
- `base-uri 'self'`
- `frame-src 'none'`

### Step 3: Validate on Windows

Checklist:

- [ ] App shell renders
- [ ] Papers list loads
- [ ] PDF viewer pages paint
- [ ] Walkthrough/Ask markdown + KaTeX
- [ ] Mermaid block
- [ ] Provider test call still works (Rust side)

If checklist fails after two controlled loosenings, **revert to `csp: null`** and document blockers in `docs/spikes/csp.md` — that is a valid DONE for this spike.

## Test plan

- Manual checklist above (no reliable headless CSP test in CI required for DONE).
- Optional: note in release.md under security.

## Done criteria

- [ ] Either a working CSP in `tauri.conf.json` **or** spike doc explaining residual risk and why null remains
- [ ] PDF + mermaid verified in the chosen outcome
- [ ] No secret material in docs

## STOP conditions

- CSP requires `unsafe-eval` for a dependency — stop, document dependency name, do not silently add `unsafe-eval` without stating it in the spike doc.

## Maintenance notes

- Re-test CSP on every major pdfjs / vite upgrade.
- Pair with plan 071 (link schemes) for layered defense.
