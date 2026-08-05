# ChatGPT account auth — limitations and the safe path

Status: **decision recorded, no ChatGPT login surface in Papyrus.**

## What the user asked

The user wanted to use their **OpenAI ChatGPT account** with Papyrus
(e.g. a ChatGPT Plus subscription), not a model named "Codex". Codex is
an OpenAI app, not an account tier.

## Why a ChatGPT subscription is not an API key

| Approach                                                                   | Uses ChatGPT Plus/Pro?     | Official for third-party desktop apps? | In Papyrus          |
| -------------------------------------------------------------------------- | -------------------------- | -------------------------------------- | ------------------- |
| OpenAI **API key** (platform.openai.com)                                   | No — billed as API usage   | Yes                                    | **Yes (primary)**   |
| "Sign in with ChatGPT" and call the ChatGPT web backend                    | Would try to               | No — not a supported public API        | No                  |
| Scrape chat.openai.com cookies / automate the site                         | Stolen session             | Forbidden, fragile, ToS risk           | **Never**           |
| OAuth for the OpenAI Platform API (if OpenAI documents an app/device flow) | Still API billing          | Only if documented                     | Optional follow-up  |
| Deep link: open the paper page in the browser                              | User's own ChatGPT session | Yes (just a URL)                       | **Yes (secondary)** |

An account subscription does not issue API credentials; in-app AI
requires an API key from platform.openai.com, stored in the OS keychain
by the same Rust commands every provider uses.

## What Papyrus ships (plan 053)

- The Settings preset is named **OpenAI**; the help text states plainly
  that the key is separate from a ChatGPT Plus login and lives only in
  the system keychain.
- The reader Overview has **Open paper page**: it opens the arXiv
  abstract (or the Scholar https PDF) in the system browser via the
  opener plugin — a real continuation path for users who want to use
  their own ChatGPT session on the paper, with zero credential surface.
- No password fields, no cookie capture, no webview login to
  chat.openai.com anywhere in the codebase (regression-checked).

## Monitoring

If OpenAI ever publishes official third-party ChatGPT account auth
(such as a documented OAuth/device flow for ChatGPT apps), revisit this
spike: the work would be client registration, redirect handling in a
Tauri window, token storage in the keychain and scope discipline. Until
then, the API-key path plus browser-continue is the honest product.
