# Agent brief — Papyrus Round 5 (read this first)

Round 4 shipped. The user is **not** satisfied. Fix the real bugs
before more features.

## Priority order

1. **050** — Search must return archive papers (relevance sort + category limit default off). This is why DeepSeek Jan 2025 is missing.
2. **051** — Remove the gray rectangle under the search field/dropdown.
3. **052** — Native-feeling PDF copy (Ctrl/Cmd+C + floating actions).
4. **053** — Stop calling Codex a connectable model; **ChatGPT account login is not officially available** for in-app Plus. Clarify OpenAI **API key** path; optional open-in-browser; never scrape ChatGPT.
5. **054** — Real design push, **dark theme depth** first.
6. **055** QA → **056** release 1.1.1.

## One-line root causes

| Issue | Cause |
| ----- | ----- |
| Old papers missing | `finish_arxiv_url` always `sortBy=submittedDate`; `limit_to_category` defaults true |
| Gray search bar | Nested muted fills + Select/Input/autofill styling |
| Awkward copy | Toolbar-only copy; weak keyboard path |
| “Codex account” | Product misconception; 043 shipped API preset |
| Weak dark UI | Flat tokens, low elevation |

## Do not

- Build ChatGPT email/password login.
- “Fix” search only by raising page size.
- Start 054 before 050/051 if the user still cannot find papers.

## Start

Open `050-search-relevance-and-archive.md` and change Rust sort + defaults first; prove with a live query before UI polish.
