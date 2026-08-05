# Papyrus audit plans — Round 4

Round-based audit log. Every round replaces the previous round's DONE
set with fresh numbering. Old plans stay in this directory as audit
history.

**Current round: 4** (plans 040–047).  
**Previous round: 3** (plans 032–037 — still TODO unless shipped).

## Goal of this round

Turn Papyrus from “latest arXiv digest + AI explainer” into a durable
**research assistant** closer to alphaXiv: search any era of papers,
take notes, connect a coding model (Codex) safely, and keep a polished
bilingual RTL/LTR experience on a maintainable architecture.

This round does **not** replace Round 3 work. If 032–036 are still open,
finish or deliberately defer them before 047 (release). Prefer:

1. Ship any already-green Round-3 fixes first.
2. Run Round-4 plans in the order below.
3. Use 047 as the release vehicle.

## Execution order and status

| Plan | Title                                                         | Priority | Effort | Depends on      | Status |
| ---- | ------------------------------------------------------------- | -------- | ------ | --------------- | ------ |
| 040  | Architecture foundations (shell, modules, design tokens)      | P0       | L      | —               | TODO   |
| 041  | Advanced search (old papers + search modes + filters)         | P0       | L      | 040             | TODO   |
| 042  | Note-taking system (paper notes, highlights, free notes)      | P0       | L      | 040             | TODO   |
| 043  | Codex safe auth + provider hardening                          | P1       | M      | 040             | TODO   |
| 044  | RTL / LTR experience + UI/UX fine-tune                        | P1       | M      | 040, 041, 042   | TODO   |
| 045  | Research-assistant depth (alphaXiv-style mentor features)     | P1       | M      | 041, 042, 043   | TODO   |
| 046  | Deep logic review of new modules + i18n parity                | P1       | M      | 041–045         | TODO   |
| 047  | Release vehicle (version bump + docs + gates)                 | P1       | M      | 040–046 subset  | TODO   |

## How an LLM agent must use these plans

Each plan file is written as an **implementation brief for an agent**:

1. Read the **Non-negotiables** and **Out of scope** first.
2. Follow **File map** and **Data models** exactly unless a plan revision is written.
3. Implement in the **Work units** order; each unit ends with a commit when green.
4. Run the **Verification gates** before moving to the next plan.
5. Never invent API keys, OAuth client secrets, or network endpoints that are not documented in the plan.
6. Preserve existing security contracts: OS keychain only, no key in webview, HTTPS for remote providers, markdown HTML escape, SSRF guards on PDF/fetch.

## Cross-cutting rules (apply to every plan)

- **Token-only UI**: no raw Tailwind color utilities for theme surfaces; use CSS variables / design tokens from `src/index.css`.
- **i18n**: every new user-visible string lands in `en.json` **and** `ar.json` in the same commit.
- **RTL**: use logical properties (`ms`/`me`/`ps`/`pe`/`start`/`end`), not `left`/`right`. Paper titles and math stay `dir="ltr"`.
- **Tests**: every new store/action and pure function gets unit tests; UI flows that can break RTL get component tests with `dir="rtl"`.
- **Commits**: one logical concern per commit; message format matches repo history (`feat(search): …`, `fix(rtl): …`, `perf(pdf): …`).
- **No scope creep**: if a nice idea is not in the plan, open a spike note under `docs/spikes/` instead of implementing it mid-plan.

## Dependency graph (simplified)

```
040 Architecture
 ├── 041 Search
 ├── 042 Notes
 └── 043 Codex auth
        │
        ├── 044 RTL/UX (needs shell + search chrome + notes surfaces)
        └── 045 Research depth (needs search + notes + auth)
                │
                └── 046 Logic review → 047 Release
```

## Already shipped context (do not re-do)

From Round 3 evidence (see `plans/README.md` history and commits on `main`):

- Black PDF pages fixed (fresh canvas per render run).
- Floating filter bar opacity/sticky fixed.
- Most-cited spinner honest completed/failed states.
- Version files already show `1.0.11` in some snapshots — confirm on disk before any bump in 047.

## Primary user outcomes after Round 4

1. User can search **historical** papers with clear modes (keyword, author, title, category+range, Semantic Scholar relevance).
2. User can attach **notes and highlights** to a paper and find them later.
3. User can connect **Codex / OpenAI coding models** via the existing provider system with the same keychain safety model (optional OAuth only if implemented as documented in 043).
4. Arabic and English both feel first-class; no layout breakage when switching direction.
5. Codebase has clearer feature boundaries so future LLM agents touch fewer files per change.
