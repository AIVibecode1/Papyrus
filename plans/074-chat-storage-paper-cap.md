# Plan 074: Cap persisted reader chat by number of papers

> **Executor instructions**: Chat remains best-effort localStorage. Do not move chat to Rust in this plan.
>
> **Drift check**: Read `src/stores/reader.ts` for `CHAT_STORAGE_KEY`, `CHAT_PERSIST_LIMIT`, `persistChat` / `loadChat`.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: Papyrus snapshot v1.1.8 (2026-08-07)

## Why this matters

Each paper keeps up to 30 messages in one JSON object in localStorage. There is no cap on **how many paper ids** are stored. Heavy users can accumulate a large blob, slowing parse on every load.

## Current state

```ts
// reader.ts (pattern)
const CHAT_STORAGE_KEY = "papyrus-reader-chat-v1";
const CHAT_PERSIST_LIMIT = 30; // messages per paper
// persistChat writes raw[paperId] = messages.slice(-LIMIT)
// no max keys
```

Walkthrough persistence already limits papers (`WALKTHROUGH_PERSIST_LIMIT = 5`) — mirror that idea for chat with a higher cap (e.g. 40–50 papers).

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `pnpm test -- src/stores/__tests__/reader` | pass |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**

- `src/stores/reader.ts`
- Reader store tests

**Out of scope**

- Migrating chat to disk via Tauri
- Changing per-paper message limit unless needed
- Export format changes (export already slices turns)

## Git workflow

- Branch: `advisor/074-chat-paper-cap`
- Commit: `fix(reader): cap persisted chat transcripts by paper count`

## Steps

### Step 1: Add `CHAT_PAPER_LIMIT` (e.g. 40)

On `persistChat`:

1. Write the current paper’s messages as today.
2. If `Object.keys(raw).length > CHAT_PAPER_LIMIT`, delete oldest keys.

**Oldest policy:** if entries lack timestamps, use **LRU via reorder**: move active `paperId` to a tracked order array, or store `updatedAt` per paper when saving. Simplest acceptable approach: keep an array of paper ids in access order in the same localStorage key wrapper:

```ts
// optional shape migration
{ "v": 2, "order": ["id1","id2"], "byId": { ... } }
```

If migration is too heavy, document a simpler approach: when over cap, delete arbitrary excess keys **except** the active paper (still better than unbounded). Prefer order-based eviction.

**Verify**: unit test fills > limit papers, persists, assert key count ≤ limit and active paper retained.

### Step 2: loadChat tolerates old and new shapes

- Old: `Record<paperId, messages[]>`
- New: versioned wrapper if you introduce one

**Verify**: load from legacy fixture still returns messages.

## Test plan

- Persist 45 papers → ≤ limit keys
- Active paper not evicted on its own write
- Legacy JSON still loads

## Done criteria

- [ ] Hard cap on number of paper ids in chat storage
- [ ] Tests cover eviction + legacy load
- [ ] `pnpm typecheck` exits 0

## STOP conditions

- Chat persistence already moved off localStorage in newer code — adapt to the new store or STOP.
- Quota errors require user messaging — out of scope beyond best-effort catch.

## Maintenance notes

- Export chat section should still iterate remaining keys only.
- Align limit with product expectations in a one-line comment next to the constant.
