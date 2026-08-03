use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::ipc::Channel;

use crate::papers::{Paper, shared_client};

const KEYRING_SERVICE: &str = "papyrus";
const EXPLAIN_TIMEOUT: Duration = Duration::from_secs(120);
const TEST_TIMEOUT: Duration = Duration::from_secs(30);

static CANCEL_EXPLAIN: AtomicBool = AtomicBool::new(false);

/// Shared AI-layer resource (system prompts + cancellation marker) — the
/// single source of truth for both languages. Rust reads it via
/// `include_str!`; TypeScript imports the same file from src/lib/ai.ts
/// (`../../src-tauri/prompts.json`). Edit the JSON, never the code.
const PROMPTS_JSON: &str = include_str!("../prompts.json");

static PROMPTS: OnceLock<serde_json::Value> = OnceLock::new();

fn prompts() -> &'static serde_json::Value {
    PROMPTS.get_or_init(|| {
        serde_json::from_str(PROMPTS_JSON).expect("src-tauri/prompts.json must be valid JSON")
    })
}

/// System prompt for the given UI language, from the shared resource.
fn system_prompt(language: &str) -> &'static str {
    let key = if language == "ar" {
        "systemPromptAr"
    } else {
        "systemPromptEn"
    };
    prompts()[key]
        .as_str()
        .expect("prompts.json must contain a string systemPromptEn/systemPromptAr")
}

/// Typed cancellation marker from the shared resource. Emitted instead of a
/// human-readable string when a user stops an explanation. The frontend
/// classifies a stop by this exact prefix (exported as `CANCELLED_MARKER` in
/// src/lib/ai.ts), so provider errors that merely contain the word "stop"
/// can never be mislabeled.
fn cancelled_marker() -> &'static str {
    prompts()["cancelledMarker"]
        .as_str()
        .expect("prompts.json must contain a string cancelledMarker")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
}

/// Reports whether a host is a loopback address, where plaintext HTTP is
/// acceptable because no on-path observer can read the API key.
fn is_loopback_host(host: &str) -> bool {
    // Strip IPv6 brackets, keeping any port that follows (e.g. [::1]:8080).
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.split(']').next())
        .unwrap_or(host);
    // Drop the port for non-IPv6 hosts (e.g. localhost:11434).
    let host = if host.starts_with("::") {
        host
    } else {
        host.split(':').next().unwrap_or(host)
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Normalizes a user-provided base URL into a full chat-completions URL.
///
/// HTTPS is required for any remote host; plaintext `http://` is only
/// accepted for loopback servers, since the API key is sent as a bearer
/// token over this URL.
fn build_chat_url(base: &str) -> Result<String, String> {
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

fn build_messages(paper: &Paper, language: &str) -> Vec<Value> {
    let system = system_prompt(language);
    let user = format!(
        "Title: {}\nAuthors: {}\nPublished: {}\nCategories: {}\n\nAbstract:\n{}",
        paper.title,
        paper.authors.join(", "),
        paper.published,
        paper.categories.join(", "),
        paper.summary
    );
    vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": user }),
    ]
}

/// Reports whether a base URL points at a local server (Ollama etc.),
/// where an API key may be omitted.
fn is_local_base_url(base_url: &str) -> bool {
    base_url.contains("localhost") || base_url.contains("127.0.0.1")
}

/// Reads a secret from the OS keychain (Windows Credential Manager / macOS
/// Keychain). `Ok(None)` means no entry exists for the account; genuine
/// keychain failures are returned as errors.
fn get_key(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(service, account)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read key from the system keychain: {e}")),
    }
}

/// Saves a secret to the OS keychain, creating or replacing the entry.
fn set_key(service: &str, account: &str, key: &str) -> Result<(), String> {
    let entry = Entry::new(service, account)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))?;
    entry
        .set_password(key)
        .map_err(|e| format!("Failed to save key to the system keychain: {e}"))
}

/// Removes a secret from the OS keychain.
fn delete_key(service: &str, account: &str) -> Result<(), String> {
    let entry = Entry::new(service, account)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to remove key from the system keychain: {e}"))
}

/// Loads the stored API key for a provider. Local endpoints (Ollama etc.) may have no key.
fn load_key(provider: &ProviderConfig) -> Result<String, String> {
    let key = get_key(KEYRING_SERVICE, &provider.id)?;
    let is_local = is_local_base_url(&provider.base_url);
    match key {
        Some(k) => Ok(k),
        None if is_local => Ok(String::new()),
        None => Err("No API key found for this provider. Add it in Settings → Providers.".into()),
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
async fn stream_chat(
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
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error while contacting the provider: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
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
                Some(Err(e)) => return Err(format!("Stream error: {e}")),
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
                        return Ok(full);
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(data)
                        && let Some(content) = value
                            .pointer("/choices/0/delta/content")
                            .and_then(|c| c.as_str())
                    {
                        if cancel_flag.load(Ordering::SeqCst) {
                            return Err(cancelled_marker().into());
                        }
                        full.push_str(content);
                        on_chunk(content);
                    }
                }
            }
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(cancelled_marker().into());
            }
        }
    } else {
        // Non-streaming fallback: parse the whole JSON response.
        let text = response
            .text()
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

fn truncate(s: &str, max: usize) -> String {
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
fn redact_tokens(text: &str) -> String {
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
                break; // not a real token; avoid mangling words like "sk-8"
            }
        }
    }
    out
}

fn validate_provider(provider: &ProviderConfig) -> Result<(), String> {
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
#[tauri::command]
// The argument list is the IPC contract between the frontend and Rust.
#[allow(clippy::too_many_arguments)]
pub async fn explain_paper(
    providers: Vec<ProviderConfig>,
    paper: Paper,
    language: String,
    on_chunk: Channel<String>,
) -> Result<String, String> {
    CANCEL_EXPLAIN.store(false, Ordering::SeqCst);
    explain_with_failover(&CANCEL_EXPLAIN, &providers, &paper, &language, &mut |c| {
        let _ = on_chunk.send(c.to_string());
    })
    .await
}

/// Internal chain: try each provider; retry ONLY pre-first-chunk failures.
/// The typed cancellation marker is terminal (never retried, never folded
/// into the aggregate); post-first-chunk errors propagate because partial
/// text is already on screen.
async fn explain_with_failover(
    cancel_flag: &AtomicBool,
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
        let url = match build_chat_url(&provider.base_url) {
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
#[tauri::command]
pub async fn test_provider(provider: ProviderConfig) -> Result<String, String> {
    validate_provider(&provider)?;
    let key = load_key(&provider)?;
    let url = build_chat_url(&provider.base_url)?;
    let client = shared_client();

    let body = json!({
        "model": provider.model,
        "messages": [{"role": "user", "content": "Reply with the single word: OK"}],
        "stream": false,
        "max_tokens": 8,
    });

    let reply = stream_chat(
        client,
        &url,
        &key,
        body,
        TEST_TIMEOUT,
        &CANCEL_EXPLAIN,
        &mut |_| {},
    )
    .await?;
    Ok(reply.trim().to_string())
}

/// Cancels the currently running explanation (if any).
#[tauri::command]
pub fn stop_explaining() {
    CANCEL_EXPLAIN.store(true, Ordering::SeqCst);
}

fn prompt_for(language: &str, en: &'static str, ar: &'static str) -> &'static str {
    if language == "ar" { ar } else { en }
}

fn full_paper_prompt(language: &str) -> &'static str {
    prompt_for(
        language,
        prompts()["fullPaperStructureEn"]
            .as_str()
            .expect("prompts.json fullPaperStructureEn"),
        prompts()["fullPaperStructureAr"]
            .as_str()
            .expect("prompts.json fullPaperStructureAr"),
    )
}

fn qa_prompt(language: &str) -> &'static str {
    prompt_for(
        language,
        prompts()["qaPromptEn"]
            .as_str()
            .expect("prompts.json qaPromptEn"),
        prompts()["qaPromptAr"]
            .as_str()
            .expect("prompts.json qaPromptAr"),
    )
}

fn synthesis_prompt(language: &str) -> &'static str {
    prompt_for(
        language,
        prompts()["synthesisPromptEn"]
            .as_str()
            .expect("prompts.json synthesisPromptEn"),
        prompts()["synthesisPromptAr"]
            .as_str()
            .expect("prompts.json synthesisPromptAr"),
    )
}

/// Safety cap for paper text sent to a provider (defensive; the frontend
/// splits sections well below this).
const MAX_PAPER_TEXT_CHARS: usize = 60_000;

/// Mentor walkthrough message for ONE section of the paper. The format
/// string must stay in sync with the browser path in src/lib/reader-ai.ts
/// (ai-contract tests cross-check the shape).
fn build_section_messages(
    paper: &Paper,
    section_index: usize,
    total_sections: usize,
    section_text: &str,
    language: &str,
) -> Vec<Value> {
    let system = format!(
        "{}\n\nThe user will send you ONE section of the paper at a time. Apply the section structure to that section only. Respond in the same language as the user's request.",
        full_paper_prompt(language)
    );
    let user = format!(
        "Paper title: {}\nAuthors: {}\n\nSection {} of {}:\n{}",
        paper.title,
        paper.authors.join(", "),
        section_index,
        total_sections,
        truncate(section_text, MAX_PAPER_TEXT_CHARS)
    );
    vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": user }),
    ]
}

/// End-of-paper synthesis message (whole text as context).
fn build_synthesis_messages(paper: &Paper, sections_text: &str, language: &str) -> Vec<Value> {
    let user = format!(
        "Paper title: {}\nAuthors: {}\n\nFull text of the paper:\n{}",
        paper.title,
        paper.authors.join(", "),
        truncate(sections_text, MAX_PAPER_TEXT_CHARS)
    );
    vec![
        json!({ "role": "system", "content": synthesis_prompt(language) }),
        json!({ "role": "user", "content": user }),
    ]
}

/// One prior chat turn, sent back to the provider so follow-up questions
/// have real conversation context (serde matches the JS `{role, content}`).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

/// Question-answer message: the question plus (optionally) the selected
/// passage and the relevant section as grounding context, and the recent
/// conversation history so follow-ups are answered in context.
fn build_qa_messages(
    paper: &Paper,
    question: &str,
    selection: Option<&str>,
    context: Option<&str>,
    history: &[ChatTurn],
    language: &str,
) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "system", "content": qa_prompt(language) })];
    // Prior turns first (max 8, oldest to newest), then the live question.
    for turn in history.iter().take(8) {
        let role = if turn.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        messages.push(json!({ "role": role, "content": turn.content }));
    }
    let mut user = format!(
        "Paper title: {}\nAuthors: {}\n",
        paper.title,
        paper.authors.join(", ")
    );
    if let Some(selection) = selection {
        user.push_str(&format!(
            "\nSelected passage from the paper:\n{selection}\n"
        ));
    }
    if let Some(context) = context {
        user.push_str(&format!(
            "\nRelevant part of the paper:\n{}\n",
            truncate(context, MAX_PAPER_TEXT_CHARS)
        ));
    }
    user.push_str(&format!("\nQuestion: {question}"));
    messages.push(json!({ "role": "user", "content": user }));
    messages
}

/// Streams a chat completion with a prebuilt message list, sharing the
/// cancellation flag and timeout of the main explain command.
async fn stream_messages(
    provider: &ProviderConfig,
    messages: Vec<Value>,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    validate_provider(provider)?;
    CANCEL_EXPLAIN.store(false, Ordering::SeqCst);
    let key = load_key(provider)?;
    let url = build_chat_url(&provider.base_url)?;
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
        &CANCEL_EXPLAIN,
        &mut |chunk| {
            let _ = on_chunk.send(chunk.to_string());
        },
    )
    .await
    .map(|_| ())
}

/// Mentor walkthrough of a single paper section (whole-paper reader).
#[tauri::command]
pub async fn explain_section(
    provider: ProviderConfig,
    paper: Paper,
    section_index: usize,
    total_sections: usize,
    section_text: String,
    language: String,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let messages = build_section_messages(
        &paper,
        section_index,
        total_sections,
        &section_text,
        &language,
    );
    stream_messages(&provider, messages, on_chunk).await
}

/// Final synthesis after all sections were walked through.
#[tauri::command]
pub async fn explain_synthesis(
    provider: ProviderConfig,
    paper: Paper,
    sections_text: String,
    language: String,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let messages = build_synthesis_messages(&paper, &sections_text, &language);
    stream_messages(&provider, messages, on_chunk).await
}

/// Answers a question about the paper, grounded in the selected passage
/// and the relevant section context, with recent chat history.
#[tauri::command]
// The argument list is the IPC contract between the frontend and Rust;
// grouping it into a struct would add indirection without removing any
// of the fields the webview must send.
#[allow(clippy::too_many_arguments)]
pub async fn ask_about_paper(
    provider: ProviderConfig,
    paper: Paper,
    question: String,
    selection: Option<String>,
    context: Option<String>,
    history: Vec<ChatTurn>,
    language: String,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let messages = build_qa_messages(
        &paper,
        &question,
        selection.as_deref(),
        context.as_deref(),
        &history,
        &language,
    );
    stream_messages(&provider, messages, on_chunk).await
}

/// Saves an API key to the OS keychain (Windows Credential Manager / macOS Keychain).
#[tauri::command]
pub async fn save_api_key(provider_id: String, key: String) -> Result<(), String> {
    if provider_id.is_empty() || provider_id.len() > 64 {
        return Err("Invalid provider id".into());
    }
    if key.trim().is_empty() {
        return Err("API key cannot be empty".into());
    }
    set_key(KEYRING_SERVICE, &provider_id, key.trim())
}

/// Removes a stored API key from the OS keychain.
#[tauri::command]
pub async fn delete_api_key(provider_id: String) -> Result<(), String> {
    delete_key(KEYRING_SERVICE, &provider_id)
}

/// Reports whether a key is stored for the provider — never exposes the key itself.
#[tauri::command]
pub async fn has_api_key(provider_id: String) -> Result<bool, String> {
    get_key(KEYRING_SERVICE, &provider_id).map(|k| k.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::thread;

    fn sample_paper() -> Paper {
        Paper {
            id: "2607.12345".into(),
            title: "A Test Paper".into(),
            authors: vec!["Jane Doe".into()],
            published: "2026-07-31T17:59:59Z".into(),
            summary: "A summary of the test paper.".into(),
            pdf_url: "https://arxiv.org/pdf/2607.12345".into(),
            categories: vec!["cs.AI".into()],
            citation_count: None,
            tldr: None,
            venue: None,
        }
    }

    #[test]
    fn chat_url_normalization() {
        assert_eq!(
            build_chat_url("https://api.openai.com/v1").unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            build_chat_url("https://api.openai.com/v1/").unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            build_chat_url("https://x.com/v1/chat/completions").unwrap(),
            "https://x.com/v1/chat/completions"
        );
        assert!(build_chat_url("ftp://bad").is_err());
        assert!(build_chat_url("not a url").is_err());
        // Plaintext http:// is only allowed for loopback servers.
        assert_eq!(
            build_chat_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            build_chat_url("http://127.0.0.1:11434/v1").unwrap(),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert_eq!(
            build_chat_url("http://[::1]:11434/v1").unwrap(),
            "http://[::1]:11434/v1/chat/completions"
        );
        let remote_err = "HTTP (plaintext) base URLs are only allowed for local servers (localhost). Use https:// for remote providers.";
        assert_eq!(
            build_chat_url("http://192.168.1.5/v1"),
            Err(remote_err.into())
        );
        assert_eq!(
            build_chat_url("http://api.example.com/v1"),
            Err(remote_err.into())
        );
    }

    #[test]
    fn messages_follow_ui_language() {
        let en = build_messages(&sample_paper(), "en");
        assert!(en[0]["content"].as_str().unwrap().contains("English"));
        let ar = build_messages(&sample_paper(), "ar");
        assert!(ar[0]["content"].as_str().unwrap().contains("اللغة العربية"));
        let user_content = en[1]["content"].as_str().unwrap();
        assert!(user_content.contains("A Test Paper"));
        assert!(user_content.contains("A summary of the test paper."));
    }

    /// Spawns a minimal OpenAI-compatible server that answers one request with `response`.
    fn spawn_mock_server(response: String) -> String {
        spawn_mock_server_chunked(vec![response.into_bytes()])
    }

    /// Like `spawn_mock_server`, but writes each response part with a separate
    /// `write_all` call (with a small delay between writes) to emulate a
    /// streaming provider that fragments its response across TCP chunks.
    fn spawn_mock_server_chunked(parts: Vec<Vec<u8>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                // Read request headers + body (best effort).
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                let mut total = 0usize;
                let mut header_end = 0usize;
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            req.extend_from_slice(&buf[..n]);
                            total += n;
                            if let Some(pos) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                                header_end = pos + 4;
                                break;
                            }
                            if total > 64 * 1024 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                // Consume the request body so the client can finish writing.
                if header_end > 0 {
                    if let Some(len_str) = String::from_utf8_lossy(&req[..header_end])
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().to_string())
                        })
                    {
                        if let Ok(len) = len_str.parse::<usize>() {
                            let mut body = req[header_end..].to_vec();
                            while body.len() < len {
                                match stream.read(&mut buf) {
                                    Ok(0) => break,
                                    Ok(n) => body.extend_from_slice(&buf[..n]),
                                    Err(_) => break,
                                }
                            }
                        }
                    }
                }
                for part in parts {
                    let _ = stream.write_all(&part);
                    thread::sleep(Duration::from_millis(5));
                }
            }
        });
        format!("http://{addr}")
    }

    /// Spawns a server that answers a fixed QUEUE of status codes (one
    /// connection per code) for failover tests. A 200 response streams one
    /// content chunk then [DONE]; other codes return an empty body. The
    /// returned counter records how many connections were accepted.
    fn spawn_scripted_server(statuses: Vec<u16>) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let conns = connections.clone();
        thread::spawn(move || {
            for status in statuses {
                if let Ok((mut stream, _)) = listener.accept() {
                    conns.fetch_add(1, Ordering::SeqCst);
                    // Read the request (best effort) so the client can finish.
                    let mut req = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        match stream.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                req.extend_from_slice(&buf[..n]);
                                if req.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    let body = if status == 200 {
                        concat!(
                            "HTTP/1.1 200 OK\r\n",
                            "Content-Type: text/event-stream\r\n",
                            "Connection: close\r\n\r\n",
                            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
                        )
                        .to_string()
                    } else {
                        format!(
                            "HTTP/1.1 {status} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                    };
                    let _ = stream.write_all(body.as_bytes());
                    // Send [DONE] in a SEPARATE write after a pause, so a
                    // client that cancels right after the first chunk sees
                    // its flag checked before [DONE] arrives (both lines in
                    // one read batch would return Ok first).
                    if status == 200 {
                        thread::sleep(Duration::from_millis(5));
                        let _ = stream.write_all(b"data: [DONE]\n\n");
                    }
                }
            }
        });
        (format!("http://{addr}"), connections)
    }

    fn provider_at(base: &str, id: &str) -> ProviderConfig {
        ProviderConfig {
            id: id.to_string(),
            name: format!("Provider {id}"),
            base_url: format!("{base}/v1"),
            model: "mock-model".into(),
        }
    }

    fn run_failover(providers: &[ProviderConfig], cancel: &AtomicBool) -> Result<String, String> {
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(explain_with_failover(
                cancel,
                providers,
                &sample_paper(),
                "en",
                &mut |_| {},
            ))
    }

    #[test]
    fn failover_tries_next_provider_after_http_error() {
        let (url, connections) = spawn_scripted_server(vec![500, 200]);
        let cancel = AtomicBool::new(false);
        let providers = vec![provider_at(&url, "a"), provider_at(&url, "b")];

        let winner = run_failover(&providers, &cancel).expect("second provider should win");

        assert_eq!(winner, "b");
        assert_eq!(connections.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn failover_returns_winner_on_first_success() {
        let (url, connections) = spawn_scripted_server(vec![200]);
        let cancel = AtomicBool::new(false);
        let providers = vec![provider_at(&url, "a"), provider_at(&url, "b")];

        let winner = run_failover(&providers, &cancel).expect("first provider should win");

        assert_eq!(winner, "a");
        assert_eq!(connections.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failover_aggregates_when_all_fail() {
        let (url, _) = spawn_scripted_server(vec![500, 500]);
        let cancel = AtomicBool::new(false);
        let providers = vec![provider_at(&url, "a"), provider_at(&url, "b")];

        let err = run_failover(&providers, &cancel).expect_err("all providers failed");

        assert!(err.contains("All 2 providers failed"), "got: {err}");
        assert!(err.contains("Provider a"), "got: {err}");
        assert!(err.contains("Provider b"), "got: {err}");
    }

    #[test]
    fn failover_propagates_marker_and_skips_remaining_providers() {
        let (url, connections) = spawn_scripted_server(vec![200]);
        let cancel = AtomicBool::new(false);
        let providers = vec![provider_at(&url, "a"), provider_at(&url, "b")];

        // Press Stop before the chain starts: the first between-attempt
        // check must return the typed marker without contacting anyone.
        cancel.store(true, Ordering::SeqCst);
        let err = run_failover(&providers, &cancel).expect_err("cancelled chain");

        assert!(err.starts_with(cancelled_marker()), "got: {err}");
        assert_eq!(connections.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn failover_does_not_retry_after_first_chunk() {
        // Stop is pressed the moment the first chunk arrives (simulated by
        // setting the cancel flag inside on_chunk): the parser's next
        // cancellation check fires right after the chunk, so the chain
        // sees Err(marker) with delivered == true and must propagate it
        // WITHOUT trying the second provider (retrying would duplicate
        // partial text on screen).
        let (url, connections) = spawn_scripted_server(vec![200, 200]);
        let cancel = AtomicBool::new(false);
        let providers = vec![provider_at(&url, "a"), provider_at(&url, "b")];

        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(explain_with_failover(
                &cancel,
                &providers,
                &sample_paper(),
                "en",
                &mut |_| {
                    cancel.store(true, Ordering::SeqCst);
                },
            ))
            .expect_err("cancel right after first chunk");

        assert!(err.starts_with(cancelled_marker()), "got: {err}");
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "second provider must not be contacted"
        );
    }

    #[test]
    fn failover_rejects_empty_chain() {
        let cancel = AtomicBool::new(false);
        let err = run_failover(&[], &cancel).expect_err("empty chain");
        assert_eq!(err, "No providers configured");
    }

    #[test]
    fn streams_sse_chunks_in_order() {
        let sse = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: text/event-stream\r\n",
            "Connection: close\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        let url = spawn_mock_server(sse.into());
        let client = reqwest::Client::new();
        let mut chunks = Vec::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let full = runtime
            .block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                json!({ "model": "mock", "messages": [] }),
                Duration::from_secs(10),
                &CANCEL_EXPLAIN,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("stream should succeed");
        assert_eq!(full, "Hello world");
        assert_eq!(chunks, vec!["Hello", " world"]);
    }

    #[test]
    fn streams_utf8_split_across_chunks() {
        // A multi-byte Arabic character split across two TCP chunks must not
        // become a replacement-character garbage sequence: the parser buffers
        // bytes and decodes only complete lines.
        let arabic = "مرحبا بالعالم";
        let mut response = Vec::new();
        response.extend_from_slice(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        );
        response.extend_from_slice(br#"data: {"choices":[{"delta":{"content":""#);
        response.extend_from_slice(arabic.as_bytes());
        response.extend_from_slice(b"\"}}]}\n\n");
        response.extend_from_slice(b"data: [DONE]\n\n");

        // Split the response in the middle of the first Arabic character
        // (a 3-byte UTF-8 sequence) so the two halves are both invalid UTF-8.
        let content_pos = response
            .windows(arabic.len())
            .position(|w| w == arabic.as_bytes())
            .expect("arabic content present");
        let split_at = content_pos + 1;
        let url = spawn_mock_server_chunked(vec![
            response[..split_at].to_vec(),
            response[split_at..].to_vec(),
        ]);

        let client = reqwest::Client::new();
        let mut chunks = Vec::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let full = runtime
            .block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                json!({ "model": "mock", "messages": [] }),
                Duration::from_secs(10),
                &CANCEL_EXPLAIN,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("stream should succeed");
        // full must equal the exact original string: the old parser emitted
        // a replacement character at the split point instead.
        assert_eq!(full, arabic);
        assert_eq!(chunks.concat(), arabic);
    }

    #[test]
    fn handles_non_streaming_json() {
        let json_resp = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: application/json\r\n",
            "Connection: close\r\n\r\n",
            "{\"choices\":[{\"message\":{\"content\":\"Whole answer\"}}]}",
        );
        let url = spawn_mock_server(json_resp.into());
        let client = reqwest::Client::new();
        let mut chunks = Vec::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let full = runtime
            .block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                json!({ "model": "mock", "messages": [] }),
                Duration::from_secs(10),
                &CANCEL_EXPLAIN,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("non-streaming should succeed");
        assert_eq!(full, "Whole answer");
        assert_eq!(chunks, vec!["Whole answer"]);
    }

    #[test]
    fn surfaces_provider_errors() {
        let err = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"error\":\"bad key\"}";
        let url = spawn_mock_server(err.into());
        let client = reqwest::Client::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(stream_chat(
            &client,
            &format!("{url}/v1/chat/completions"),
            "bad-key",
            json!({ "model": "mock", "messages": [] }),
            Duration::from_secs(10),
            &CANCEL_EXPLAIN,
            &mut |_| {},
        ));
        let msg = result.expect_err("should fail with 401");
        assert!(msg.contains("401"), "got: {msg}");
    }

    #[test]
    fn redact_tokens_masks_key_shaped_substrings() {
        // A gateway echoing the submitted key back in a 401 body must not
        // leak it into the surfaced error text.
        let body = r#"{"error": "invalid key sk-abcdef123456"}"#;
        let out = redact_tokens(body);
        assert!(out.contains("sk-***"), "got: {out}");
        assert!(!out.contains("abcdef123456"), "got: {out}");
    }

    #[test]
    fn redact_tokens_leaves_plain_text_untouched() {
        let body = "Provider returned HTTP 401: rate limit exceeded";
        assert_eq!(redact_tokens(body), body);
    }

    #[test]
    fn redact_tokens_masks_every_token_in_body() {
        // The search must resume after each replacement, so a second token
        // in the same body is not skipped.
        let body = "invalid keys: sk-abcdef123456 and key_GHIJKLmnopqr";
        let out = redact_tokens(body);
        assert!(out.contains("sk-***"), "got: {out}");
        assert!(out.contains("key_***"), "got: {out}");
        assert!(!out.contains("abcdef123456"), "got: {out}");
        assert!(!out.contains("GHIJKLmnopqr"), "got: {out}");
    }

    #[test]
    fn redact_tokens_ignores_short_prefixes() {
        // "sk-8" is not a token; masking it would mangle legitimate text.
        assert_eq!(redact_tokens("The sk-8 model"), "The sk-8 model");
    }

    #[test]
    fn streams_content_split_mid_line() {
        // A `data:` line cut across two TCP writes must still assemble
        // into the full text: the parser buffers bytes and only decodes
        // complete lines.
        let first_event = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}";
        let sse = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
             {first_event}\n\n\
             data: {{\"choices\":[{{\"delta\":{{\"content\":\" world\"}}}}]}}\n\n\
             data: [DONE]\n\n"
        );
        // Cut the first `data:` line in half, right through the JSON.
        let cut = sse.find(first_event).unwrap() + first_event.len() / 2;
        let url = spawn_mock_server_chunked(vec![
            sse[..cut].as_bytes().to_vec(),
            sse[cut..].as_bytes().to_vec(),
        ]);

        let client = reqwest::Client::new();
        let mut chunks = Vec::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let full = runtime
            .block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                json!({ "model": "mock", "messages": [] }),
                Duration::from_secs(10),
                &CANCEL_EXPLAIN,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("split stream should succeed");
        assert_eq!(full, "Hello world");
        assert_eq!(chunks, vec!["Hello", " world"]);
    }

    #[test]
    fn ignores_keepalive_and_comment_lines() {
        // Providers emit `: ping` comment lines and stray blank lines
        // between events; neither may leak into the assembled text.
        let sse = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: text/event-stream\r\n",
            "Connection: close\r\n\r\n",
            ": ping\n\n",
            "\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
            ": keep-alive\n\n",
            "\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        let url = spawn_mock_server(sse.into());
        let client = reqwest::Client::new();
        let mut chunks = Vec::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let full = runtime
            .block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                json!({ "model": "mock", "messages": [] }),
                Duration::from_secs(10),
                &CANCEL_EXPLAIN,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("stream with keep-alives should succeed");
        assert_eq!(full, "Hello world");
        assert_eq!(chunks, vec!["Hello", " world"]);
    }

    #[test]
    fn clean_close_without_done_returns_content() {
        // A provider that closes the connection after the last event
        // (no [DONE] marker) must still yield the content received so far.
        let sse = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: text/event-stream\r\n",
            "Connection: close\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Partial answer\"}}]}\n\n",
        );
        let url = spawn_mock_server(sse.into());
        let client = reqwest::Client::new();
        let mut chunks = Vec::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let full = runtime
            .block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                json!({ "model": "mock", "messages": [] }),
                Duration::from_secs(10),
                &CANCEL_EXPLAIN,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("clean close without [DONE] should succeed");
        assert_eq!(full, "Partial answer");
        assert_eq!(chunks, vec!["Partial answer"]);
    }

    #[test]
    fn cancel_returns_marker() {
        // A mid-stream user stop must abort with the typed marker, not a
        // human string: the frontend classifies stops by exact marker.
        CANCEL_EXPLAIN.store(false, Ordering::SeqCst);

        // The mock writes one content event every ~5ms, so the test can
        // cancel while later events are still in flight (~300ms of stream
        // time remains after the first chunk lands).
        let mut parts: Vec<Vec<u8>> = vec![
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                .to_vec(),
        ];
        for i in 0..60 {
            parts.push(
                format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"c{i}\"}}}}]}}\n\n")
                    .into_bytes(),
            );
        }
        parts.push(b"data: [DONE]\n\n".to_vec());
        let url = spawn_mock_server_chunked(parts);

        let client = reqwest::Client::new();
        let (first_chunk_tx, first_chunk_rx) = std::sync::mpsc::channel();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        // Local flag: cancellation is injected per stream, so this test can
        // never race other tests that stream concurrently.
        let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag_for_thread = std::sync::Arc::clone(&cancel_flag);
        let handle = std::thread::spawn(move || {
            runtime.block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                json!({ "model": "mock", "messages": [] }),
                Duration::from_secs(10),
                &flag_for_thread,
                &mut |c| {
                    let _ = first_chunk_tx.send(c.to_string());
                },
            ))
        });

        // Wait until the first chunk arrived, then cancel: every content
        // event re-checks the flag, so the stream must abort with the marker.
        let first = first_chunk_rx.recv_timeout(Duration::from_secs(5));
        cancel_flag.store(true, Ordering::SeqCst);
        let result = handle.join().expect("stream thread should not panic");

        assert!(
            first.is_ok(),
            "first chunk should arrive before cancellation (got {first:?})"
        );
        assert_eq!(
            result.expect_err("cancelled stream must fail with the marker"),
            cancelled_marker()
        );
    }

    #[test]
    fn detects_local_base_urls() {
        // load_key's local-endpoint detection: plaintext local servers may
        // omit the API key, remote endpoints may not.
        assert!(is_local_base_url("http://localhost:11434/v1"));
        assert!(is_local_base_url("http://127.0.0.1:11434/v1"));
        assert!(!is_local_base_url("https://api.x.com/v1"));
        assert!(!is_local_base_url("https://api.openai.com/v1"));
    }

    #[test]
    fn validate_provider_accepts_valid_config() {
        let provider = ProviderConfig {
            id: "openai".into(),
            name: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o".into(),
        };
        assert!(validate_provider(&provider).is_ok());
    }

    #[test]
    fn validate_provider_rejects_invalid_config() {
        let valid = || ProviderConfig {
            id: "openai".into(),
            name: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o".into(),
        };
        let cases = [
            (
                "empty id",
                ProviderConfig {
                    id: String::new(),
                    ..valid()
                },
            ),
            (
                "blank name",
                ProviderConfig {
                    name: "  ".into(),
                    ..valid()
                },
            ),
            (
                "empty model",
                ProviderConfig {
                    model: String::new(),
                    ..valid()
                },
            ),
            (
                "bad scheme",
                ProviderConfig {
                    base_url: "ftp://bad".into(),
                    ..valid()
                },
            ),
            (
                "remote plaintext",
                ProviderConfig {
                    base_url: "http://api.example.com/v1".into(),
                    ..valid()
                },
            ),
        ];
        for (label, provider) in cases {
            assert!(
                validate_provider(&provider).is_err(),
                "{label} should be rejected"
            );
        }
    }

    // --- whole-paper reader message builders (Phases 3-4) ---

    fn reader_sample_paper() -> Paper {
        Paper {
            id: "2607.00001".into(),
            title: "A Sample Paper".into(),
            authors: vec!["Jane Doe".into()],
            published: "2026-07-30T00:00:00Z".into(),
            summary: "A sample abstract.".into(),
            pdf_url: "https://arxiv.org/pdf/2607.00001".into(),
            categories: vec!["cs.AI".into()],
            citation_count: None,
            tldr: None,
            venue: None,
        }
    }

    #[test]
    fn section_messages_mark_section_and_include_text() {
        let messages = build_section_messages(
            &reader_sample_paper(),
            2,
            5,
            "The method uses a transformer.",
            "en",
        );
        let system = messages[0]["content"].as_str().unwrap();
        let user = messages[1]["content"].as_str().unwrap();
        assert!(system.contains("ONE section of the paper at a time"));
        assert!(system.contains("research mentor"));
        assert!(user.contains("Paper title: A Sample Paper"));
        assert!(user.contains("Section 2 of 5:"));
        assert!(user.contains("The method uses a transformer."));
    }

    #[test]
    fn section_messages_truncate_very_long_sections() {
        let huge = "x".repeat(100_000);
        let messages = build_section_messages(&reader_sample_paper(), 1, 1, &huge, "en");
        let user = messages[1]["content"].as_str().unwrap();
        assert!(user.len() < 70_000, "section text must be capped");
    }

    #[test]
    fn synthesis_messages_include_full_text() {
        let messages = build_synthesis_messages(
            &reader_sample_paper(),
            "Section 1 text. Section 2 text.",
            "ar",
        );
        let system = messages[0]["content"].as_str().unwrap();
        let user = messages[1]["content"].as_str().unwrap();
        assert!(system.contains("الخلاصة النهائية"));
        assert!(user.contains("Full text of the paper:"));
        assert!(user.contains("Section 2 text."));
    }

    #[test]
    fn qa_messages_include_selection_context_and_question() {
        let messages = build_qa_messages(
            &reader_sample_paper(),
            "Why does the method work?",
            Some("The transformer encodes tokens."),
            Some("Section 2: the method."),
            &[],
            "en",
        );
        let user = messages[1]["content"].as_str().unwrap();
        assert!(user.contains("Selected passage from the paper:\nThe transformer encodes tokens."));
        assert!(user.contains("Relevant part of the paper:\nSection 2: the method."));
        assert!(user.contains("Question: Why does the method work?"));
    }

    #[test]
    fn qa_messages_work_without_selection_or_context() {
        let messages = build_qa_messages(
            &reader_sample_paper(),
            "What is the main idea?",
            None,
            None,
            &[],
            "en",
        );
        let user = messages[1]["content"].as_str().unwrap();
        assert!(!user.contains("Selected passage"));
        assert!(!user.contains("Relevant part"));
        assert!(user.contains("Question: What is the main idea?"));
    }

    #[test]
    fn qa_messages_include_conversation_history_in_order() {
        let history = vec![
            ChatTurn {
                role: "user".into(),
                content: "What is an embedding?".into(),
            },
            ChatTurn {
                role: "assistant".into(),
                content: "A vector that represents a token.".into(),
            },
            ChatTurn {
                role: "user".into(),
                content: "And the query?".into(),
            },
        ];
        let messages = build_qa_messages(
            &reader_sample_paper(),
            "What about the keys?",
            None,
            None,
            &history,
            "en",
        );
        assert_eq!(messages.len(), 5); // system + 3 history turns + question
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "What is an embedding?");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["content"], "A vector that represents a token.");
        assert_eq!(messages[3]["content"], "And the query?");
        assert!(
            messages[4]["content"]
                .as_str()
                .unwrap()
                .contains("Question: What about the keys?")
        );
    }

    #[test]
    #[ignore = "touches the real OS keychain; run locally with --ignored"]
    fn keychain_roundtrip_on_real_vault() {
        // The standing 30-second manual check, automated: save, read and
        // delete a throwaway secret through the REAL OS keychain (Windows
        // Credential Manager / macOS Keychain). Ignored by default so CI
        // runners without an interactive vault stay green; run locally with
        // `cargo test -- --ignored keychain_roundtrip`.
        let service = "papyrus-test";
        let account = format!("roundtrip-{}", std::process::id());
        let secret = "papyrus-test-secret-42";
        set_key(service, &account, secret).expect("save should work");
        let read = get_key(service, &account).expect("read should work");
        assert_eq!(read.as_deref(), Some(secret));
        delete_key(service, &account).expect("delete should work");
        assert_eq!(get_key(service, &account).expect("read after delete"), None);
    }

    #[test]
    fn section_streaming_roundtrip_over_mock_server() {
        // The reader commands share stream_chat; verify a section request
        // streams content through the same SSE path as explain_paper.
        // Raw string literal + explicit CRLF escapes (editing tools
        // mangle bare \r escapes on this machine).
        let sse = concat!(
            r#"HTTP/1.1 200 OK"#,
            "\u{000d}\u{000a}",
            r#"Content-Type: text/event-stream"#,
            "\u{000d}\u{000a}",
            r#"Connection: close"#,
            "\u{000d}\u{000a}\u{000d}\u{000a}",
            r#"data: {"choices":[{"delta":{"content":"Section"}}]}"#,
            "\u{000a}\u{000a}",
            r#"data: {"choices":[{"delta":{"content":" explained."}}]}"#,
            "\u{000a}\u{000a}",
            "data: [DONE]\u{000a}\u{000a}"
        );
        let url = spawn_mock_server(sse.into());
        let client = reqwest::Client::new();
        let messages = build_section_messages(&reader_sample_paper(), 1, 2, "Intro text.", "en");
        let body = json!({ "model": "mock", "messages": messages, "stream": true });
        let mut chunks = Vec::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let full = runtime
            .block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                body,
                Duration::from_secs(10),
                &CANCEL_EXPLAIN,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("stream should succeed");
        assert_eq!(full, "Section explained.");
        assert_eq!(chunks.join(""), "Section explained.");
    }
}
