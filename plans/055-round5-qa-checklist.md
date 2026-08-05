# Plan 055 — Round 5 QA checklist (agent + human)

**Priority:** P1 · **Effort:** S · **Depends on:** 050–054

## Automated gates

```bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm exec prettier --check .
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

## Search correctness (050)

- [ ] Live or fixture: query `Attention Is All You Need` → 1706.03762 on
      page 1 with limit-to-category **off**
- [ ] Query related to DeepSeek / known 2025 paper appears without
      requiring year chips
- [ ] Category browse still newest-first
- [ ] Limit-to-category **on** narrows results
- [ ] Clear search restores feed

## Search chrome (051)

- [ ] No gray rectangle under typed characters (light + dark)
- [ ] Dropdown open: no double slab
- [ ] AR layout: icon/clear on correct edges

## Reader copy (052)

- [ ] Select text → Ctrl/Cmd+C → paste in external editor works
- [ ] Floating Copy works when clipboard API is restricted (fallback)
- [ ] Find-in-page still works
- [ ] Highlight still saves selection

## OpenAI / ChatGPT truth (053)

- [ ] Settings never claim ChatGPT Plus login
- [ ] No password form for ChatGPT
- [ ] Browser open action works via opener
- [ ] Export has no API keys

## Design / dark (054)

- [ ] Dark: cards visible against background
- [ ] Muted text readable
- [ ] Sticky toolbar opaque
- [ ] EN + AR screenshots attached to PR

## Regression

- [ ] Notes hub still loads
- [ ] Citations honest empty state (no infinite spinner)
- [ ] PDF pages not black after load (Round 3 fix)

**Commit:** `test: round-5 QA notes and search relevance regressions`
(only if new automated tests were added; otherwise checklist lives in
the PR body)
