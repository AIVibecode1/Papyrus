# Papyrus Improvement Plan (Self-Contained)

> **For the executing agent**
>
> You do **not** have access to any files under `plans/`. This document is the
> **only** plan. Follow it in order. Do not skip verification. Do not improvise
> architecture. If a step fails its verification, **STOP** and report the exact
> error — do not continue to the next phase.
>
> **Project root**: the Papyrus repository (Tauri 2 + React 19 + Vite + pnpm).
> **Current version**: 1.0.9 (see `package.json` and `src-tauri/tauri.conf.json`).
>
> **Language**: write code comments in English. Do not change Arabic/English
> i18n voice rules. Do not introduce hype marketing copy.

---

## 0. Goals (what “done” means)

When this plan is finished, all of the following must be true:

1. Clicking **Explain**, **section mentor (Continue)**, or **Ask** never shows:
   `invalid args provider for command …: missing field base_url`
2. Opening a PDF and resizing/zooming does **not** leave persistent black pages.
3. Settings → Providers is clearer: guided add flow, status chips, test results.
4. The three known correctness bugs (rate limit, loadMore race, reader.stop) are fixed.
5. `pnpm test`, `pnpm run typecheck`, and `cargo test --manifest-path src-tauri/Cargo.toml --lib` all pass.

---

## 1. Project map (read these files first)

Before writing any code, open and read:

| Path | Why |
|------|-----|
| `src/lib/types.ts` | Frontend `ProviderConfig` uses `baseUrl` (camelCase) |
| `src-tauri/src/ai/mod.rs` | Rust `ProviderConfig` uses `base_url` (snake_case) — **BUG** |
| `src/lib/reader-ai.ts` | Invokes `explain_section` / `explain_synthesis` / `ask_about_paper` with raw `provider` |
| `src/lib/ai.ts` | Browser + Tauri AI helpers, `normalizeBaseUrl`, operation ids |
| `src/stores/settings.ts` | Providers stored in localStorage; `testProvider` invoke |
| `src/components/pdf-viewer/pdf-viewer.tsx` | PDF render races → black pages |
| `src/lib/pdf.ts` | How PDF bytes reach the viewer |
| `src-tauri/src/pdf.rs` | Rust PDF fetch + disk cache |
| `src/features/settings/settings-page.tsx` | Settings UI shell |
| `src/features/settings/provider-form.tsx` | Add/edit provider form |
| `src/features/settings/provider-card.tsx` | Provider row/card |
| `src/features/reader/reader-view.tsx` | Reader layout + AI panel |
| `src/stores/reader.ts` | Reader state, stop, streams |
| `src/stores/papers.ts` | `refresh` / `loadMore` / request sequencing |
| `src-tauri/src/papers.rs` | arXiv/S2 fetch + `rate_limit` |
| `src/index.css` | Themes (light / sepia / dark) |
| `package.json` | Scripts: `pnpm test`, `pnpm run typecheck` |

---

## 2. Phase A — Fix provider IPC crash (MUST DO FIRST)

### A.1 Problem (do not skip)

- TypeScript `ProviderConfig` fields: `id`, `name`, `baseUrl`, `model`
- Rust `ProviderConfig` fields: `id`, `name`, `base_url`, `model`
- `Paper` in Rust already has `#[serde(rename_all = "camelCase")]`
- `ProviderConfig` in Rust does **not**
- Frontend passes `{ baseUrl: "..." }` → Serde looks for `base_url` → error:
  `missing field base_url`

This breaks:
- `explain_section`
- `explain_synthesis`
- `ask_about_paper`
- `test_provider`
- and any path that sends a single `provider` object

`explain_paper` sends `providers: Vec<ProviderConfig>` and is affected the same way.

### A.2 Fix (Rust — preferred, single source of truth)

**File**: `src-tauri/src/ai/mod.rs`

Find:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
}
```

Change to:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
}
```

**Do not** rename the Rust field to `baseUrl`. Keep `base_url` in Rust code; only the JSON wire name becomes `baseUrl`.

### A.3 Defense in depth (TypeScript)

**File**: `src/lib/ai.ts` (or a tiny helper next to it)

Add:

```ts
/** Shape expected by Rust after serde rename_all = "camelCase". */
export function toIpcProvider(p: ProviderConfig): {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
} {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
  };
}
```

**File**: `src/lib/reader-ai.ts`

In every `invoke(...)` that sends `provider`, wrap it:

```ts
provider: toIpcProvider(provider),
```

**File**: `src/stores/settings.ts`

In `testProvider` when calling Tauri:

```ts
return invoke<string>("test_provider", { provider: toIpcProvider(p) });
```

**File**: `src/lib/ai.ts` (or wherever `explain_paper` / failover is invoked from the frontend)

If any code sends `providers: ProviderConfig[]`, map with `toIpcProvider`.

### A.4 Automated test (Rust)

In the Rust test module that already covers AI (or a new test in `src-tauri/src/ai/mod.rs` / `commands` tests), add:

```rust
#[test]
fn provider_config_deserializes_camel_case_json() {
    let json = r#"{
        "id": "p1",
        "name": "DeepSeek",
        "baseUrl": "https://api.deepseek.com/v1",
        "model": "deepseek-chat"
    }"#;
    let p: ProviderConfig = serde_json::from_str(json).expect("camelCase must deserialize");
    assert_eq!(p.base_url, "https://api.deepseek.com/v1");
    assert_eq!(p.model, "deepseek-chat");
}
```

Also assert that **snake_case still works** if you want backward compatibility (optional):

```rust
#[test]
fn provider_config_still_accepts_snake_case_if_aliased() {
    // Only required if you add #[serde(alias = "base_url")] — otherwise skip.
}
```

With only `rename_all = "camelCase"`, wire format is camelCase only. That is fine.

### A.5 Verification (Phase A)

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib provider_config_deserializes
pnpm run typecheck
pnpm test
```

Manual (desktop app):

1. Settings → add/select a provider with a valid key → **Test** → must succeed (not `base_url` error).
2. Open a paper → start section explanation → stream must start (not `missing field base_url`).

**STOP if any of the above fail.**

---

## 3. Phase B — Fix PDF black pages

### B.1 Problem

`src/components/pdf-viewer/pdf-viewer.tsx` paints pages with pdf.js onto `<canvas>`.
Black pages happen because of interacting races:

1. Setting `canvas.width` / `canvas.height` **clears the canvas to black** immediately.
2. A stale render run can clear a canvas after a newer run already painted it.
3. Waiting on a previous `renderTask.promise` can hang or race.
4. A failed page is not reliably re-queued.
5. Resize / zoom starts a new run while old workers still touch canvases.

### B.2 Rules you must implement (non-negotiable)

1. **Never** assign `canvas.width` / `canvas.height` unless `isCancelled()` is **false**.
2. Every `renderPage` call takes `isCancelled: () => boolean` and checks it:
   - before waiting on a previous task
   - after waiting
   - before clearing the canvas
   - before starting `page.render`
   - after `page.render` resolves (before text layer)
3. Bound any wait on a previous task (e.g. `Promise.race` with 300–500 ms timeout). Then **delete** the map entry.
4. On cleanup / new run: cancel tasks **and** remove them from the map.
5. If a page ends in failure after retries, record its index and **re-queue one repaint** after the main queue finishes (safety net).
6. Do not leave a silent black rectangle: track per-page status `pending | painting | ready | failed` and show a light placeholder or “Retry” for `failed`.

### B.3 HiDPI (required)

When sizing the canvas:

```ts
const dpr = window.devicePixelRatio || 1;
const cssWidth = viewport.width;   // from pdf.js viewport at current scale
const cssHeight = viewport.height;
canvas.style.width = `${cssWidth}px`;
canvas.style.height = `${cssHeight}px`;
canvas.width = Math.floor(cssWidth * dpr);
canvas.height = Math.floor(cssHeight * dpr);
const context = canvas.getContext("2d");
if (context) {
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}
```

Use a viewport that matches the **CSS** pixel size (pdf.js `getViewport({ scale })`), not the backing-store size. Do not double-scale.

### B.4 Theme isolation (required)

PDF page surface must stay readable in dark/sepia themes:

- Wrapper behind the canvas: solid light paper color (e.g. `#ffffff` or a warm paper token), **not** `bg-background` if that becomes dark.
- Text layer colors must stay dark-on-light for the PDF layer.

### B.5 Concurrency

Keep a small concurrency limit (e.g. 4) via `renderInQueue`. Cancellation must be checked **inside** each page render, not only between dispatches.

### B.6 Tests

Update / extend `src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx`:

1. When `isCancelled` flips true mid-render, the canvas must not be cleared by the stale run (mock render that resolves after cancel).
2. A page whose first render throws once and succeeds on retry ends `ready`.
3. A page that fails all attempts is marked `failed` and a repaint path exists.

Mock `pdfjs-dist` the same way existing tests do (`getDocument`, page `render`, etc.).

### B.7 Verification (Phase B)

```bash
pnpm run typecheck
pnpm test -- src/components/pdf-viewer
```

Manual:

1. Open a long arXiv PDF (10+ pages).
2. Resize the window repeatedly for 10 seconds.
3. Zoom in/out and fit-width.
4. Switch theme light → dark → sepia while PDF is open.
5. **Expected**: no permanent black pages; failed pages show retry UI, not a black void.

**STOP if black pages still persist after settle.**

---

## 4. Phase C — Correctness bugs (rate limit, loadMore, stop)

### C.1 `rate_limit` records timestamp too early

**File**: `src-tauri/src/papers.rs`

**Bug**: timestamp is written **before** `sleep`, so two concurrent callers both see “elapsed enough”, both sleep little/none, both hit the API → risk 429.

**Fix pattern**:

```rust
async fn rate_limit(source: &str) {
    let interval = source_interval(source);
    loop {
        let wait_for = {
            let mut last = LAST_REQUESTS
                .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let now = Instant::now();
            let wait = last
                .get(source)
                .map(|t| interval.saturating_sub(now.duration_since(*t)))
                .unwrap_or_default();
            if wait.is_zero() {
                last.insert(source.to_string(), now);
                return;
            }
            wait
        };
        tokio::time::sleep(wait_for).await;
        // loop: re-check under lock so only one caller proceeds
    }
}
```

Write a unit test with two concurrent tasks and assert minimum spacing (or that the second waits). Keep the test deterministic with a short interval if you inject interval for tests; otherwise test the lock logic with a small helper.

### C.2 `loadMore` ignores request generation

**File**: `src/stores/papers.ts`

`refresh` already uses a `requestSeq` (or similar) so stale responses are dropped. `loadMore` must use the **same** generation token:

- Capture `seq` at start of `loadMore`.
- After `await fetchPapers(...)`, if `get().requestSeq !== seq` (or whatever the field is named), **do not** append results and **do not** clear loading flags incorrectly for the newer request.

Read the existing `refresh` implementation and mirror its guard exactly.

### C.3 `reader.stop()` races a new operation

**File**: `src/stores/reader.ts`

**Bug**: `stop()` nulls `activeOperationId` unconditionally. If a new stream starts during the IPC round-trip, it becomes un-cancellable.

**Fix**:

- Capture `const id = get().activeOperationId` at the start of stop.
- Call backend `stop_explaining` / `stopExplanation(id)` with that id.
- Only clear `activeOperationId` if it is **still** equal to `id`.

Mirror the same pattern on the browser AbortController path in `src/lib/ai.ts` if needed.

### C.4 Verification (Phase C)

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm test -- src/stores
pnpm run typecheck
```

---

## 5. Phase D — Settings & providers UX

### D.1 Goals

- User can add a provider without guessing field meanings.
- User sees whether a key is stored and whether the last test passed.
- Failures show category guidance (`url` | `auth` | `network` | `model` | `unknown`) via existing `categorizeTestError` in `src/lib/provider-errors.ts`.
- **Do not** implement ChatGPT Plus / Codex subscription OAuth. That is out of scope.
- **Do** polish API-key presets: OpenAI, OpenRouter, DeepSeek, Groq, Ollama, OpenCode (already in `PROVIDER_PRESETS` in `src/lib/types.ts`).

### D.2 Provider card upgrades

**File**: `src/features/settings/provider-card.tsx`

Show:

- Name + model + truncated base URL
- Chip: **Active** when this id is `activeProviderId`
- Chip: **Key saved** / **No key** from `hasKey`
- Chip: **Last test: OK** / **Failed (auth|network|…)** if you persist last test result
- Buttons: Set active, Test, Edit, Delete

Persist last test result in localStorage (no secrets), e.g. key `papyrus-provider-test-v1`:

```ts
type TestMemory = Record<string, { ok: boolean; category?: string; at: string; detail?: string }>;
```

Truncate and redact detail with `truncateError` + `redactSecrets`.

### D.3 Guided add / edit form

**File**: `src/features/settings/provider-form.tsx`

Flow:

1. Preset select (from `PROVIDER_PRESETS`) or Custom.
2. On preset: prefill `baseUrl` + default `model`; if `models` array exists, use a select.
3. Name field (default to preset label).
4. API key field (password input, show/hide toggle). For Ollama (`keyRequired: false`), mark key optional.
5. On save:
   - `addProvider` / `updateProvider`
   - if key non-empty → `saveKey`
   - optional: auto-run `testProvider` and store result
6. Validation before save: non-empty id/name/model/baseUrl; id length ≤ 64 (match `isProviderConfig` in settings store).

### D.4 Settings page structure

**File**: `src/features/settings/settings-page.tsx`

Organize into clear sections (separate headings, not separate routes):

1. **Providers** — list + Add provider + empty state
2. **Reading** — paper source default, theme (if theme is here), language is in top bar already
3. **Data** — export, import, clear cache (existing)
4. **About** — app name + version from `package.json`

**Empty state** when `providers.length === 0`:

- Short message: AI features need a provider.
- Three buttons: “Add DeepSeek”, “Add OpenRouter”, “Add OpenAI” that open the form with that preset selected.

### D.5 Copy about “Codex / ChatGPT account”

If you add help text, use factual wording only:

> Papyrus connects with provider **API keys** (OpenAI API, OpenRouter, DeepSeek, etc.). A ChatGPT Plus or Codex subscription login is not supported inside the app.

Do not promise OAuth.

### D.6 i18n

Add any new strings to **both**:

- `src/i18n/locales/en.json`
- `src/i18n/locales/ar.json`

Keep Arabic practical and clear. Do not leave English-only keys in the UI.

### D.7 Tests

Update:

- `src/features/settings/__tests__/provider-form.test.tsx`
- `src/features/settings/__tests__/provider-card.test.tsx`
- `src/features/settings/__tests__/settings-page.test.tsx`

Cover: preset prefills baseUrl; empty state shows CTAs; test failure shows category (mock `testProvider`).

### D.8 Verification (Phase D)

```bash
pnpm run typecheck
pnpm test -- src/features/settings
```

Manual: cold start with no providers → empty state → add DeepSeek preset → save key → Test → Set active → open reader → Explain works.

---

## 6. Phase E — GUI polish (reader + list + a11y)

Do this **after** A–D. Keep the existing design system in `src/index.css` (Geist, Instrument Serif, IBM Plex Arabic). Do not invent a new brand.

### E.1 Reader

**File**: `src/features/reader/reader-view.tsx`

- If no active provider, show an inline panel: “Add an AI provider in Settings” + button that `setView("settings")`. Do not only show a raw invoke error.
- Mentor: show “Section X of Y” and disable Continue while a stream is active.
- Keep PDF | AI split; ensure the divider cannot crush either pane below a minimum width (e.g. 280px).

### E.2 PDF toolbar

**File**: `src/components/pdf-viewer/pdf-viewer.tsx`

- Group controls: prev/next page, page number, zoom −/+, fit, find.
- Keyboard: keep existing shortcuts; ensure focus is not trapped.

### E.3 Papers list

**File**: `src/features/papers/paper-list.tsx` / `paper-card.tsx`

- Stable sticky filter row (search, day, source) that does not jump layout when loading ends.
- Error state always has Retry.
- S2 citation counts remain decorative; never block rendering if citations fail.

### E.4 Focus and ARIA

- Icon-only buttons must have `aria-label` (many already do — audit new ones).
- Skip link already exists in `App.tsx` — do not remove it.

### E.5 Verification (Phase E)

```bash
pnpm run typecheck
pnpm test
```

Manual visual pass:

| Theme | Language | Window |
|-------|----------|--------|
| light | en | 1100×750 |
| dark | ar | 860×600 |
| sepia | en | default |

---

## 7. Phase F — Security hardening (small, required)

### F.1 Redaction in UI

Any time provider test or explain errors are shown in the UI, run:

```ts
truncateError(redactSecrets(message))
```

from `src/lib/provider-errors.ts`.

### F.2 Local base URL rules

Rust already restricts remote `http://`. Do not weaken this. If you touch `is_local_base_url` / `validate_provider`, add tests that:

- `http://127.0.0.1:11434/v1` is allowed
- `http://example.com/v1` is rejected
- `https://api.openai.com/v1` is allowed

### F.3 Verification

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm test -- src/lib
```

---

## 8. Out of scope (do not implement)

- ChatGPT Plus / Codex **subscription** OAuth or browser login inside the app
- Replacing pdf.js with another engine
- Mobile-only UI
- New paper sources beyond existing arXiv / Semantic Scholar
- Rewriting the entire CSS design system
- Reading or depending on anything under `plans/`

---

## 9. Implementation order (strict)

```text
Phase A  Provider serde + IPC helper + tests     ← blocks all AI features
Phase B  PDF black pages + HiDPI + page status
Phase C  rate_limit + loadMore + reader.stop
Phase D  Settings / providers UX
Phase E  GUI polish
Phase F  Security redaction / URL tests (can merge with C if touching same files)
```

Commit after each phase with a clear message, for example:

- `fix(ai): deserialize ProviderConfig as camelCase for Tauri IPC`
- `fix(pdf): cancel-safe page renders and HiDPI canvas`
- `fix(papers): correct rate_limit and loadMore generation guard`
- `feat(settings): guided provider setup and status chips`
- `style(ui): reader empty provider CTA and toolbar grouping`

---

## 10. Final acceptance checklist

Before reporting done, run **all** of these:

```bash
pnpm run typecheck
pnpm test
pnpm exec prettier --check .
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Manual smoke:

- [ ] Test provider succeeds without `base_url` error
- [ ] Explain abstract / section / ask all stream text
- [ ] PDF open → resize → zoom → no permanent black pages
- [ ] Dark theme PDF still looks like paper, not a black hole
- [ ] Empty providers → empty state CTA works
- [ ] Add OpenRouter or DeepSeek preset → Test → Active → Explain works
- [ ] Stop mid-stream still works; a new stream after stop can also be stopped
- [ ] EN and AR UI both load; Arabic layout is RTL without broken dates

---

## 11. How to report progress

After each phase, output:

1. Files changed (list)
2. Commands run and pass/fail
3. Anything you skipped and why
4. Residual risks

If blocked, quote the exact compiler/test error. Do not invent alternate designs when a step fails.

---

## 12. Quick reference — critical code facts

### Frontend ProviderConfig (`src/lib/types.ts`)

```ts
export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}
```

### Rust ProviderConfig (must accept camelCase JSON)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
}
```

### Paper already correct

```rust
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paper { /* pdf_url serializes as pdfUrl */ }
```

### Invoke sites that must send a correct provider

- `src/lib/reader-ai.ts` → `explain_section`, `explain_synthesis`, `ask_about_paper`
- `src/stores/settings.ts` → `test_provider`
- Any `explain_paper` call with `providers: [...]`

### PDF entry points

- Bytes: `src/lib/pdf.ts` → `getPdfBytes`
- View: `src/components/pdf-viewer/pdf-viewer.tsx`
- Rust cache: `src-tauri/src/pdf.rs`

---

## 13. Definition of done (one paragraph)

Phase A–F are merged, CI-equivalent commands pass, the explain path no longer throws `missing field base_url`, PDFs survive resize/zoom without stuck black pages, and a new user can add an API provider from Settings with a preset, test it, set it active, and run an explanation successfully in both English and Arabic UI modes.
