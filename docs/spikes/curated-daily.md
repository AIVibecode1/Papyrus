# Spike: Curated daily selection (plan 013, DIR-4)

> Design spike output — feeds a future build plan. When the maintainer
> picks it up, this document is the spec. No app code was changed by this
> spike.

## 0. The idea

The app already collects a per-day digest per category (the day picker).
"Curated daily selection" = one small, hand-picked list per day that
answers: _"of everything published recently, what should I actually read
today?"_ It is the app's editorial front page, grounded after provider
failover (plan 010) ships.

## 1. Live probe (2026-08-03) — the load-bearing fact

S2 batch probe for citation counts of one-day-old arXiv papers:

```
POST /graph/v1/paper/batch?fields=citationCount
ids: ["ARXIV:2607.29658", "ARXIV:1706.03762"]
```

- First attempt: **HTTP 429** (keyless pool, as documented in
  `second-source.md` §A).
- After a 20 s pause: `[{ "paperId": "...", "citationCount": 187165 }, null]`
  — the classic paper (`1706.03762`, 2017) returned 187,165 citations; the
  **one-day-old paper (`2607.29658`) returned null: not indexed yet**.

**Consequence:** a curated list of _yesterday's_ papers cannot rank by
citations — fresh papers are typically absent from S2 for a while (hours to
days). Any design that waits for S2 data before curating would produce an
empty list most mornings.

## 2. What the curated list can rank on (v1 candidates)

| Signal                                      | Source                         | Freshness                             | Cost                      | Verdict                                       |
| ------------------------------------------- | ------------------------------ | ------------------------------------- | ------------------------- | --------------------------------------------- |
| Citation count                              | S2 batch (already integrated)  | Poor for <2-day-old papers (probe §1) | Free (keyless, 429-prone) | Use for the _rising_ list, not the daily list |
| TLDR presence                               | S2                             | Same indexing lag                     | Free                      | Not available for fresh papers                |
| Recency                                     | arXiv (already fetched)        | Perfect                               | Free                      | Baseline                                      |
| Author reputation (prior papers' citations) | S2 per author                  | Needs 2-3 queries per candidate       | Free-ish                  | Too slow for v1                               |
| Venue/category mix                          | arXiv feed fields              | Perfect                               | Free                      | Cheap and honest                              |
| Download counts                             | arXiv API does not expose them | —                                     | —                         | Not available                                 |

**v1 ranking (recommended):** deterministic heuristics over the existing
per-day digests — e.g. 5 papers: 3 newest from the primary category, 1 from
a rotating secondary category, 1 "rising" pick (the paper with the highest
citation count among papers 3-14 days old in the digest window, which S2
usually has). No new network dependency, no key, works offline from the
digest the app already stores.

## 3. UX options

1. **A "Today" card at the top of the paper list** — a horizontal strip of
   5 compact cards above the normal list. Cost: S. Honest: it is clearly
   editorial, the full list is one scroll away.
2. **A dedicated tab** ("Selection" / "الاختيار اليومي") next to Papers.
   Cost: M. More prominent, but competes with the list view for attention.
3. **A daily notification** (Tauri notification plugin). Cost: M, and
   notification permission is a product decision — defer.

Recommendation: **option 1** — the strip. It needs no new navigation, works
in both languages, and can be dismissed.

## 4. Recommendation

Ship the **heuristic daily strip** (option 1, ranking §2) as a later plan.
The S2 citation signal joins the ranking when the paper is old enough for
S2 to have indexed it (the 3-14 day window). Provider failover (plan 010)
is already shipped, so a follow-up could optionally ask the AI provider to
re-rank the 5-10 candidates ("pick the 3 most interesting for a general
reader") — that is the _grounded_ step the direction note promised, and it
should be the first AI use that is not an on-demand explanation.

## 5. Effort

- Strip UI + i18n + store: S
- Ranking heuristics + unit tests: S
- Optional AI re-rank (uses the existing failover chain): S
- Total: **S-M** — smaller than plan 011 was.

## 6. Open questions

1. Should the strip respect the selected category, or be global? (v1:
   category-scoped — the digest is per category.)
2. When the user dismisses the strip, is it gone forever or per-day?
   (v1: per-day, re-appears tomorrow; dismissal persisted per date.)
3. Does the AI re-rank belong in the same plan or a follow-up? (v1:
   follow-up — the heuristic strip ships first, the AI polish builds on
   it once the strip proves useful.)
