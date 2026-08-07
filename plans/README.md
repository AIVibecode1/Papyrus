# Papyrus plans index

Round-based audit log. Old plans stay in this directory as history; this
index is the single source of truth for what is open, shipped, or
superseded.

**Current product version: 1.1.8** (package.json / tauri.conf.json /
Cargo.toml are kept in sync; `node dev/check-release-integrity.mjs`
verifies).

## Active / next

The current batch is the 2026-08-07 deep improve audit. See
`plans/AUDIT-IMPROVE-README.md` for the full index and findings; the
table below mirrors its status column.

| Plan | Title | Priority | Effort | Status |
|------|-------|----------|--------|--------|
| 070 | Reconcile plans index + AGENTS.md to shipped 1.1.8 | P0 | S | IN PROGRESS |
| 071 | Allowlist markdown link schemes before openUrl | P0 | S | TODO |
| 072 | Cap import payload size + deepen schema validation | P0 | M | TODO |
| 073 | Wire history lastPage + Continue-reading strip | P1 | M | TODO |
| 074 | Cap chat localStorage by paper-key count | P2 | S | TODO |
| 075 | Virtualize long paper / history / saved lists | P2 | M | TODO |
| 076 | CSP hardening spike (Tauri webview) | P2 | M | TODO |
| 077 | Add dependency audit gates to CI | P2 | S | TODO |

## Superseded / shipped

Round 4 (040–047) and Round 5 (050–063) were implemented across
v1.0.x–v1.1.8. The rows below use **SUPERSEDED** where the code shipped
without the plan file being checked off, **DONE** where the plan was
formally completed. Do not re-implement any of these.

| Plan | Title | Status | Landed in |
|------|-------|--------|-----------|
| 040 | Architecture foundations (shell, modules, design tokens) | DONE | v1.0.x |
| 041 | Advanced search (old papers + search modes + filters) | SUPERSEDED | v1.0.x (fields, years, limit-to-category, relevance/sort) |
| 042 | Note-taking system (paper notes, highlights, free notes) | SUPERSEDED | v1.0.x (`notes.rs`, notes store/UI) |
| 043 | Codex safe auth + provider hardening | SUPERSEDED | v1.0.x (OpenAI-compatible provider system; OAuth never implemented by design) |
| 044 | RTL / LTR experience + UI/UX fine-tune | DONE | v1.0.x |
| 045 | Research-assistant depth (alphaXiv-style mentor features) | SUPERSEDED | v1.0.x (overview, walkthrough, ask, synthesis) |
| 046 | Deep logic review of new modules + i18n parity | DONE | v1.0.x |
| 047 | Release vehicle (version bump + docs + gates) | DONE | v1.0.x |
| 050 | Search relevance and archive | DONE | v1.0.x |
| 051 | Search chrome visual fix | DONE | v1.0.x |
| 052 | Reader copy / paste UX | DONE | v1.0.x |
| 053 | OpenAI account truth and auth | DONE | v1.0.x |
| 054 | Design and dark theme push | DONE | v1.0.x |
| 055 | Round 5 QA checklist | DONE | v1.0.x |
| 056 | Round 5 release | DONE | v1.0.x |
| 060 | Reading history | DONE | v1.1.2 (`history.rs`, history store/UI, settings clear, export/import) |
| 062 | Light and sepia theme polish | DONE | v1.1.3 |
| 063 | RTL search toolbar center | DONE | v1.1.4–1.1.5 (icon-only actions with tooltips; status cluster fills its track in v1.1.8) |

## Cross-cutting rules (apply to every plan)

- **Security**: OS keychain only for keys, HTTPS for remote providers,
  SSRF guards on PDF/fetch, markdown HTML escape.
- **i18n**: every new user-visible string lands in `en.json` **and**
  `ar.json` in the same commit.
- **RTL**: logical properties (`ms`/`me`/`ps`/`pe`/`start`/`end`), not
  `left`/`right`. Paper titles and math stay `dir="ltr"`.
- **Tests**: new stores/actions/pure functions get unit tests; UI flows
  that can break RTL get component tests with `dir="rtl"`.
- **Commits**: one logical concern per commit; message format matches
  repo history (`feat(search): …`, `fix(rtl): …`).
- **No scope creep**: if a nice idea is not in a plan, open a spike note
  instead of implementing it mid-plan.

## Maintenance notes

- After each release, update this index (shipped rows) in the same PR as
  the version bump.
- Product plan numbers (060+) and audit plan numbers (070+) coexist; the
  Active table lists only truly open work.
