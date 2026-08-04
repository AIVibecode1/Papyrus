#[cfg(test)]
use std::time::Duration;

#[cfg(test)]
use crate::papers::Paper;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;

pub(crate) mod commands;
mod keychain;
mod prompts;
mod registry;
mod stream;

// The test module (below) reaches the internal items through these
// re-exports; they are test-only so the non-test build does not see
// them as unused.
#[cfg(test)]
pub(crate) use commands::*;
#[cfg(test)]
pub(crate) use keychain::*;
#[cfg(test)]
pub(crate) use prompts::*;
#[cfg(test)]
pub(crate) use registry::*;
#[cfg(test)]
pub(crate) use stream::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
}

#[cfg(test)]
mod tests {
    /// Shared never-cancelled flag for parser tests that do not
    /// exercise cancellation (each such test gets its own local
    /// flag when it does).
    static TEST_FLAG: AtomicBool = AtomicBool::new(false);

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
        assert!(ar[0]["content"].as_str().unwrap().contains("بالعربية"));
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
                &TEST_FLAG,
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
                &TEST_FLAG,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("stream should succeed");
        // full must equal the exact original string: the old parser emitted
        // a replacement character at the split point instead.
        assert_eq!(full, arabic);
        assert_eq!(chunks.concat(), arabic);
    }

    #[test]
    fn keeps_partial_content_when_the_stream_breaks_mid_body() {
        // A truncated body (Content-Length larger than the bytes actually
        // sent) makes the body stream error mid-transfer. Content already
        // received must be kept, like the clean-close case: gateways that
        // reset long SSE streams must not throw the answer away.
        let response = concat!(
            "HTTP/1.1 200 OK
",
            "Content-Type: text/event-stream
",
            "Content-Length: 500
",
            "Connection: close

",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Partial \"}}]}

",
        );
        let url = spawn_mock_server_chunked(vec![response.as_bytes().to_vec()]);
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
                &TEST_FLAG,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("partial content must be returned, not an error");
        assert_eq!(full, "Partial ");
        assert_eq!(chunks, vec!["Partial "]);
    }

    #[test]
    fn errors_when_the_stream_breaks_before_any_content() {
        // Same truncated body, but nothing usable arrives first: the real
        // error must surface (no silent empty success).
        let response = concat!(
            "HTTP/1.1 200 OK
",
            "Content-Type: text/event-stream
",
            "Content-Length: 500
",
            "Connection: close

",
        );
        let url = spawn_mock_server_chunked(vec![response.as_bytes().to_vec()]);
        let client = reqwest::Client::new();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let err = runtime
            .block_on(stream_chat(
                &client,
                &format!("{url}/v1/chat/completions"),
                "test-key",
                json!({ "model": "mock", "messages": [] }),
                Duration::from_secs(10),
                &TEST_FLAG,
                &mut |_| {},
            ))
            .expect_err("an empty broken stream must error");
        assert!(
            err.contains("Stream error") || err.contains("unexpected"),
            "got: {err}"
        );
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
                &TEST_FLAG,
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
            &TEST_FLAG,
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
    fn redact_tokens_masks_prefixless_long_keys() {
        // Custom gateways echo raw keys with no recognizable prefix; a
        // long opaque run must be masked even without sk-/key-/ghp_.
        let body = "401 invalid api_key: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f";
        let out = redact_tokens(body);
        assert!(
            !out.contains("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f"),
            "got: {out}"
        );
        assert!(out.contains("***"), "got: {out}");
    }

    #[test]
    fn redact_tokens_keeps_urls_and_short_hashes() {
        // URLs and short identifiers must survive the generic pass: a
        // slash breaks the run, and short runs are never masked.
        let body = "check https://example.com/status/abc123 for details (id 42)";
        assert_eq!(redact_tokens(body), body);
    }

    #[test]
    fn local_base_url_requires_a_real_loopback_host() {
        assert!(is_local_base_url("http://localhost:11434/v1"));
        assert!(is_local_base_url("https://127.0.0.1:8080"));
        // A remote host whose NAME merely contains "localhost" is not
        // local and must not skip the API-key requirement.
        assert!(!is_local_base_url("https://localhost.evil.com/v1"));
        assert!(!is_local_base_url("https://attacker.com/127.0.0.1/v1"));
        assert!(!is_local_base_url("https://api.example.com/v1"));
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
                &TEST_FLAG,
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
                &TEST_FLAG,
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
                &TEST_FLAG,
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
        // (each test owns a local flag; no global reset needed)

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
                &TEST_FLAG,
                &mut |c| chunks.push(c.to_string()),
            ))
            .expect("stream should succeed");
        assert_eq!(full, "Section explained.");
        assert_eq!(chunks.join(""), "Section explained.");
    }

    #[test]
    fn operations_cancel_independently() {
        // Two registered operations: stopping one must not touch the other,
        // and an unknown id must be a no-op.
        let flag_a = register_operation("op-a");
        let flag_b = register_operation("op-b");

        cancel_operation("op-a");
        cancel_operation("does-not-exist");

        assert!(flag_a.load(Ordering::SeqCst), "op-a must be cancelled");
        assert!(!flag_b.load(Ordering::SeqCst), "op-b must be untouched");

        unregister_operation("op-a");
        unregister_operation("op-b");
    }

    #[test]
    fn unregister_removes_the_flag_so_late_stops_are_noops() {
        let flag = register_operation("op-late");
        unregister_operation("op-late");
        // The stored Arc is the only reference left after unregistering:
        // a stop can no longer reach it (and must not panic).
        cancel_operation("op-late");
        assert!(!flag.load(Ordering::SeqCst), "late stop must not cancel");
    }
}
