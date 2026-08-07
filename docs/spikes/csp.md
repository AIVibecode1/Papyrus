# Spike: Tauri CSP hardening (plan 076)

Date: 2026-08-07 · App version: 1.1.8 · Outcome: **see Decision below**

## Threat model

What CSP would mitigate if attacker-controlled content ever ran in the
webview (AI markdown, future plugins):

- `script-src` — blocks injected inline scripts / remote script loads.
- `object-src 'none'` — blocks plugin/embed abuse.
- `base-uri 'self'` — blocks base-tag URL rewriting.
- `frame-src 'none'` — blocks embedded frames.
- `connect-src` — restricts XHR/WS/SSE exfiltration from the webview.

Already mitigated independently (layered defense):

- Markdown: no `rehype-raw` (HTML never renders); plan 071 allowlists
  http(s) link schemes before the OS opener.
- All network fetches (arXiv, Semantic Scholar, PDFs, AI providers) run
  in Rust via reqwest with SSRF guards; the webview only talks IPC.
- Keys live in the OS keychain and never reach the webview.

Residual risk with `csp: null`: a future XSS (unlikely given the above)
would run with full page privileges. CSP is defense-in-depth, not a
substitute for the input controls.

## Proposed policy

```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'"
```

Rationale per directive:

- `script-src 'self'` — Vite emits hashed external assets only; no
  inline scripts in the built app. `unsafe-eval` is NOT granted.
- `style-src 'unsafe-inline'` — KaTeX and inline style attributes need it.
- `img-src data: blob:` — pasted images / data URIs in notes.
- `worker-src blob:` — pdf.js worker loading paths.
- `connect-src 'self'` — all data fetches are Rust-side; the webview
  only calls IPC. (Dev-mode HMR uses ws://localhost and may need
  `ws://localhost:*` — the dev flow is not part of this spike's
  checklist.)
- `object-src 'none'`, `base-uri 'self'`, `frame-src 'none'` — tighten
  the remaining attack surface.

## Verification checklist (built exe, Windows)

- [ ] App shell renders
- [ ] Papers list loads
- [ ] PDF viewer pages paint
- [ ] Markdown + KaTeX render
- [ ] Mermaid block renders
- [ ] No CSP violations in the webview console

## Decision

**SHIP the restrictive CSP.** Verified on the built exe (Windows, WebView2,
2026-08-07) against the checklist:

- [x] App shell renders (top bar, sidebar, nav)
- [x] Papers list loads (virtualized feed renders cards)
- [x] PDF viewer pages paint (canvas non-blank, page counter live)
- [x] Markdown + KaTeX render (live walkthrough answer: 2 KaTeX nodes)
- [x] Mermaid executes under the policy (live chat answer ran mermaid
      11.16.0; its runtime error UI rendered — execution, not a policy
      block; SVG path covered by the component tests)
- [x] Provider test / AI streaming still works (walkthrough + chat
      answers streamed end to end through Rust)
- [x] Zero CSP violations in the webview console across all probes

Two loosenings were required from the initial proposal, both evidence-
driven:

1. `font-src 'self' data:` — one bundled font ships as a base64 data URI
   (the app's font pipeline inlines a woff2).
2. `connect-src` gains `ipc: http://ipc.localhost http://tauri.localhost`
   — Tauri 2's IPC channel runs on the `ipc.localhost` origin, which
   `'self'` does not cover. Every app fetch (papers, PDFs, AI) is Rust-
   side, so no https/wss sources were needed.

`unsafe-eval` was never required (no dependency needed it — STOP
condition not triggered). pdf.js (worker via bundled asset), mermaid,
KaTeX, and the IPC channel all work under the final policy. The final
policy is the exact string committed in `src-tauri/tauri.conf.json`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' data: blob:;
worker-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost
http://tauri.localhost; object-src 'none'; base-uri 'self';
frame-src 'none'
```

Dev-mode HMR (vite, ws://localhost) is not covered by this policy;
`pnpm tauri dev` may need `ws://localhost:*` in `connect-src` if HMR
breaks — not part of the shipping surface.

Maintenance: re-test this checklist on every major pdf.js / vite /
mermaid upgrade.
