# dev/diagnostics — one-off live-verification harnesses

These scripts drive the built Papyrus exe through Chrome DevTools
Protocol (WebView2 remote debugging on port 9223). They are manual
diagnostic tools, not part of CI and not imported by anything.

| Script           | Purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `cdp-probe.mjs`  | Smoke probe: list page targets, collect console errors.       |
| `cdp-diag.mjs`   | Diagnose the ResizeObserver re-fit in the built app.          |
| `cdp-test.mjs`   | Full live test (v1.0.3 era): state, Arabic dates, PDF render. |
| `cdp-test2.mjs`  | Follow-up: canvas completion, split resize, settings nav.     |
| `cdp-verify.mjs` | v1.0.4 verification: resize re-fit, fixed split on stream.    |

Usage pattern: launch the built exe with `--remote-debugging-port=9223`,
then run e.g. `node dev/diagnostics/cdp-probe.mjs`.
