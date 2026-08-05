# Papyrus audit plans

Round-based audit log. Every round replaces the previous round's DONE
set with fresh numbering. Old plans stay in this directory as audit
history. Current round: **3** (plans 032-037).

## Execution order and status

| Plan | Title                                                | Priority | Effort | Depends on | Status |
| ---- | ---------------------------------------------------- | -------- | ------ | ---------- | ------ |
| 032  | PDF viewer virtualization (kill the heavy feel)      | P1       | M      | 025, 028   | TODO   |
| 033  | Citation disk cache (7d TTL) + stale-serve           | P1       | S      | 030, 031   | TODO   |
| 034  | Design fine-tune pass                                | P2       | M      | 028        | TODO   |
| 035  | Search UX completion + CDP live suite                | P2       | S      | 030, 031   | TODO   |
| 036  | Deep code-logic review (digest/reader/settings/i18n) | P1       | L      | 029, 030   | TODO   |
| 037  | Release v1.0.11 + macOS delivery docs                | P1       | M      | 032-036    | TODO   |

## Already shipped in this round (live-verified, committed)

These fixes came out of round-3 evidence (CDP probes against the dev
preview and the built exe) and are already on `main`:

| Commit    | Fix                                                          | Evidence                                                           |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `7ef2056` | Black PDF pages: fresh canvas elements per render run        | 73/73 pages painted after load/resize/zoom on a real 74-page paper |
| `8467667` | Floating filter bar: opaque extended bar, no transparent gap | sticky delta 0 + elementFromPoint resolves to the bar              |
| `b614dbe` | Most-cited spinner forever: honest completed/failed states   | built app: hint now clears when the S2 batch fails                 |

## Rounds 1-2 (DONE)

Plans 001-024 shipped across v1.0.4-v1.0.8; plans 025-031 shipped in
v1.0.9-v1.0.10. Files remain as history.

## Dependency notes

- 032 must keep the fresh-canvas generation key (028) and the bounded
  settlement wait — those are what make the black-page fix hold.
- 033 extends the `known`-set skip in loadCitations (030) with the disk
  cache; it does not touch the `citationsLoading` flag semantics (031).
- 037 is the release vehicle: it must not land before 032-036 (or a
  documented subset) is green, and the macOS artifact + tag-workflow
  notes are part of its scope, not separate docs.
