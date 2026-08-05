# Papyrus audit plans — Round 5 (post-1.1.0 feedback)

Round 4 shipped architecture, fielded search, notes, and a provider
preset. Live use exposed **product and correctness gaps**. This round
fixes those gaps; it does not invent new product pillars.

## User-reported issues → plans

| # | User report | Root cause (code) | Plan |
| - | ----------- | ----------------- | ---- |
| 1 | Search finds only “latest”; DeepSeek Jan 2025 missing | arXiv URL always `sortBy=submittedDate`; `limitToCategory` defaults **true** | **050** |
| 2 | Gray rectangle under search text / dropdown | Search chrome + Select/Input muted fills, autofill, nested `bg-muted` | **051** |
| 3 | Copy/paste from PDF reader is awkward | Selection → toolbar-only copy; fragile clipboard; text-layer UX | **052** |
| 4 | “Codex” is an OpenAI **app**, not a model; want ChatGPT **account** | Plan 043 shipped API model preset; ChatGPT consumer login is not an official API | **053** |
| 5 | Design still needs a big push | Incremental token tweaks only | **054** |
| 6 | Themes weak, especially dark | Dark palette too flat / low hierarchy | **054** (dark focus) + **055** QA |

## Execution order

```
050 Search correctness (P0 — product broken)
051 Search chrome visual fix (P0 — daily annoyance)
052 Reader copy/paste (P1)
053 ChatGPT / OpenAI account truth + auth path (P1)
054 Design + dark theme push (P1)
055 Visual QA checklist + regression tests (P1)
056 Release 1.1.x / 1.2.0
```

## Non-negotiables (still apply)

- Keys only in OS keychain; no secrets in export.
- No ChatGPT web scraping / session-cookie auth.
- arXiv query sanitization stays in Rust.
- EN + AR strings same commit.
- Logical CSS for RTL.

## Agent start

Read `050-search-relevance-and-archive.md` first. Do not start design work
until search returns known archive papers in the first page of results.
