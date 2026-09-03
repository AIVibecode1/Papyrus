# Day boundary: local time vs arXiv

Status: closed as "no change" on 2026-08-03 (plan 009). The day labels are
internally consistent; the skew against arXiv's own calendar is a labeling
artifact around midnight, not a bug in the latest-papers flow.

## Two clocks

1. **Labels and storage** (`src/stores/digest.ts:14`): `todayStr()` returns
   the LOCAL date (e.g. `2026-08-01`). All day labels, the digest storage
   keys (`papyrus-digest-v1`), and the reading-position keys use this same
   local clock. Internally everything is consistent: the same local date
   always maps to the same query window.
2. **Query windows and arXiv data** (`src-tauri/src/papers/arxiv.rs:30`):
   `build_fetch_url` narrows with `submittedDate:[YYYYMMDD TO next-day]` —
   a UTC-based range. arXiv timestamps (`published`) are UTC (`Z`), but
   arXiv's daily announcement day is US Eastern time.

## The skew

For a UTC+3 user (typical for the Arabic audience):

- Local `2026-08-01` spans UTC 2026-07-31 21:00 -> 2026-08-01 21:00.
- The query window `[20260801 TO 20260802]` covers UTC 2026-08-01 00:00 ->
  2026-08-02 00:00.
- ET (UTC-4 in summer) Aug 1 spans UTC Aug 1 04:00 -> Aug 2 04:00.

Consequences:

- The local "Aug 1" label covers ET Jul 31 20:00 -> Aug 1 20:00: all of
  arXiv's Aug 1 day except the final evening batch (20:00-24:00 ET), plus
  four hours of Jul 31 evening.
- Papers announced in that final evening batch (e.g. 22:00 ET Aug 1 = 02:00
  UTC Aug 2) appear under the local "Aug 2" label.
- The **latest view (no date filter) is unaffected**: it fetches newest
  first with no day window, so nothing is ever delayed or missing there.
- No duplication occurs between adjacent labels (a paper belongs to exactly
  one UTC window; the windows tile the timeline).

## Verdict

No user-visible bug in the default flow. The skew only shifts how the last
evening hours of arXiv's day are labeled for users east of UTC. Changing the
labels to arXiv's ET calendar would require timezone-aware formatting and
would shift every existing storage key, breaking the stability the local
clock provides. Not worth it for a reader.

## If ET alignment is ever wanted

Use `Intl.DateTimeFormat` with `timeZone: "America/New_York"` (available in
the webview, no dependency) to produce the label AND the query bounds, and
bump the digest storage key (`papyrus-digest-v2`) so old keys do not get
mislabeled. Revisit only if a user reports confusion about which day a paper
belongs to.
