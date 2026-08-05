# Codex OAuth — deferred (API key is v1)

Status: **decision recorded, no production OAuth.**

## Why the API key path is the v1 approach

Papyrus connects to Codex-class models (gpt-5.3-codex and the GPT-5.6
family) through the standard OpenAI-compatible API with a personal API
key. This reuses the exact security model every other provider already
has:

- Keys live only in the OS keychain (Windows Credential Manager / macOS
  Keychain), written and read by Rust commands (`save_api_key`,
  `has_api_key`, `delete_api_key`).
- The webview never sees or stores the key.
- Export files contain no key-shaped fields (regression-tested).
- Provider errors are redacted before they reach the UI.

An API key is a single credential with no redirect surface, no refresh
token lifecycle and no browser dependency — the smallest attack surface
that satisfies "connect to Codex safely".

## What real OAuth/device flow would require

If the product later needs "sign in with ChatGPT" (not an API key):

1. **Client registration.** A registered OAuth client id + client
   secret for the Papyrus desktop app (open-source: secrets in a public
   repo are not secrets — would need a backend or per-user registration).
2. **Redirect URI** for a Tauri window (custom scheme like
   `papyrus://oauth-callback` or a loopback port), declared in the
   capability and OS-level URL association.
3. **Token storage** in the keychain (access token + refresh token),
   with refresh-token rotation and revocation handling.
4. **User-agent surface**: opening the provider's authorization page in
   the app webview or the system browser, plus PKCE state validation.
5. **Scope discipline**: requesting only the scopes the app actually
   uses, and auditing what ChatGPT/Codex OAuth scopes exist for desktop
   apps at that time.

## Decision

Defer OAuth until the project owns a registered OAuth client. Do not
half-implement a browser-redirect flow inside the Tauri webview: the
session-cookie and token-refresh surface is a different security model
and would ship without the ability to revoke cleanly. The API-key
preset covers the same models today.
