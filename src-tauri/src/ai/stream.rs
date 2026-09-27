use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::ai::ProviderConfig;
use crate::ai::keychain::{is_loopback_host, load_key};
use crate::ai::prompts::{build_messages, cancelled_marker};
use crate::papers::{Paper, shared_client};

use tauri::ipc::Channel;

/// Upper bound for one explanation stream (a walkthrough section, a
/// synthesis, or an ask answer).
pub(crate) const EXPLAIN_TIMEOUT: Duration = Duration::from_secs(600);
/// Upper bound for the Settings "Test" request.
pub(crate) const TEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Upper bound on a single SSE line held in the line buffer. One event is
/// normally a few hundred bytes; anything past this is a malformed or
/// hostile endpoint, not a real delta.
const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;
/// Upper bound on the assembled answer. Generous for a paper explanation
/// (the longest prompt caps paper text at 60k chars) while still bounding
/// a peer that streams forever inside the request timeout.
const MAX_STREAM_TEXT_BYTES: usize = 4 * 1024 * 1024;
/// Upper bound on a whole HTTP body we read into memory. The streaming
/// path is capped by `MAX_STREAM_TEXT_BYTES`; the non-streaming fallback
/// and the error path are not, and `Response::text()` buffers
/// everything before we ever look at it. A peer that returns a 10 GB
/// body would exhaust the heap before any limit could apply.
pub(crate) const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Reads a response body with a hard ceiling, refusing *before* the
/// allocation grows past it rather than truncating after the fact.
async fn read_capped(response: reqwest::Response) -> Result<String, String> {
    if let Some(len) = response.content_length()
        && len as usize > MAX_RESPONSE_BYTES
    {
        return Err("Provider response is too large".into());
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read provider response: {e}"))?;
        if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Provider response is too large".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// The chat URL actually used for `provider`.
///
/// The key for a provider lives in the OS keychain and is only ever read
/// here, in Rust. The base URL, however, rides in with every call from the
/// webview. Trusting it would let a compromised webview name a real
/// provider id, point `baseUrl` at a host it controls, and have the
/// backend send that provider's key there as a bearer token.
///
/// So the host is pinned at save time (see `provider_urls`): the URL the
/// user saved with their key wins, and a caller asking for a different
/// one is refused rather than obeyed. A provider with no binding (an
/// install that predates this, or one mid-add) still validates normally.
pub(crate) fn resolve_chat_url(
    app: Option<&tauri::AppHandle>,
    provider: &ProviderConfig,
) -> Result<String, String> {
    match super::provider_urls::bound_url(app, &provider.id) {
        Some(bound) => Ok(bound),
        None => build_chat_url(&provider.base_url),
    }
}

/// Normalizes a user-provided base URL into a full chat-completions URL.
///
/// HTTPS is required for any remote host; plaintext `http://` is only
/// accepted for loopback servers, since the API key is sent as a bearer
/// token over this URL.
pub(crate) fn build_chat_url(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("http://") {
        let host = rest.split('/').next().unwrap_or(rest);
        if !is_loopback_host(host) {
            return Err(
                "HTTP (plaintext) base URLs are only allowed for local servers (localhost). Use https:// for remote providers."
                    .into(),
            );
        }
    } else if !base.starts_with("https://") {
        return Err("Base URL must start with http:// or https://".into());
    }
    if base.ends_with("/chat/completions") {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/chat/completions"))
    }
}

// SSE parser contract (both languages MUST match):
// - Lines are split on \n (stripping trailing \r).
// - Only lines starting with "data:" carry payloads; ": " comments and
//   blanks are ignored.
// - "[DONE]" ends the stream successfully.
// - A clean close WITHOUT [DONE] is SUCCESS if content was received
//   (Rust: Ok(full); TS: resolve) and an error if nothing was received.
// - Cancellation surfaces the CANCELLED_MARKER string (Rust: Err(marker);
//   TS: throw Error(marker)).
// - Delta payloads are JSON objects; content lives at choices[0].delta.content.
/// Streams a chat completion from any OpenAI-compatible endpoint, invoking `on_chunk`
/// for each content delta. Returns the full assembled text.
pub(crate) async fn stream_chat(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    body: Value,
    timeout: Duration,
    cancel_flag: &AtomicBool,
    on_chunk: &mut (dyn FnMut(&str) + Send),
) -> Result<String, String> {
    let mut request = client.post(url).timeout(timeout);
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let response = request.json(&body).send().await.map_err(|e| {
        format!(
            "Network error while contacting the provider: {}",
            redact_tokens(&e.to_string())
        )
    })?;

    let status = response.status();
    if !status.is_success() {
        let text = read_capped(response).await.unwrap_or_default();
        return Err(format!(
            "Provider returned HTTP {status}: {}",
            truncate(&redact_tokens(&text), 300)
        ));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let mut full = String::new();

    if content_type.contains("text/event-stream") {
        let mut stream = response.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let chunk = match stream.next().await {
                Some(Ok(chunk)) => chunk,
                Some(Err(e)) => {
                    // Mid-stream transport failure (proxy reset, gateway
                    // timeout, truncated chunked body). With content already
                    // received, treat it like the clean-close case below:
                    // surfacing the partial answer beats throwing it away.
                    // With nothing received, report the real error.
                    if full.is_empty() {
                        return Err(format!("Stream error: {e}"));
                    }
                    return Ok(full);
                }
                // Stream ended without a [DONE] marker: treat it as a clean
                // close if we already received content, otherwise error.
                None => {
                    if full.is_empty() {
                        return Err("Stream ended unexpectedly".to_string());
                    }
                    return Ok(full);
                }
            };
            // Buffer raw bytes and decode only complete lines, so a multi-byte
            // UTF-8 character split across two chunks is not corrupted.
            buf.extend_from_slice(&chunk);
            // A peer that never emits a newline would otherwise grow `buf`
            // without bound for the whole 600 s window. One SSE line is
            // normally a few hundred bytes; 1 MiB is far past any real
            // event and stops a malformed endpoint from eating the heap.
            if buf.len() > MAX_SSE_LINE_BYTES {
                return Err("Provider sent an oversized stream frame".into());
            }
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes = buf[..pos].to_vec();
                buf.drain(..=pos);
                let line_bytes = line_bytes.strip_suffix(b"\r").unwrap_or(&line_bytes);
                let Ok(line) = std::str::from_utf8(line_bytes) else {
                    // Invalid UTF-8 within a line is malformed SSE — skip it.
                    continue;
                };
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        // A gateway can send [DONE] having produced nothing
                        // (rejected model, empty tool call, truncated
                        // response). Reporting success here would mark an
                        // EMPTY explanation as done, so the panel shows a
                        // blank card with no way to tell it failed. Match
                        // the clean-close branch below.
                        if full.is_empty() {
                            return Err("Provider returned no content".into());
                        }
                        return Ok(full);
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        // OpenAI-compatible gateways report mid-stream
                        // failures as a data frame carrying `error`. It
                        // parses fine but has no delta.content, so without
                        // this check it is silently dropped and the run
                        // still reports success.
                        if let Some(message) =
                            value.pointer("/error/message").and_then(|m| m.as_str())
                        {
                            return Err(truncate(&redact_tokens(message), 300));
                        }
                        if let Some(content) = value
                            .pointer("/choices/0/delta/content")
                            .and_then(|c| c.as_str())
                        {
                            if cancel_flag.load(Ordering::SeqCst) {
                                return Err(cancelled_marker().into());
                            }
                            if full.len() + content.len() > MAX_STREAM_TEXT_BYTES {
                                return Err("Provider response exceeded the size limit".into());
                            }
                            full.push_str(content);
                            on_chunk(content);
                        }
                    }
                }
            }
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(cancelled_marker().into());
            }
        }
    } else {
        // Non-streaming fallback: parse the whole JSON response, with a
        // ceiling so a huge body cannot exhaust memory before parsing.
        let text = read_capped(response)
            .await
            .map_err(|e| format!("Failed to read provider response: {e}"))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Provider returned invalid JSON: {e}"))?;
        if let Some(content) = value
            .pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
        {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(cancelled_marker().into());
            }
            full.push_str(content);
            on_chunk(content);
        } else {
            return Err("Provider response contained no text content.".into());
        }
    }

    Ok(full)
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// Masks token-like substrings (e.g. API keys) inside provider error text.
///
/// Some gateways echo the submitted key back in 401/400 bodies; the error
/// text is surfaced in the UI, so key-shaped runs must be masked first.
/// The pattern list must stay in sync with `redactTokens` in src/lib/ai.ts.
pub(crate) fn redact_tokens(text: &str) -> String {
    // Matches common key shapes: sk-..., key-..., ghp_..., xai-..., long base64-ish runs
    let token_patterns = [
        "sk-", "sk_", "key-", "key_", "ghp_", "xai-", "Bearer ", "bearer ",
    ];
    let mut out = text.to_string();
    for pat in token_patterns {
        // Resume after each replacement so the `***` marker we just wrote is
        // not re-matched, and later tokens in the same body are still found.
        let mut search_from = 0;
        while let Some(rel) = out[search_from..].find(pat) {
            let pos = search_from + rel;
            let rest = &out[pos + pat.len()..];
            let end = rest
                .find(|c: char| {
                    c.is_whitespace() || c == '"' || c == '\'' || c == '}' || c == ',' || c == ')'
                })
                .unwrap_or(rest.len());
            let token = &rest[..end];
            if token.len() >= 6 {
                out.replace_range(pos..pos + pat.len() + end, &format!("{pat}***"));
                search_from = pos + pat.len() + 3; // past the "***" marker
            } else {
                // Not a real token ("sk-8" in "model sk-8 rejected"). Step
                // PAST it and keep scanning the rest of the body — bailing
                // out of the whole pattern here let any short "sk-"-shaped
                // run earlier in an error body mask every real key after
                // it, which the 32-char fallback cannot catch (API keys are
                // routinely shorter than that).
                search_from = pos + pat.len() + end;
            }
        }
    }
    // Generic fallback: long opaque runs (>= 32 token-ish characters) with
    // no recognizable prefix. Custom OpenAI-compatible gateways often echo
    // the submitted key back in error bodies without any standard prefix;
    // a run this long is never a normal word. Same rule as the TS mirror.
    let mut final_out = String::with_capacity(out.len());
    let mut run_start: Option<usize> = None;
    let flush_run = |final_out: &mut String, start: usize, end: usize| {
        let run = &out[start..end];
        if run.chars().count() >= 32 {
            final_out.push_str("***");
        } else {
            final_out.push_str(run);
        }
    };
    for (i, c) in out.char_indices() {
        let is_token_char = c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.');
        match (is_token_char, run_start) {
            (true, None) => run_start = Some(i),
            (false, Some(start)) => {
                flush_run(&mut final_out, start, i);
                final_out.push(c);
                run_start = None;
            }
            (false, None) => final_out.push(c),
            (true, Some(_)) => {}
        }
    }
    if let Some(start) = run_start {
        flush_run(&mut final_out, start, out.len());
    }
    final_out
}

pub(crate) fn validate_provider(provider: &ProviderConfig) -> Result<(), String> {
    if provider.id.is_empty() || provider.id.len() > 64 {
        return Err("Invalid provider id".into());
    }
    if provider.name.trim().is_empty() || provider.name.len() > 64 {
        return Err("Provider name must be 1-64 characters".into());
    }
    if provider.model.trim().is_empty() || provider.model.len() > 128 {
        return Err("Model name must be 1-128 characters".into());
    }
    build_chat_url(&provider.base_url)?;
    Ok(())
}

/// Generates a streaming explanation of a paper in the current UI language.
/// Explains a paper by trying an ordered chain of providers, failing over
/// to the next one when the active provider fails BEFORE delivering any
/// content. Returns the winning provider's id so the UI can show who
/// actually answered.
/// Internal chain: try each provider; retry ONLY pre-first-chunk failures.
/// The typed cancellation marker is terminal (never retried, never folded
/// into the aggregate); post-first-chunk errors propagate because partial
/// text is already on screen.
pub(crate) async fn explain_with_failover(
    cancel_flag: &AtomicBool,
    app: Option<&tauri::AppHandle>,
    providers: &[ProviderConfig],
    paper: &Paper,
    language: &str,
    on_chunk: &mut (dyn FnMut(&str) + Send),
) -> Result<String, String> {
    if providers.is_empty() {
        return Err("No providers configured".into());
    }
    let client = shared_client();
    let mut failures: Vec<String> = Vec::new();
    for provider in providers {
        // A Stop pressed between attempts aborts the whole chain.
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(cancelled_marker().into());
        }
        if let Err(e) = validate_provider(provider) {
            failures.push(format!("{}: {e}", provider.name));
            continue;
        }
        let key = match load_key(provider) {
            Ok(k) => k,
            Err(e) => {
                failures.push(format!("{}: {e}", provider.name));
                continue;
            }
        };
        let url = match resolve_chat_url(app, provider) {
            Ok(u) => u,
            Err(e) => {
                failures.push(format!("{}: {e}", provider.name));
                continue;
            }
        };
        let body = json!({
            "model": provider.model,
            "messages": build_messages(paper, language),
            "stream": true,
            "temperature": 0.4,
        });
        // The discriminator: retrying after the first chunk would
        // duplicate partial text on screen.
        let mut delivered = false;
        let result = stream_chat(
            client,
            &url,
            &key,
            body,
            EXPLAIN_TIMEOUT,
            cancel_flag,
            &mut |c| {
                delivered = true;
                on_chunk(c);
            },
        )
        .await;
        match result {
            Ok(_) => return Ok(provider.id.clone()),
            // Marker contract: terminal — never retried, never aggregated.
            Err(e) if e.starts_with(cancelled_marker()) => return Err(e),
            // Partial text is already on screen — retrying would duplicate it.
            Err(e) if delivered => return Err(e),
            Err(e) => failures.push(format!("{}: {e}", provider.name)),
        }
    }
    Err(format!(
        "All {} providers failed: {}",
        providers.len(),
        truncate(&failures.join(" | "), 500)
    ))
}

/// Sends a minimal request to verify a provider configuration.
/// Streams a chat completion with a prebuilt message list, sharing the
/// cancellation flag and timeout of the main explain command.
pub(crate) async fn stream_messages(
    cancel_flag: &AtomicBool,
    app: Option<&tauri::AppHandle>,
    provider: &ProviderConfig,
    messages: Vec<Value>,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    validate_provider(provider)?;
    let key = load_key(provider)?;
    let url = resolve_chat_url(app, provider)?;
    let client = shared_client();
    let body = json!({
        "model": provider.model,
        "messages": messages,
        "stream": true,
        "temperature": 0.4,
    });
    stream_chat(
        client,
        &url,
        &key,
        body,
        EXPLAIN_TIMEOUT,
        cancel_flag,
        &mut |chunk| {
            let _ = on_chunk.send(chunk.to_string());
        },
    )
    .await
    .map(|_| ())
}
