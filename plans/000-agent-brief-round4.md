# Agent brief — Papyrus Round 4 (read this first)

You are implementing enhancements for **Papyrus**, a Tauri 2 + React
desktop research assistant (arXiv / Semantic Scholar + BYO AI). The
product goal is closer parity with tools like **alphaXiv**: find papers
(including old ones), read PDFs in-app, get grounded explanations, and
capture notes — all local-first, bilingual EN/AR, RTL-safe.

## Source of truth

| Doc | Use |
| --- | --- |
| `plans/README.md` | Order, status, cross-cutting rules |
| `040` … `047` | Detailed implementation briefs |
| Existing `plans/032`–`037` | Prior round; do not ignore unfinished P0 PDF work |
| `docs/architecture.md` | Created in 040 |

## User priorities (mapped to plans)

| User ask | Plan |
| -------- | ---- |
| Overall architecture for UI/UX + codebase | **040**, **044** |
| Search functions + old papers + variety of choices | **041** |
| RTL and LTR experience | **044** (and rules in every plan) |
| Note taking | **042** |
| Connect to Codex safely (auth) | **043** |
| Research assistant depth | **045** |
| Ship safely | **046** review, **047** release |

## Hard security rules (never violate)

1. API keys only in OS keychain via Rust; never in webview storage.
2. No generic filesystem API for the webview.
3. Remote providers HTTPS (loopback HTTP only).
4. Markdown pipeline escapes HTML; mermaid `securityLevel: "strict"`.
5. arXiv/S2 query strings sanitized in Rust.
6. Export must not contain secrets.

## Implementation order

```
040 Architecture foundations
 → 041 Search  →  042 Notes  →  043 Codex
 → 044 RTL/UX
 → 045 Research depth
 → 046 Logic review
 → 047 Release
```

041 and 042 can proceed in parallel after 040 if two agents coordinate
on `papers` store conflicts; prefer sequential on one agent.

## Definition of done (Round 4)

- [ ] Fielded search + year range works on arXiv; clear/Esc restores feed
- [ ] Notes + highlights persist in app data; hub lists them
- [ ] Codex/OpenAI preset uses keychain; export has no keys
- [ ] AR and EN layouts correct on papers, search, notes, reader
- [ ] Reader panel tabs do not break streaming stop
- [ ] All CI gates green; release notes written

## What not to do

- Do not rebuild the app as a web SaaS.
- Do not add analytics that phone home paper titles.
- Do not invent OAuth client secrets.
- Do not remove existing category digest / day browse (search **adds**
  capability).
- Do not ignore Round 3 PDF virtualization if the app still feels heavy
  on long papers — schedule 032 before or with 047 if still open.

## Voice and i18n

- New strings: `en.json` + `ar.json` same commit.
- Arabic UI already exists; match tone of existing `ar.json` entries.
- Paper scientific titles stay LTR.

## Starting command checklist

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Then open `040-architecture-foundations.md` and execute Work unit 0.
