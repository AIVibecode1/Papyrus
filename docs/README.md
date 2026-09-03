# Docs

This maps the docs so you open the right file first.

- `architecture.md` — start here. Feature layout, backend modules, IPC
  rules, runtime flows, security contracts, how to add a feature.
- `features.md` — full feature list (README keeps the condensed table).
- `usage.md` — setup, reading, paper history, how explanations work.
- `security.md` — the security notes in full.
- `development.md` — prereqs, commands, mock server, tests, prompts.
- `technical-choices.md` — the decision table in full.
- `research/` — short investigation notes with a verdict. Timezone and
  day-boundary analysis; archived early-stage API surveys (marked, do
  not follow the outdated parts).
- `spikes/` — design spikes behind shipped or deferred features. Each
  one records the decision and the evidence; the build plans in
  `plans/` turned the accepted ones into code.
- `archive/` — frozen records. Read-only.
- `screenshots/` — README screenshots, regenerated via
  `dev/capture-screenshots.mjs` (see README, Development).

Build plans live in `plans/` (one per change, frozen once landed).
Release history lives in `release.md` (append-only; old sections are
never edited).
