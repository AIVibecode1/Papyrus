# Plan 020: Reduce PDF startup cost and test the reader boundary

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src/stores/reader.ts src/components/pdf-viewer/pdf-viewer.tsx src/lib/pdf-text.ts src/features/reader/__tests__ src/components/pdf-viewer/__tests__`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 019 recommended first
- **Category**: performance | tests
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

Opening a paper currently extracts PDF text in the reader store and separately loads the PDF document/pages in the viewer. Long papers therefore pay duplicate pdf.js parsing and retain a canvas/text layer for every page even when the user is reading only the first page. This increases first-open latency and memory pressure. The reader path also lacks one integration test that covers open, fetch, extraction, ready state, and cleanup together.

## Current state

- `src/stores/reader.ts:113-115` calls `extractTextFromPdf` during `open()`.
- `src/components/pdf-viewer/pdf-viewer.tsx:173-199` separately loads a pdf.js document and retrieves pages.
- `src/components/pdf-viewer/pdf-viewer.tsx:185-187` loads all pages before display.
- `src/components/pdf-viewer/pdf-viewer.tsx:666-690` mounts canvases and text layers for every page.
- `src/features/reader/__tests__/reader-view.test.tsx` mocks the PDF viewer and backend-adjacent modules; it does not exercise the complete open boundary.

## Commands you will need

| Purpose       | Command                                                                                                       | Expected |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| Viewer tests  | `pnpm exec vitest run src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx`                                | all pass |
| Reader tests  | `pnpm exec vitest run src/features/reader/__tests__/reader-view.test.tsx src/stores/__tests__/reader.test.ts` | all pass |
| Full frontend | `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run format:check`                               | all pass |

## Scope

**In scope**:

- PDF viewer/store boundary and existing tests
- A bounded page-window or deferred extraction design
- One deterministic reader integration test using fake PDF bytes/backend boundaries

**Out of scope**:

- Replacing pdf.js
- Changing PDF download security policy
- Changing user-visible reader controls or Paper shape
- Premature worker rewrite without measurements

## Steps

### Step 1: Measure before changing architecture

Instrument test-only timing/count hooks to record how many `getDocument`, `getPage`, text extraction, canvas mount, and render calls occur for a representative short and long fixture. Do not add production logging of document content or URLs.

**Verify**: tests produce deterministic call counts and confirm the current duplicate parse behavior.

### Step 2: Choose one bounded optimization

Prefer deferring whole-paper text extraction until the user starts Walkthrough or Ask, unless opening the reader currently requires it for a documented UI state. If extraction must remain eager, design a shared document abstraction with clear ownership and cleanup. Do not share a `PDFDocumentProxy` across components without a lifecycle owner.

**Verify**: the chosen design reduces duplicate parse calls in tests and preserves ready/error behavior.

### Step 3: Add page virtualization only after characterization

If measurements show long-document startup/memory cost is material, mount a bounded visible-page window with stable placeholders and overscan. Preserve page navigation, find-in-page, text selection, position restore, resize cancellation, and Arabic toolbar behavior. If a reliable page-height placeholder cannot be implemented with the current viewer, STOP and report rather than shipping a partial virtualization layer.

**Verify**: short PDF visual behavior remains unchanged; long fixture mounts only the bounded window; page navigation and restore tests pass.

### Step 4: Add one reader boundary integration test

Use existing mocks and fake PDF fixtures to exercise `ReaderView → reader.open → getPdfBytes → extractTextFromPdf → ready`. Assert loading, failure cleanup, stale-open suppression, and retry behavior. Keep it deterministic and offline.

**Verify**: the integration test passes without mocking away the store/open transition itself.

## Test plan

- Call-count characterization for short/long PDF.
- Deferred extraction or shared-document lifecycle.
- Page-window mount bounds and overscan.
- Search, selection, navigation, resize, retry, and position restore.
- Full reader boundary integration.

## Done criteria

- [ ] Duplicate PDF parse work is removed or explicitly deferred.
- [ ] Long documents do not mount unbounded page DOM/canvas work.
- [ ] Existing reader behavior remains covered.
- [ ] Reader open/fetch/extract/ready integration test exists.
- [ ] Full frontend gates pass.

## STOP conditions

- Measurements do not show material cost; prefer no virtualization and report the evidence.
- Shared pdf.js ownership introduces use-after-destroy or stale page proxy behavior.
- Virtualization breaks selection/search/position restore and cannot be repaired with bounded scope.
- A fix requires changing public command payloads or persisted reader data.

## Maintenance notes

Keep the pdf.js document lifetime owned by one module. Any future extraction, search, or walkthrough feature must declare whether it uses the viewer document, a separate document, or deferred bytes parsing.

## Evidence

- Frontend audit findings PERFORMANCE-01, PERFORMANCE-02, and TEST-01.
- Existing reader and viewer test files identified during the deep audit.

No secrets are included in this plan.
