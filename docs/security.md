# Security

- API keys are written to and read from the OS keychain by the Rust
  backend only. They never enter the web view.
- The webview runs with a restricted capability set (`core:default` and
  `opener:allow-open-url`). The keychain plugin permission is not exposed
  to the web view at all.
- The webview runs under a restrictive Content-Security-Policy (exact
  string in `src-tauri/tauri.conf.json`, verified per
  `docs/spikes/csp.md`). All data fetching is Rust-side, so the policy
  needs no remote `connect-src` entries; only the Tauri IPC origins are
  allowlisted besides `'self'`.
- AI responses are rendered as markdown, not raw HTML: the renderer
  escapes any HTML tags the model produces (no raw-HTML passthrough),
  mermaid diagrams run in strict security mode, and links open through
  the operating system's browser. PDF text is only ever shown inside
  the pdf.js viewer and sent to the AI backend; it is never injected
  into the page as HTML.
- Remote provider URLs must use HTTPS. Plain HTTP is only accepted for
  local servers such as Ollama, so keys are never sent in clear text.
- Provider error messages are redacted: key-shaped strings are masked
  before they reach the interface.
- arXiv's rate limit (about one request per 3 seconds) is enforced in the
  Rust fetcher.
- Paper content and AI responses are handled as untrusted data: markdown
  rendering escapes HTML, and PDF downloads are capped in size and
  rendered sandboxed in the viewer.

The agent-enforced version of these rules (what not to weaken) is in
`docs/architecture.md`, "Security contracts".
