# Plan 043 — Codex safe auth + provider hardening

**Priority:** P1 · **Effort:** M · **Depends on:** 040

## Context

Papyrus already supports BYO providers with OS keychain storage
(`src-tauri/src/ai/keychain.rs`, settings save/test flow). Users want a
**first-class, safe path to Codex** (OpenAI’s coding / high-reasoning
models and any Codex-compatible endpoint the user runs).

“Connect to Codex safely” in this codebase means:

1. A documented **provider preset** for Codex / OpenAI that uses the
   **same** keychain path as other providers (no key in webview, no key
   in logs, redaction on errors).
2. Clear UX for “connected / missing key / test failed” states.
3. Optional hardening: validate base URL, scope key to account id,
   never echo secrets in export.
4. **No** custom OAuth client unless OpenAI’s public device-flow or
   documented OAuth for this product is available — do **not** invent
   client IDs or embed secrets in the repo.

If product intent is specifically **OpenAI Codex CLI / ChatGPT desktop
bridge**, treat that as a **spike** (`docs/spikes/codex-oauth.md`) and
ship the API-key preset first. Desktop OAuth against ChatGPT is a
different security surface (browser redirect, token refresh) and must
not be half-implemented.

## Non-negotiables

- Keys only in OS keychain via existing `save_api_key` / `get_key` /
  `has_api_key` / `delete_api_key` commands.
- Export must never include raw keys (verify current export; add test).
- Provider test uses existing `test_provider` IPC; errors categorized
  via `provider-errors.ts` + redaction.
- HTTPS required for non-loopback hosts (already enforced).

## Out of scope

- Storing ChatGPT session cookies.
- Proxying Codex through a Papyrus cloud backend (there is none).
- Fine-tuning or uploading papers to OpenAI automatically.

---

## Work unit 1 — Preset definition

**File:** `src/lib/types.ts` → `PROVIDER_PRESETS`

Add:

```ts
codex: {
  key: "presets.codex",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5-codex", // VERIFY against OpenAI’s current public model ids at implementation time
  keyRequired: true,
  models: [
    // Fill with models that are actually available to API users in 2026.
    // If "codex" is a ChatGPT-only product name, use the closest API models
    // (e.g. o-series / gpt-coding models) and label the preset "OpenAI (Codex-class)".
    { id: "…", label: "…" },
  ],
},
```

**Agent instruction:** Before hard-coding model ids, check OpenAI’s
current API model list **or** keep the model field free-typed with
sensible defaults. Prefer defaults that fail closed with a clear
“model not found” category rather than silent wrong model.

i18n:

```
presets.codex: "OpenAI Codex"
settings.codexHelp: short help — “API key from platform.openai.com; stored only in your OS keychain.”
```

AR equivalents in the same commit.

**Commit:** `feat(providers): Codex / OpenAI preset + i18n help`

---

## Work unit 2 — Settings UX for connection state

In `settings-page.tsx` (provider form):

1. When preset is Codex/OpenAI, show:
   - Link out to API keys page via `opener` (existing plugin) —
     `https://platform.openai.com/api-keys` (confirm URL).
   - Status badge: **Key saved** / **No key** from `has_api_key`.
   - Test connection button (existing) with category-specific guidance
     for auth failures.
2. Never display the key after save (existing pattern — preserve).
3. “Remove key” calls `delete_api_key`.

Optional: “Connection checklist” collapsed help:

- Key created
- Billing enabled on OpenAI side (user responsibility)
- Model id matches access

**Commit:** `feat(settings): Codex connection status + external key link`

---

## Work unit 3 — Safety audit (must pass)

Agent runs a focused audit and fixes gaps:

| Check | Expected |
| ----- | -------- |
| Key path | Only Rust keychain reads; grep frontend for `sk-` persistence |
| Logs | No `console.log` of provider config including keys |
| Export | `export_data` JSON has no `apiKey` fields |
| Error UI | `redactSecrets` / `redactTokens` applied on test failures |
| SSRF | Provider base URL host not used for PDF fetch |
| Account isolation | Keychain account string includes provider id (existing?) — if all keys share one account, fix to `provider.id` |

Add regression tests where missing (especially export + redaction).

**Commit:** `security(providers): audit export/redaction/keychain account isolation`

---

## Work unit 4 — Optional: OpenRouter Codex-class models

Many users reach coding models via OpenRouter. Extend OpenRouter preset
`models` list with clearly labeled coding models **only if** ids are
public and stable. Do not invent ids.

**Commit (optional):** `feat(providers): label coding models on OpenRouter preset`

---

## Work unit 5 — Spike note only (no production OAuth)

Create `docs/spikes/codex-oauth.md` describing:

- Why API key is the v1 approach
- What would be required for OAuth/device flow (client registration,
  redirect URI for Tauri, token storage in keychain, refresh)
- Decision: defer until product has a registered OAuth client

**Commit:** `docs(spike): Codex OAuth deferred; API key is v1`

---

## Verification gates

- Save Codex preset + key → `has_api_key` true → test_provider returns
  ok on a live key (manual, ignored in CI).
- Export file inspected: no secrets.
- Frontend tests: preset appears in quick-add; help string renders.
- Full gates.

## Commit strategy

1. Preset + i18n
2. Settings connection UX
3. Security audit fixes + tests
4. Optional OpenRouter labels
5. OAuth spike doc

## Agent anti-patterns

- Do not commit a real API key or `.env` with secrets.
- Do not implement browser password scraping.
- Do not store keys in `settings.json` “for convenience”.
- Do not claim “OAuth connected” if only an API key was saved.
