# Papyrus product vision — Round 4 enhancements

## What Papyrus is today

A **local-first desktop research digest and explainer**:

- Browse newest arXiv papers in six CS/ML categories, with day history.
- Search keywords (arXiv or Semantic Scholar).
- Read PDFs in-app; explain abstract, walk sections, chat with extracted
  text using the user’s own AI providers (keys in OS keychain).
- English + Arabic with RTL support; light / sepia / dark themes.
- Favorites, citation counts, today’s picks, provider failover.

It is already closer to alphaXiv than a pure arXiv RSS reader, but it
is still **digest-first**. Power users need **archive search**, **notes**,
and a **clear path to coding-class models (Codex)** without weakening
the security model.

## What Round 4 delivers

### 1. Architecture that agents can extend (040)

Stable view slots, extracted papers chrome, documented feature folders,
density tokens, logical CSS discipline. Reduces merge conflicts when
search and notes land.

### 2. Real search over the archive (041)

| Choice | Behavior |
| ------ | -------- |
| Field | All / Title / Author / Abstract / arXiv ID |
| Time | Any · presets · custom year range |
| Source | arXiv · Semantic Scholar (existing) |
| Scope | Optional limit to current category |
| UX | Clear button, Esc, honest status line, empty-state clear |

Old papers become findable without leaving the app or knowing the id
(though ID search is supported).

### 3. Note-taking (042)

- Paper notes and selection highlights, stored under app data.
- Notes hub for review; reader integration while studying a PDF.
- Included in export/import; never uploaded automatically.

### 4. Codex, safely (043)

- First-class provider preset for OpenAI / Codex-class API models.
- Same keychain auth as every other provider.
- Explicit non-goal for v1: ChatGPT OAuth / session scraping.
- Security audit on export and redaction.

### 5. Bilingual UI precision (044)

RTL/LTR correctness on new chrome, card density, contrast, shared empty
states, en/ar key parity tests.

### 6. Deeper mentor workspace (045)

Tabbed reader panel (overview / walkthrough / chat / notes), reopen
continuity from search and notes, tighter grounded prompts, “search this
title” bridge back into advanced search.

### 7. Review + release (046–047)

Race hunts on new modules; versioned release with honest changelog.

## Success metrics (qualitative)

- User can find a 2017 landmark paper by title in under three actions.
- User can highlight a paragraph, write a note, restart the app, and see
  both.
- User can attach an OpenAI key for Codex-class models and test the
  connection without the key ever appearing in export JSON or logs.
- Arabic session: no mirrored PDF, no broken search clear button edge,
  no missing translation keys on new screens.

## Relationship to Round 3

Round 3 focused on PDF heaviness, citation honesty, design polish, and
release 1.0.11. Round 4 is **feature architecture**. If PDF virtualization
(032) is still open, treat it as parallel performance work — long papers
will still feel heavy even with perfect search.

## Copy these files into the repo

Place under `Papyrus/plans/`:

- `000-agent-brief-round4.md`
- `README.md` (Round 4 section — merge carefully with existing README)
- `040-architecture-foundations.md`
- `041-advanced-search.md`
- `042-note-taking.md`
- `043-codex-safe-auth.md`
- `044-rtl-ltr-uiux.md`
- `045-research-assistant-depth.md`
- `046-deep-logic-review-new-modules.md`
- `047-release-round4.md`
- `PRODUCT-VISION-ROUND4.md` (this file)

Then instruct your coding agent:

> Read `plans/000-agent-brief-round4.md`, then execute plans 040→047 in
> order. Do not skip Non-negotiables. Commit after each work unit when
> gates are green.
