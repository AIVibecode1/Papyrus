# Implementation Plans — Improve Deep Audit (2026-08-07)

Generated from a **deep** `/improve` pass on Papyrus **v1.1.8** (code dump; no live git HEAD available at plan time).

**Executor:** read each plan fully, honor STOP conditions, touch only in-scope files.  
**Do not** re-implement product features already shipped (notes, history, advanced search, theme polish, RTL toolbar center).

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 070 | Reconcile plans index + AGENTS.md to shipped 1.1.8 | P0 | S | — | DONE |
| 071 | Allowlist markdown link schemes before openUrl | P0 | S | — | TODO |
| 072 | Cap import payload size + deepen schema validation | P0 | M | — | TODO |
| 073 | Wire history lastPage + Continue-reading strip | P1 | M | — | TODO |
| 074 | Cap chat localStorage by paper-key count | P2 | S | — | TODO |
| 075 | Virtualize long paper / history / saved lists | P2 | M | — | TODO |
| 076 | CSP hardening spike (Tauri webview) | P2 | M | — | TODO |
| 077 | Add dependency audit gates to CI | P2 | S | — | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED

## Dependency notes

- **070 first** if any agent still treats Round-4 plans 040–047 as open work.
- **071** and **072** are independent security hardening; can run in parallel.
- **073** does not depend on 070 but benefits from accurate docs.
- **075** is larger UX/perf; do after 071–074 if capacity is limited.
- **076** is a spike: may conclude “keep csp null with documented rationale” — that is an acceptable DONE.

## Findings covered

| Audit # | Finding | Plan |
|---------|---------|------|
| 1, 7 | Plans/AGENTS drift | 070 |
| 2 | Markdown link schemes | 071 |
| 3, 8 | Import size + shallow schema | 072 |
| 6 + direction | lastPage + continue strip | 073 |
| 9 | Chat storage growth | 074 |
| 5 | List virtualization | 075 |
| 4 | CSP null | 076 |
| 10 | No audit in CI | 077 |

## Findings considered and deferred (not planned)

- User-configured AI base URLs (including loopback HTTP for Ollama) — by design.
- PDF SSRF pipeline — already guarded and tested.
- Full related-papers / collections / notes-MD-export product features — direction only; not in this audit batch unless requested later.
- Live `pnpm audit` results — run inside plan 077; not pre-claimed here.

## Commands (repo baseline)

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
node dev/check-release-integrity.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```
