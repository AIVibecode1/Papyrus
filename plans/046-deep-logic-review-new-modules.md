# Plan 046 — Deep logic review of Round-4 modules + regression pass

**Priority:** P1 · **Effort:** M · **Depends on:** 041–045

## Purpose

Rounds 1–3 proved that green unit tests can still ship races (black
pages, eternal spinner, floating bar). After search, notes, Codex, and
reader tabs land, run a **line-oriented** review of new code with the
same suspicion.

## Scope

| Module | Focus questions |
| ------ | --------------- |
| `papers.rs` search | Injection, year bounds, empty query, pagination `start` with fielded queries |
| `notes.rs` | Corrupt file, concurrent upsert, size limits, path traversal in ids |
| `stores/papers.ts` | clearSearch vs day restore; loadMore with new params; double refresh |
| `stores/notes.ts` | load once vs reload; upsert race; filter stability |
| `stores/reader.ts` | tab switches vs streaming generation; stop CAS still valid |
| Settings Codex | key delete leaves UI consistent; test_provider abort |
| i18n | parity script green; no missing keys on new screens |
| Capabilities | `default.json` still least privilege; no FS scope creep |
| Export/import | notes merge; no secrets |

## Method (agent procedure)

For each module:

1. Read the file end-to-end.
2. List findings as bullets (`findings:` in commit body).
3. Fix each finding with a regression test when possible.
4. One commit per module group (or per severe bug).

## Specific race checks

1. **Search debounce + clear:** clear during in-flight fetch must not
   paint stale results (generation token or request id).
2. **Notes upsert while listing:** list should not drop optimistic row
   incorrectly.
3. **Reader tab + stop:** stop_explaining only cancels the active
   operation id.
4. **Import notes + open paper:** missing paperId still shows note.

## Verification gates

```bash
pnpm run typecheck && pnpm run lint && pnpm test
pnpm exec prettier --check .
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
node dev/check-release-integrity.mjs  # if present
```

If CDP scripts from 035 exist, run them against dev preview.

## Commit strategy

- `fix(search): …` / `fix(notes): …` / `fix(reader): …` per finding group
- Final: `test: round-4 regression pack for search notes reader`

## Agent anti-patterns

- Do not “refactor for beauty” unrelated modules.
- Do not silence clippy with broad allows.
- Do not mark findings fixed without a test or a concrete repro steps
  note when untestable.
