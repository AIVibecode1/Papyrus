# Plan 006: Derive the PDF URL server-side instead of trusting the webview

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src-tauri/src/pdf.rs src/lib/pdf.ts src/features/reader`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3 (defense in depth — no known exploit today)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

`fetch_pdf(app, paper_id, url)` accepts an arbitrary URL from the webview
and the Rust client downloads it. Today there is no known way to inject
arbitrary script into the webview (AI markdown is sanitized, PDF text is
escaped, CSP-null is a documented tradeoff with local-only content), so this
is not an exploitable vulnerability — it is an unnecessary trust surface.
The URL can always be reconstructed server-side from the paper id: arXiv
PDF links are deterministic (`https://arxiv.org/pdf/{id}`), and the
frontend already normalizes them at parse time (`papers.rs:140`). Removing
the `url` parameter means a compromised webview cannot turn the app into a
network fetch proxy, and one less input means one less validation path.

## Current state

- `src-tauri/src/pdf.rs:37` — command signature:
  ```rust
  #[tauri::command]
  pub async fn fetch_pdf(app: AppHandle, paper_id: String, url: String) -> Result<Response, String> {
      let path = cache_path(&app, &paper_id)?;
      if let Ok(bytes) = fs::read(&path)
          && !bytes.is_empty()
      { return Ok(Response::new(bytes)); }
      let bytes = download_pdf(&url).await?;
      ...
  }
  ```
- `download_pdf` (line 14) fetches whatever URL it is given.
- Frontend callers: `src/lib/pdf.ts` `getPdfBytes(paper)` invokes
  `fetch_pdf` with `{ paperId: paper.id, url: paper.pdfUrl }` (verify the
  exact arg names when implementing).
- The arXiv id format is `[a-z]+\.[0-9]+(v[0-9]+)?` (e.g. `2607.29762v1`);
  `cache_path` already sanitizes ids (`pdf.rs:59-62`).

## Commands you will need

| Purpose    | Command                                                            | Expected on success |
| ---------- | ------------------------------------------------------------------ | ------------------- |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --lib`            | all pass            |
| Rust lint  | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | clean               |
| Rust fmt   | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`        | clean               |
| Tests      | `pnpm exec vitest run`                                             | all pass            |
| Typecheck  | `pnpm exec tsc --noEmit`                                           | exit 0              |

## Scope

**In scope**:

- `src-tauri/src/pdf.rs` (drop the `url` param, build it from the id)
- `src/lib/pdf.ts` (drop the `url` arg from the invoke)
- Any test that calls `fetch_pdf`/`download_pdf` with a URL argument
- `plans/README.md` (status row)

**Out of scope**:

- `download_pdf`'s HTTP behavior, size cap, or error strings.
- The arXiv URL construction in `papers.rs` (it already exists — reuse the
  same shape, but do not refactor it here).
- The reader UI and pdf cache layout.

## Git workflow

- Branch: `advisor/006-server-side-pdf-url`
- Commit style: `security: derive the PDF URL from the paper id server-side`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Change the Rust command

In `src-tauri/src/pdf.rs`:

1. Change the signature to `fetch_pdf(app: AppHandle, paper_id: String)`
   (drop `url`).
2. Before downloading, validate the id against the arXiv shape and build
   the URL:
   ```rust
   // arXiv ids: [a-z]+\.[0-9]+ optionally followed by vN. Never trust
   // the webview with the fetch target.
   fn arxiv_pdf_url(paper_id: &str) -> Result<String, String> {
       let base = paper_id.split('v').next().unwrap_or(paper_id);
       if base.is_empty() || !base.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.') {
           return Err("Invalid paper id".into());
       }
       if !base.contains('.') { return Err("Invalid paper id".into()); }
       Ok(format!("https://arxiv.org/pdf/{base}"))
   }
   ```
   (Match the existing arXiv id conventions; the `split('v')` handles
   `2607.29762v1` → `2607.29762`.)
3. Call it in `fetch_pdf` instead of using the passed URL.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → compile and pass.

### Step 2: Update the frontend caller

In `src/lib/pdf.ts`, remove the `url` field from the `invoke("fetch_pdf", ...)`
payload. If `getPdfBytes` received the full `Paper`, it now ignores
`paper.pdfUrl` for the invoke (keep the browser-preview fallback path
unchanged — it still uses `paper.pdfUrl` directly, which is fine there).

**Verify**: `pnpm exec tsc --noEmit` → exit 0; `pnpm exec vitest run` → all pass.

### Step 3: Tests

1. Rust: add `arxiv_pdf_url_accepts_versioned_and_bare_ids` (both forms
   produce `https://arxiv.org/pdf/<base>`), and
   `arxiv_pdf_url_rejects_garbage` (empty, no dot, uppercase, path
   separators like `../` and `https://evil.example` all → `Err`).
2. Update any existing test that passed a `url` into `fetch_pdf` — the mock
   server tests in `pdf.rs` (`spawn_pdf_server`) still work: the server
   address is now irrelevant to the request target, so point the mock at
   any port and assert the request line contains `/pdf/<id>` (the mock
   server can log the requested path).
3. Frontend: no new tests required (thin invoke change), but run the suite.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass incl. new tests; `pnpm exec vitest run` → all pass.

### Step 4: Full gates

**Verify**:

1. `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` → clean
2. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` → clean
3. `pnpm exec eslint .` and `pnpm exec prettier --check .` → clean

## Test plan

- Rust: id-validation unit tests + an assertion in the mock-server test
  that the requested path is `/pdf/<base>` (proves the server built the
  URL, not the caller).
- Frontend: existing suites stay green (no behavior change in the preview).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "url: String" src-tauri/src/pdf.rs` → no match (the param is gone)
- [ ] `grep -rn "fetch_pdf" src-tauri/src/pdf.rs src/lib/pdf.ts` → the invoke payload has no `url` key
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass
- [ ] `cargo clippy` and `cargo fmt -- --check` clean; `pnpm exec tsc --noEmit` and `pnpm exec vitest run` clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The frontend invokes `fetch_pdf` with args that don't match this plan's
  description (drift — read `src/lib/pdf.ts` first).
- The browser-preview PDF path relies on the Rust command (it should not —
  it uses `fetch` directly; if it does, report the divergence).
- A paper id in real arXiv data fails the validation regex (e.g. new-style
  ids like `1234.56789` are covered; if a live fetch proves a shape the
  validator rejects, report with the sample id — do not loosen the
  validator without evidence).

## Maintenance notes

- If a second paper source (plan 011) ships PDFs hosted elsewhere (S2
  `openAccessPdf.url`), this strict arXiv-only construction must be
  revisited: either the id gains a source prefix (`s2:...`) that maps to
  its own URL policy, or the command gains a validated `kind` enum. Do not
  widen this plan to accept arbitrary URLs.
- Reviewer focus: the validator must stay conservative — rejecting a weird
  id costs one error message; accepting a crafted id costs the trust
  boundary this plan exists to remove.
