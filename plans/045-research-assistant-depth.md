# Plan 045 — Research-assistant depth (alphaXiv-style mentor features)

**Priority:** P1 · **Effort:** M · **Depends on:** 041, 042, 043

## Goal

Papyrus already explains abstracts, walks sections, synthesizes, and
chats with paper text. alphaXiv-style depth means the assistant feels
**grounded, navigable, and cumulative**:

- Explanations cite paper regions when possible.
- User can jump from AI output to PDF context.
- Notes + explanations stay associated with the paper.
- Search can reopen a paper into the same reader workspace quickly.

This plan **extends** existing reader/AI flows; it does not replace the
prompt files wholesale without measurement.

## Non-negotiables

- AI still uses the user’s providers only (including Codex preset).
- Grounding remains based on extracted PDF text / abstract already in
  the app — no silent external RAG service.
- Streaming + stop semantics (operation registry) remain intact.
- Do not increase default token send size without a hard cap.

## Out of scope

- Multi-paper literature review agent (spike).
- Automatic citation graph crawling beyond existing citation counts.
- Hosted Papyrus accounts.

---

## Work unit 1 — Reader information architecture

Document and implement a clear side-panel structure:

```
[ Overview | Walkthrough | Chat | Notes ]
```

- Overview: abstract, TLDR, venue, citation count, “Explain abstract”
- Walkthrough: existing section mentor
- Chat: existing grounded Q&A
- Notes: from 042

If the panel is already crowded, use tabs with `dir`-aware Radix tabs.

**Commit:** `feat(reader): tabbed mentor panel (overview/walkthrough/chat/notes)`

---

## Work unit 2 — “Open from notes / search” continuity

When opening a paper from:

- search results
- notes hub
- favorites

…restore:

- last reading scroll position (if already stored)
- previous walkthrough completion state (existing persistence)
- notes for that paper

Add tests that store hydration does not race (generation tokens if
needed).

**Commit:** `fix(reader): consistent reopen from search notes favorites`

---

## Work unit 3 — Prompt tightening for research use

Files: `src-tauri/prompts.json` / `papyrus_prompts_v2.md` (use the live
path the Rust loader actually reads).

Changes (keep short, test with fixture paper text):

1. Instruct model to prefer **plain language** then optional precise
   term.
2. When section text is provided, forbid inventing equations not in the
   excerpt.
3. Chat system prompt: if answer is not in the provided text, say so.

Do not add “hype” language. Keep bilingual behavior: respond in the
user UI language when the frontend passes locale (if not already,
thread `locale` into explain commands carefully).

**Commit:** `feat(ai): tighten grounded prompts + optional locale thread`

---

## Work unit 4 — Related / older papers entry points

Lightweight, not a new recommender:

1. From reader overview, show arXiv id + “Search title on Semantic Scholar”
   button that jumps to papers view with search prefilled (field title).
2. From an old foundational hit in search, one-click open reader.

This reuses 041; no new ranking model.

**Commit:** `feat(reader): search-this-title action into advanced search`

---

## Work unit 5 — Notes → AI (optional, small)

In notes panel: “Ask about this note” pre-fills chat with the note body
as user context **once** (not automatic). Respect stop/cancel.

Skip if chat composition is complex; mark as optional in commit message.

**Commit (optional):** `feat(notes): send note into grounded chat once`

---

## Verification gates

- Tab switching does not unmount PDF (no reload flash).
- Locale: AR UI → Arabic answers if locale is threaded; otherwise document
  limitation.
- Prompt changes covered by at least snapshot or string-includes tests
  on loaded prompt templates if the codebase tests them; else manual
  checklist in PR.
- Full gates.

## Commit strategy

Follow work units 1–4 mandatory; 5 optional.

## Agent anti-patterns

- Do not auto-send full PDF bytes to the model (text extract only, capped).
- Do not add a second chat stack.
- Do not break operation-id cancellation when adding tabs.
