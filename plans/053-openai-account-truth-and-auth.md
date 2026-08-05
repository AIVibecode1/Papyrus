# Plan 053 — OpenAI / ChatGPT account: tell the truth, then ship the safe path

**Priority:** P1 · **Effort:** M · **Depends on:** —

## Product correction (read carefully)

The user did **not** ask for a model id named “Codex.”

> Codex is not a model — it is an app by OpenAI.  
> What I meant: the user can use their **OpenAI ChatGPT account** with the app.

### What is actually possible (2026)

| Approach | Uses ChatGPT Plus/Pro subscription? | Official for third-party desktop apps? | Ship in Papyrus? |
| -------- | ----------------------------------- | -------------------------------------- | ---------------- |
| OpenAI **API key** (platform.openai.com) | **No** — billed as API usage | Yes | **Yes (primary)** |
| “Sign in with ChatGPT” and call ChatGPT web backend | Would try to | **No** — not a supported public API | **No** |
| Scrape chat.openai.com cookies / automate the site | Stolen session | Forbidden, fragile, ToS risk | **Never** |
| OAuth for **OpenAI Platform API** (if OpenAI offers a documented app OAuth / device flow for API access) | Still API billing | Only if documented | Optional follow-up |
| Deep link: open paper abstract in ChatGPT / browser | User’s own ChatGPT session | Yes (just a URL) | **Yes (secondary)** |

Papyrus cannot honestly promise “log in with your ChatGPT account and
run Plus models inside Papyrus” without an official OpenAI product
that grants that. Agents must not fake OAuth screens that store
passwords.

## Goals of this plan

1. Remove misleading **Codex-as-model** labeling from Settings if it
   implies ChatGPT app login.
2. Rename / reframe the preset as **OpenAI API** with clear copy:
   - Keys from platform.openai.com
   - Not the same as ChatGPT Plus
   - Stored only in OS keychain
3. Add a practical **“Open in ChatGPT”** (or “Continue in browser”)
   action on paper/reader that opens a pre-filled ChatGPT URL or the
   arXiv abstract page — so users with a ChatGPT account still get a
   path without fake in-app login.
4. Write `docs/spikes/chatgpt-account-auth.md` stating the limitation
   and what would be required if OpenAI ships real third-party ChatGPT
   auth later.

## Work units

### 1. Settings copy & preset cleanup

**Files:** `src/lib/types.ts`, `en.json`, `ar.json`, provider form

- Preset key label: **OpenAI** (not “Codex” unless OpenAI’s public API
  still brands a coding model that way — then list it under models,
  not as the preset name).
- Help text (EN concept):

  > Use an API key from platform.openai.com. This is separate from a
  > ChatGPT Plus login. Papyrus stores the key only in your system
  > keychain.

- AR: same meaning, natural phrasing.
- Connection status UI stays keychain-based.

**Commit:** `fix(settings): clarify OpenAI API vs ChatGPT account`

### 2. “Open in ChatGPT” affordance

**Reader overview + paper card (optional one place first)**

- Button opens system browser via existing `opener` plugin.
- URL options (pick one, document it):
  - `https://chat.openai.com/` (user pastes context themselves), or
  - A share URL if OpenAI documents query params for prompts (verify
    live; do not invent broken params), or
  - Always safe: `https://arxiv.org/abs/{id}` so the user continues
    from the paper in any tool they want.

Prefer **arXiv abs link** + optional ChatGPT homepage over brittle
prompt-injection URLs.

Label: “Open paper page” / “Open in browser” rather than promising
ChatGPT API access.

**Commit:** `feat(reader): open paper in system browser`

### 3. Spike doc (mandatory)

`docs/spikes/chatgpt-account-auth.md`:

- User request summary
- Why ChatGPT subscription ≠ API key
- Why scraping is rejected
- Monitoring: if OpenAI publishes OAuth for ChatGPT apps, revisit
- Interim UX: API key + browser continue

**Commit:** `docs(spike): ChatGPT account auth limitations`

### 4. Security regression

- Confirm no password fields for “ChatGPT login”
- Confirm export still has no keys
- Remove any dead “codex” OAuth stubs if half-implemented

**Commit:** `security(providers): no consumer ChatGPT login surface`

## What success looks like

- User understands they need a **platform API key** for in-app AI.
- User is not told Codex is “connected” when they only have ChatGPT.
- User can jump to the paper in the browser in one click.
- No credential phishing UI.

## Agent anti-patterns

- Do not implement email/password forms against chat.openai.com.
- Do not store session tokens from a webview login to ChatGPT.
- Do not claim “ChatGPT Plus works inside Papyrus” in README.
