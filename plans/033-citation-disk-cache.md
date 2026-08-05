# Plan 033 — Citation counts: disk cache + honest states (Most-cited works)

**Priority:** P1 · **Effort:** S · **Depends on:** 030, 031 (skip-known batch; the loading-flag fix is already in `b614dbe`)

## Problem (live evidence)

Semantic Scholar's keyless batch pool 429s often. In the built app,
after a search + "Most cited", the batch resolved empty and the UI spun
"Citation counts are loading…" forever — the sort never reordered.
`b614dbe` fixed the eternal spinner (honest "unavailable" state + a
generation token). What remains: the counts themselves are lost every
time, so "Most cited" still cannot reorder on S2 outage days.

## Approach

1. **Disk cache with TTL** (7 days) in the Rust backend: `fetch_citations`
   writes the returned map to the app-data dir (`papyrus/citations.json`),
   reads it back on startup, and serves cached counts for ids older than
   the TTL without hitting S2. Survives restarts and short S2 outages.
2. Merge order in `loadCitations`: seed (Scholar payload) > disk cache >
   live batch; the batch only runs for ids still unknown (already the
   case via the `known` set — extend it with the cache).
3. When the live batch fails (429 after retries) but the cache has stale
   (> TTL) counts, serve the stale ones with the "unavailable" hint
   suppressed (counts are better than none; the hint text stays for the
   zero-data case).
4. Keep `citationsLoading` semantics from `b614dbe` untouched.

## Verification gates

- Rust unit tests: cache write/read round-trip, TTL expiry, stale-serve
  on batch failure, corrupted-file recovery (returns empty, never panics).
- `cargo test --lib`, clippy `-D warnings`, fmt check; full frontend gates.
- Exe live check: kill network for S2 (or run twice) — counts persist
  across a restart.

## Commit strategy

One commit: `feat(citations): disk cache (7d TTL) + stale-serve on S2
outage — Most-cited survives restarts`.
