use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri_plugin_keyring::KeyringExt;

use crate::papers::Paper;

const KEYRING_SERVICE: &str = "papyrus";
const EXPLAIN_TIMEOUT: Duration = Duration::from_secs(120);
const TEST_TIMEOUT: Duration = Duration::from_secs(30);

static CANCEL_EXPLAIN: AtomicBool = AtomicBool::new(false);

const SYSTEM_PROMPT_EN: &str = "You are Papyrus, an assistant that explains academic research \
papers to a general audience. Explain the paper in simple, clear language. Structure your \
answer as short paragraphs covering: (1) What the paper is about — the main idea, (2) How it \
works — the method in plain terms, (3) Key results, (4) Why it matters. Keep it around \
200-300 words. Do not use markdown tables. Always respond in English.";

const SYSTEM_PROMPT_AR: &str = "أنت «بابيروس»، مساعد يشرح الأوراق البحثية الأكاديمية لعامة \
الجمهور بلغة بسيطة وواضحة. نظّم إجابتك في فقرات قصيرة تغطي: (1) ما موضوع الورقة — الفكرة \
الرئيسية، (2) كيف تعمل — المنهج بعبارات بسيطة، (3) النتائج الرئيسية، (4) لماذا هي مهمة. \
اجعل الشرح حوالي ٢٠٠-٣٠٠ كلمة. لا تستخدم جداول ماركداون. أجب دائمًا باللغة العربية الفصحى.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
}

/// Normalizes a user-provided base URL into a full chat-completions URL.
fn build_chat_url(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("Base URL must start with http:// or https://".into());
    }
    if base.ends_with("/chat/completions") {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/chat/completions"))
    }
}

fn build_messages(paper: &Paper, language: &str) -> Vec<Value> {
    let system = if language == "ar" {
        SYSTEM_PROMPT_AR
    } else {
        SYSTEM_PROMPT_EN
    };
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

/// Loads the stored API key for a provider. Local endpoints (Ollama etc.) may have no key.
fn load_key(app: &tauri::AppHandle, provider: &ProviderConfig) -> Result<String, String> {
    let key = app
        .keyring()
        .get_password(KEYRING_SERVICE, &provider.id)
        .map_err(|e| format!("Failed to read key from the system keychain: {e}"))?;
    let is_local = provider.base_url.contains("localhost") || provider.base_url.contains("127.0.0.1");
    match key {
        Some(k) => Ok(k),
        None if is_local => Ok(String::new()),
        None => Err(
            "No API key found for this provider. Add it in Settings → Providers.".into(),
        ),
    }
}

/// Streams a chat completion from any OpenAI-compatible endpoint, invoking `on_chunk`
/// for each content delta. Returns the full assembled text.
async fn stream_chat(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    body: Value,
    on_chunk: &mut (dyn FnMut(&str) + Send),
) -> Result<String, String> {
    let mut request = client.post(url);
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
            truncate(&text, 300)
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
        let mut buf = String::new();
        loop {
            let chunk = stream
                .next()
                .await
                .ok_or_else(|| "Stream ended unexpectedly".to_string())?
                .map_err(|e| format!("Stream error: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim_end_matches('\r').to_string();
                buf.drain(..=pos);
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        return Ok(full);
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        if let Some(content) = value
                            .pointer("/choices/0/delta/content")
                            .and_then(|c| c.as_str())
                        {
                            if CANCEL_EXPLAIN.load(Ordering::SeqCst) {
                                return Err("Stopped by the user".into());
                            }
                            full.push_str(content);
                            on_chunk(content);
                        }
                    }
                }
            }
            if CANCEL_EXPLAIN.load(Ordering::SeqCst) {
                return Err("Stopped by the user".into());
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
            if CANCEL_EXPLAIN.load(Ordering::SeqCst) {
                return Err("Stopped by the user".into());
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
#[tauri::command]
pub async fn explain_paper(
    app: tauri::AppHandle,
    provider: ProviderConfig,
    paper: Paper,
    language: String,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    validate_provider(&provider)?;
    CANCEL_EXPLAIN.store(false, Ordering::SeqCst);

    let key = load_key(&app, &provider)?;
    let url = build_chat_url(&provider.base_url)?;
    let client = reqwest::Client::builder()
        .timeout(EXPLAIN_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let body = json!({
        "model": provider.model,
        "messages": build_messages(&paper, &language),
        "stream": true,
        "temperature": 0.4,
    });

    stream_chat(&client, &url, &key, body, &mut |chunk| {
        let _ = on_chunk.send(chunk.to_string());
    })
    .await
    .map(|_| ())
}

/// Sends a minimal request to verify a provider configuration.
#[tauri::command]
pub async fn test_provider(
    app: tauri::AppHandle,
    provider: ProviderConfig,
) -> Result<String, String> {
    validate_provider(&provider)?;
    let key = load_key(&app, &provider)?;
    let url = build_chat_url(&provider.base_url)?;
    let client = reqwest::Client::builder()
        .timeout(TEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let body = json!({
        "model": provider.model,
        "messages": [{"role": "user", "content": "Reply with the single word: OK"}],
        "stream": false,
        "max_tokens": 8,
    });

    let reply = stream_chat(&client, &url, &key, body, &mut |_| {}).await?;
    Ok(reply.trim().to_string())
}

/// Cancels the currently running explanation (if any).
#[tauri::command]
pub fn stop_explaining() {
    CANCEL_EXPLAIN.store(true, Ordering::SeqCst);
}

/// Saves an API key to the OS keychain (Windows Credential Manager / macOS Keychain).
#[tauri::command]
pub async fn save_api_key(
    app: tauri::AppHandle,
    provider_id: String,
    key: String,
) -> Result<(), String> {
    if provider_id.is_empty() || provider_id.len() > 64 {
        return Err("Invalid provider id".into());
    }
    if key.trim().is_empty() {
        return Err("API key cannot be empty".into());
    }
    app.keyring()
        .set_password(KEYRING_SERVICE, &provider_id, key.trim())
        .map_err(|e| format!("Failed to save key to the system keychain: {e}"))
}

/// Removes a stored API key from the OS keychain.
#[tauri::command]
pub async fn delete_api_key(app: tauri::AppHandle, provider_id: String) -> Result<(), String> {
    app.keyring()
        .delete_password(KEYRING_SERVICE, &provider_id)
        .map_err(|e| format!("Failed to remove key from the system keychain: {e}"))
}

/// Reports whether a key is stored for the provider — never exposes the key itself.
#[tauri::command]
pub async fn has_api_key(app: tauri::AppHandle, provider_id: String) -> Result<bool, String> {
    app.keyring()
        .get_password(KEYRING_SERVICE, &provider_id)
        .map(|k| k.is_some())
        .map_err(|e| format!("Failed to read key from the system keychain: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
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
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{addr}")
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
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("stream should succeed");
        assert_eq!(full, "Hello world");
        assert_eq!(chunks, vec!["Hello", " world"]);
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
            &mut |_| {},
        ));
        let msg = result.expect_err("should fail with 401");
        assert!(msg.contains("401"), "got: {msg}");
    }
}
