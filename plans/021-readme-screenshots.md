# Plan 021: Deliver the promised README screenshots (EN/AR, light/dark)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: the repo has **no git commits yet**. Compare
> the "Current state" excerpts against the live files; on any mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (app is feature-complete; screenshots can be captured now)
- **Category**: docs
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

README.md:27 says `## Screenshots` / `Coming soon.` REF2.md:76 (the
original plan) promised "README with screenshots in both languages". For a
visual, bilingual (Arabic RTL + dark mode) OSS app about to be published,
screenshots are the primary first-impression artifact — and the placeholder
is the first thing a README visitor sees.

## Current state

- `README.md:26-28`:

```md
## Screenshots

Coming soon.
```

- The app renders: paper list (sidebar + cards), Explain panel with
  streaming text, Settings (providers), Arabic full-RTL mode, dark mode.

## Commands you will need

| Purpose        | Command                     | Expected on success |
| -------------- | --------------------------- | ------------------- |
| Dev server     | `pnpm dev` (background)     | serves :1420        |
| Mock AI server | `pnpm mock-ai` (background) | serves :8765        |
| Typecheck      | `pnpm exec tsc --noEmit`    | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `README.md`
- `docs/screenshots/` (create; store PNGs there)

**Out of scope** (do NOT touch):

- App code; any other docs.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Prepare the app for capture

- Start `pnpm dev` and `pnpm mock-ai` (background).
- In the browser at `http://localhost:1420`:
  1. Add the mock provider in Settings (Base URL `http://localhost:8765/v1`,
     model `mock-model`, any key) so the Explain panel shows live streaming.
  2. For the Arabic screenshots, switch to Arabic (عربي) — full RTL.

### Step 2: Capture the four screenshots

Capture (via your environment's screenshot tooling — browser devtools
screenshot, or an OS screenshot tool; a 1280×800 viewport is a good
default):

1. `papers-en-light.png` — paper list, English, light theme.
2. `papers-en-dark.png` — paper list, English, dark theme.
3. `explain-ar-dark.png` — one paper expanded with a streamed explanation
   (run the mock explanation first so text is present), Arabic, dark theme.
4. `settings-ar-light.png` — Settings page with the mock provider card,
   Arabic, light theme.

Save them under `docs/screenshots/`. If the capture environment can't
produce PNGs, produce the best available format and convert; if no capture
is possible at all, STOP and report (this plan is blocked on tooling, not
on the app).

**Verify**: 4 PNG files exist in `docs/screenshots/`, each ≥ 50 KB
(indicating real content, not blank captures).

### Step 3: Wire into the README

Replace the placeholder:

```md
## Screenshots

| Papers (EN)                                     | Explanation (AR, dark)                               |
| ----------------------------------------------- | ---------------------------------------------------- |
| ![Papers](docs/screenshots/papers-en-light.png) | ![Explanation](docs/screenshots/explain-ar-dark.png) |

| Settings (AR)                                       | Dark mode (EN)                               |
| --------------------------------------------------- | -------------------------------------------- |
| ![Settings](docs/screenshots/settings-ar-light.png) | ![Dark](docs/screenshots/papers-en-dark.png) |
```

(Adjust layout to taste — two-by-two table or stacked; keep relative paths
so GitHub renders them.)

**Verify**: `README.md` contains no "Coming soon" and all four image paths
resolve (`ls docs/screenshots/`).

## Test plan

- None (docs). Verification: paths resolve, README renders.

## Done criteria

- [ ] `docs/screenshots/` contains the 4 PNGs (or documented substitutes)
- [ ] `README.md` "Screenshots" section shows them; no "Coming soon"
- [ ] No app code modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- No screenshot capture tool is available in the environment — report;
  the plan can be executed later by the operator (it's docs-only).
- The Arabic screenshot shows layout bugs (RTL breakage) — do NOT commit
  broken-looking screenshots; report the visual defect instead (that's a
  real bug finding, likely in the RTL CSS).

## Maintenance notes

- Screenshots go stale as the UI evolves — refresh them in the same PR
  that changes visible UI.
- When the app gets real branding (icon already done), the screenshots
  should match.
