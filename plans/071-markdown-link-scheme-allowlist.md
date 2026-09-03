# Plan 071: Allowlist http(s) schemes on markdown links before opening

> **Executor instructions**: Follow step by step. Do not enable raw HTML in markdown.
>
> **Drift check**: Open `src/components/markdown/markdown.tsx` and confirm `handleLinkClick` still calls `openUrl(href)` / `window.open` without scheme checks.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: Papyrus snapshot v1.1.8 (2026-08-07)

## Why this matters

AI output is untrusted. Markdown intentionally disables `rehype-raw`, but links still pass `href` straight to the system opener. Non-http(s) schemes (`javascript:`, `data:`, `file:`, etc.) should never be handed to the OS/webview helper.

## Current state

```tsx
// src/components/markdown/markdown.tsx (approx)
const handleLinkClick = (e: MouseEvent<HTMLAnchorElement>, href: string | undefined) => {
  if (!href) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  if ("__TAURI_INTERNALS__" in window) {
    void openUrl(href);
  } else {
    window.open(href, "_blank", "noreferrer");
  }
};
```

Mermaid uses `securityLevel: "strict"` — leave it alone.

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `pnpm test -- src/components/markdown` | pass (after new tests) |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**

- `src/components/markdown/markdown.tsx`
- `src/components/markdown/__tests__/markdown.test.tsx` (extend or create)
- Optional pure helper in `src/lib/safe-url.ts` if that keeps the component thin

**Out of scope**

- Changing Tauri capabilities / opener plugin config globally
- CSP (plan 076)
- Sanitizing mermaid beyond existing strict mode

## Git workflow

- Branch: `advisor/071-markdown-link-allowlist`
- Commit: `fix(security): allowlist http(s) schemes for markdown links`

## Steps

### Step 1: Add `isSafeOpenUrl(href: string): boolean`

Rules:

- Trim input.
- Allow only `http:` and `https:` (case-insensitive scheme).
- Reject empty, relative-only paths if product policy is “external links only”; **if relative links are used in-app, document and allow path-only that does not include `:` before first `/`** — prefer **reject anything that is not absolute http(s)** unless tests show in-app relative links are required.
- Reject `javascript:`, `data:`, `file:`, `vbscript:`, `blob:`.

Match existing pure-function test style under `src/lib/__tests__/`.

**Verify**: unit tests for good/bad schemes.

### Step 2: Gate `handleLinkClick`

- If unsafe: `preventDefault`, do not call `openUrl` / `window.open`.
- Optional: no UI toast required (keep minimal); silently ignore is OK.

**Verify**: component test clicks an `https://` link (mock `openUrl`) and a `javascript:` link (openUrl not called).

### Step 3: Regression

**Verify**: `pnpm test` + `pnpm typecheck`.

## Test plan

- `isSafeOpenUrl('https://arxiv.org/abs/x')` → true
- `isSafeOpenUrl('http://localhost:3000')` → true (preview)
- `isSafeOpenUrl('javascript:alert(1)')` → false
- `isSafeOpenUrl('data:text/html,hi')` → false
- `isSafeOpenUrl('file:///etc/passwd')` → false
- Markdown component: unsafe link does not invoke opener

Model tests after `src/components/markdown/__tests__/markdown.test.tsx` if present.

## Done criteria

- [ ] Unsafe schemes never call `openUrl` / `window.open`
- [ ] http(s) still open
- [ ] New unit tests pass
- [ ] `pnpm typecheck` exits 0

## STOP conditions

- Opener API requires a different permission model for filtered URLs — stop and report rather than broadening capabilities.
- Existing tests depend on opening non-http links — report before changing policy.

## Maintenance notes

- Any future “open PDF path” feature must use a dedicated IPC path, not markdown links.
- Reviewers: confirm no `rehype-raw` was added.
