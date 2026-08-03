# Plan 021: Productize paper discovery and make provenance visible

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src/features/papers/paper-list.tsx src/features/papers/paper-card.tsx src/features/reader/reader-view.tsx src/i18n/locales/en.json src/i18n/locales/ar.json docs/spikes/curated-daily.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 016 is not required; use current arXiv/Semantic Scholar data
- **Category**: direction | UX | trust
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

Papyrus already collects daily history and exposes paper actions, but the UI still asks users to manually choose from a large feed. The existing curated-daily spike provides a grounded five-paper selection concept. At the same time, source provenance is not consistently visible: Semantic Scholar fallback is announced, but TLDR substitution and source identity can be silent. The next product pass should improve selection and trust without adding another generic dashboard or replacing the current visual system.

## Current state

- `src/features/papers/paper-list.tsx:113-223` combines search, refresh, saved filtering, day navigation, progress, and fallback state.
- `src/features/papers/paper-card.tsx:90-168` presents metadata, abstract/TLDR content, and three peer actions.
- `src/features/reader/reader-view.tsx:235-260,355-373` provides title/header and Walkthrough/Ask modes but limited context cues.
- `docs/spikes/curated-daily.md:53-81` recommends a deterministic, dismissible five-paper strip before AI ranking.
- `README.md` promises distinct flows: Quick explanation, Read workspace, whole-paper mentor, grounded Ask, and source fallback.

## Scope

**In scope**:

- A category-scoped, dismissible “Today’s picks” strip using deterministic signals already available.
- Clear action hierarchy and labels for Read, Quick explanation, external PDF, and Walkthrough.
- Compact source/provenance labels distinguishing arXiv, Semantic Scholar, abstract, TLDR, citations, and fallback.
- Reader context row for current paper, active mode, selected passage, page/section context.
- English/Arabic translations and accessibility labels.

**Out of scope**:

- AI reranking, analytics, notifications, or remote recommendation service.
- Citation count as a fresh-paper ranking signal.
- New design system, gradients, or framework migration.
- Changing backend Paper shape unless a separate plan is approved.

## Steps

### Step 1: Establish the action hierarchy

Make the in-app Read workspace the primary paper action. Keep Quick explanation visible but secondary. Move external Open PDF to a clearly secondary link/overflow treatment. Add concise translated labels or tooltips that explain the difference without removing existing commands.

**Verify**: component tests assert all actions remain available, the primary action is visually/semantically distinct, and both languages expose accessible names.

### Step 2: Add deterministic Today’s picks

Implement the spike’s bounded strip above the regular list. Use deterministic recency/category/available metadata signals only, show category/date context, label the selection as heuristic, and provide per-session or per-day dismissal. Do not use citation counts for fresh-paper ranking.

**Verify**: unit tests cover deterministic ordering, fewer-than-five papers, duplicate avoidance, dismissal, category switching, and empty history.

### Step 3: Make provenance persistent on cards

Add compact labels for source and content type: abstract vs TLDR, citation data, and fallback status. Ensure the labels are direction-safe in Arabic and do not imply that citations equal quality. Keep the existing fallback notice for the list-level failure state.

**Verify**: English/Arabic component tests assert provenance labels and mixed-direction spans.

### Step 4: Clarify reader context and walkthrough progress

Add a compact metadata/context row showing paper identity, source, active tab, selected passage state, and current page/section where available. Add explicit completed/current/upcoming progress semantics while preserving Continue, Regenerate, Stop, and Ask behavior.

**Verify**: reader tests cover context changes, selected-passage Ask action, stopped/error/regenerated sections, and RTL layout labels.

## Test plan

- Deterministic picks and dismissal.
- Action hierarchy and accessible names.
- Abstract/TLDR/source/fallback provenance.
- Arabic mixed-direction metadata.
- Reader current mode, passage context, and walkthrough progress.

## Done criteria

- [ ] Users can quickly identify what to read today without hiding the normal feed.
- [ ] Read, Quick explanation, Open PDF, and Walkthrough have distinct meanings.
- [ ] Every paper’s source and summary provenance are visible where relevant.
- [ ] Reader context and walkthrough progress are understandable in EN and AR.
- [ ] Existing visual system and backend contracts remain intact.
- [ ] Full frontend gates pass.

## STOP conditions

- Deterministic ranking requires fields not present in the current Paper shape.
- A provenance label would assert a source or summary type that backend data cannot prove.
- The action hierarchy makes a current keyboard or screen-reader flow worse.
- Product stakeholders reject heuristic “Today’s picks” wording; stop before adding authoritative-sounding ranking.

## Maintenance notes

If OpenAlex or another source is added later, extend provenance as a typed capability rather than adding source-specific text branches. Keep fresh-paper ranking independent from citation counts because indexing is delayed.

## Evidence

- UX-01, UX-02, UX-03, UX-04, UX-05, UX-07, DIRECTION-01, and DIRECTION-03 from the redesign/deep audit.
- Existing `docs/spikes/curated-daily.md` design decision.

No secrets are included in this plan.
