# Plan 022: Make settings errors and mixed RTL content explicit

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src/features/settings/provider-form.tsx src/features/settings/provider-card.tsx src/features/settings/settings-page.tsx src/features/papers/paper-card.tsx src/i18n/locales/en.json src/i18n/locales/ar.json`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: UX | accessibility | correctness
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

Provider setup is a high-consequence flow, but invalid fields can currently fail silently and save failures are not rendered by the form. Mixed URLs, model IDs, dates, counts, and translated labels also remain fragile inside Arabic layout. This violates the project’s explicit requirement for inline actionable errors and risks users misreading exact provider metadata.

## Current state

- `src/features/settings/provider-form.tsx:56-79` returns on empty URL/model and wraps save without presenting failures.
- `src/features/settings/provider-card.tsx:83-123` groups Test, Use, Edit, Delete and displays raw test errors without structured guidance.
- `src/features/settings/settings-page.tsx:118-203` interleaves Appearance, source, export, and provider management.
- `src/features/papers/paper-card.tsx:87-129` mixes dates, authors, separators, translated labels, and English identifiers.
- `src/features/settings/provider-card.tsx:109-110` renders URL/model text without an explicit direction wrapper.
- `AGENTS.md` requires logical CSS and inline error states; current `src/index.css` and existing components already provide the palette/focus primitives to reuse.

## Scope

**In scope**:

- Provider form validation and visible save errors.
- Structured test-provider error categories without exposing secrets.
- Task-oriented Settings grouping and active-provider clarity.
- Direction-safe spans for URLs, model IDs, dates, counts, provider names, and paper metadata.
- English/Arabic translations and tests.

**Out of scope**:

- Keychain storage changes.
- Provider API protocol changes.
- New design system or icon library.
- Raw provider error bodies or credential values in UI.

## Steps

### Step 1: Add inline provider form validation

Validate required fields before save, associate messages with fields, use `aria-describedby`, and expose save/keychain failures through an `aria-live` region. Preserve the form’s existing preset/custom URL rules.

**Verify**: provider form tests cover missing model/URL, invalid custom URL, save failure, successful save, and Arabic messages.

### Step 2: Categorize provider test failures

Map safe error classes to translated guidance: URL/configuration, authentication/key, network/timeout, unsupported model, and unknown. Redact or truncate provider details before display. Keep the existing backend redaction contract.

**Verify**: tests assert each category and ensure a token-shaped secret never appears in rendered output.

### Step 3: Reorganize Settings sections

Visually group Appearance, Paper source, Data, and AI providers. Make active-provider selection a clear control and keep Test secondary to Use/Edit. Make destructive deletion state explicit and accessible without changing keychain behavior.

**Verify**: settings tests assert headings, active state, actions, deletion confirmation, and keyboard focus order.

### Step 4: Audit mixed-direction boundaries

Use separate spans with `dir="ltr"` for URLs, model IDs, arXiv IDs, counts, and dates where appropriate; use `dir="auto"` for natural-language titles/abstracts. Avoid concatenating exact metadata and translated labels into one bidirectional text node.

**Verify**: Arabic component tests assert direction attributes and visual snapshot/manual verification covers cards, settings, and reader toolbar.

## Done criteria

- [ ] Empty/invalid provider fields show actionable inline errors.
- [ ] Save and test failures are visible without secrets.
- [ ] Settings sections and active provider are unambiguous.
- [ ] Mixed RTL/LTR metadata has explicit direction boundaries.
- [ ] English and Arabic tests pass.
- [ ] Full frontend gates pass.

## STOP conditions

- The provider backend returns error text that cannot be categorized without exposing sensitive data; report the contract gap.
- A direction fix changes exact paper title reading order; add a focused fixture before proceeding.
- Destructive confirmation cannot be made accessible with current button/dialog primitives; report before adding a new dependency.

## Maintenance notes

Every new provider field needs validation, translated errors, key-safe rendering, and a direction decision. Keep product names and model IDs direction-safe in all locales.

## Evidence

- UX-06, UX-07, RTL-01 from the redesign/deep audit.

No secrets are included in this plan.

## Related plans

- Plan 018 governs AI error and stream contracts.
- Plan 021 governs card provenance and action hierarchy.

## Verification baseline

```text
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run format:check
```

All must exit 0.
