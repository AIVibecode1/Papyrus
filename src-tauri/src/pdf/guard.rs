//! Guarded PDF download: SSRF validation, DNS pinning, manual redirect
//! policy and the response size cap. Every hop is validated and pinned
//! before requesting; redirects are never followed automatically.

use futures_util::StreamExt;

use crate::papers::USER_AGENT;

const MAX_PDF_BYTES: u64 = 30 * 1024 * 1024; // 30 MB safety cap
const MAX_PDF_REDIRECTS: usize = 5;

/// HTTP client for PDF downloads: same UA as paper fetching, but
/// redirects are NEVER followed automatically. A redirect is a fresh
/// decision point (each hop is re-validated and re-pinned), so
/// auto-following here would be a validation bypass.
fn pdf_client(pinned: Option<(&str, Vec<std::net::SocketAddr>)>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none());
    if let Some((host, ips)) = pinned {
        // Pin this download to the IPs we validated: the connection can
        // no longer be rebound by DNS between validation and connect.
        // reqwest 0.13 resolves one address per call; they accumulate.
        for ip in &ips {
            builder = builder.resolve(host, *ip);
        }
    }
    builder
        .build()
        .expect("reqwest client build cannot fail at runtime")
}

/// Reads a response body in chunks, refusing anything over `limit` BEFORE
/// unbounded buffering: a declared Content-Length over the limit is
/// rejected up front, and the stream itself is cut off at the limit.
async fn fetch_body(response: reqwest::Response, limit: u64) -> Result<Vec<u8>, String> {
    if let Some(len) = response.content_length()
        && len > limit
    {
        return Err("The PDF is too large to open in the app".into());
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read the PDF: {e}"))?;
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("The PDF is too large to open in the app".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Raw downloader core (no URL policy): unit-testable against local
/// servers. Test-only since the command path uses `download_pdf_guarded`.
#[cfg(test)]
async fn download_pdf_with_limit(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let response = pdf_client(None)
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download the PDF: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("PDF download returned HTTP {status}"));
    }
    fetch_body(response, limit).await
}

/// Downloads a paper's PDF bytes (no caching). Test-only: the command
/// path runs the validated, pinned downloader instead.
#[cfg(test)]
async fn download_pdf(url: &str) -> Result<Vec<u8>, String> {
    download_pdf_with_limit(url, MAX_PDF_BYTES).await
}

/// SSRF guard for source-provided PDF urls (S2 `openAccessPdf` hosts are
/// arbitrary publisher domains, so they cannot be derived from the id).
/// Rejects anything but https with no credentials, and refuses hosts that
/// resolve to loopback/private/link-local addresses (the metadata IP
/// 169.254.169.254 is link-local and covered). Returns the validated host
/// and its public addresses so the download can be pinned to them.
async fn validate_public_https(url: &str) -> Result<(String, Vec<std::net::SocketAddr>), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| "PDF url must be https".to_string())?;
    if rest.contains('@') {
        return Err("PDF url must not carry credentials".into());
    }
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "PDF url has no host".to_string())?;
    let ips: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "PDF host could not be resolved".to_string())?
        .collect();
    if ips.is_empty() {
        return Err("PDF host could not be resolved".to_string());
    }
    for ip in &ips {
        let private = match ip.ip() {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_unspecified()
                    || v4.is_multicast()
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    // Link-local: fe80::/10 (metadata endpoints live here).
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
        if private {
            return Err("PDF host resolves to a private address".into());
        }
    }
    Ok((host.to_string(), ips))
}

/// Decides the next hop for a response. Returns None when the response is
/// not a redirect; errors on missing or non-https locations. Pure so the
/// redirect policy is unit-testable without a server.
fn next_redirect_target(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> Result<Option<String>, String> {
    if !status.is_redirection() {
        return Ok(None);
    }
    let location = headers
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "PDF redirect without a location".to_string())?;
    if !location.starts_with("https://") {
        return Err("PDF redirect target must be https".into());
    }
    Ok(Some(location.to_string()))
}

/// Interprets a guarded hop's response: Ok(None) means the download is
/// final (success), Ok(Some(next)) means follow the redirect, Err is a
/// policy violation or HTTP failure. Pure so the decision sequence is
/// testable; the loop re-validates the next target with
/// validate_public_https before requesting it.
fn interpret_hop(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> Result<Option<String>, String> {
    if let Some(next) = next_redirect_target(status, headers)? {
        return Ok(Some(next));
    }
    if !status.is_success() {
        return Err(format!("PDF download returned HTTP {status}"));
    }
    Ok(None)
}

/// Full download path for the command: validates the https/public policy,
/// pins the connection to the validated addresses (DNS-rebinding guard),
/// and follows redirects only one hop at a time, re-validating each target.
pub(crate) async fn download_pdf_guarded(url: &str) -> Result<Vec<u8>, String> {
    let mut target = url.to_string();
    for _ in 0..=MAX_PDF_REDIRECTS {
        let (host, ips) = validate_public_https(&target).await?;
        let response = pdf_client(Some((host.as_str(), ips)))
            .get(&target)
            .send()
            .await
            .map_err(|e| format!("Failed to download the PDF: {e}"))?;
        let status = response.status();
        if let Some(next) = interpret_hop(status, response.headers())? {
            target = next;
            continue;
        }
        return fetch_body(response, MAX_PDF_BYTES).await;
    }
    Err("Too many PDF redirects".into())
}

#[cfg(test)]
pub(crate) const PDF_BYTES: &[u8] = b"%PDF-1.4 test-pdf-bytes";

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    fn spawn_pdf_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let body = PDF_BYTES;
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: application/pdf\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
            }
        });
        format!("http://{addr}/paper.pdf")
    }

    fn run<T>(fut: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
        tokio::runtime::Runtime::new().unwrap().block_on(fut)
    }

    #[test]
    fn downloads_pdf_bytes() {
        let url = spawn_pdf_server();
        let bytes = run(download_pdf(&url)).expect("download should succeed");
        assert_eq!(bytes, PDF_BYTES);
    }

    #[test]
    fn download_fails_on_http_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
            }
        });
        let url = format!("http://{addr}/missing.pdf");
        let err = run(download_pdf(&url)).expect_err("404 must fail");
        assert!(err.contains("HTTP 404"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_declared_oversized_body_before_reading() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                // Declares far more than the limit; must be rejected on the
                // header alone, before any body byte is consumed.
                let crlf = String::from_utf8(vec![13, 10]).unwrap();
                let head = format!(
                    "HTTP/1.1 200 OK{crlf}content-length: 99999999{crlf}connection: close{crlf}{crlf}"
                );
                let _ = stream.write_all(head.as_bytes());
                // No body is sent: if the client tried to read it, this
                // test would hang; the declared-length guard must fire.
            }
        });
        let url = format!("http://{addr}/huge.pdf");
        let err = run(download_pdf_with_limit(&url, 1024)).expect_err("must reject the size");
        assert!(err.contains("too large"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_an_oversized_body_while_streaming() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                // No content-length: the limit must be enforced mid-stream.
                let crlf = String::from_utf8(vec![13, 10]).unwrap();
                let head = format!("HTTP/1.1 200 OK{crlf}connection: close{crlf}{crlf}");
                let _ = stream.write_all(head.as_bytes());
                let chunk = vec![b'x'; 4096];
                for _ in 0..4 {
                    let _ = stream.write_all(&chunk);
                }
            }
        });
        let url = format!("http://{addr}/big.pdf");
        let err = run(download_pdf_with_limit(&url, 1024)).expect_err("must stop at the limit");
        assert!(err.contains("too large"), "unexpected error: {err}");
    }

    #[test]
    fn redirects_are_never_followed_automatically() {
        // A redirect to a second server that would happily serve bytes:
        // the downloader must return the 3xx as an error instead of
        // chasing it (each hop must go through validation again).
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_addr = target.local_addr().unwrap();
        thread::spawn(move || {
            for stream in target.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(PDF_BYTES);
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let crlf = String::from_utf8(vec![13, 10]).unwrap();
                let head = format!(
                    "HTTP/1.1 302 Found{crlf}location: http://{target_addr}/paper.pdf{crlf}content-length: 0{crlf}connection: close{crlf}{crlf}"
                );
                let _ = stream.write_all(head.as_bytes());
            }
        });
        let url = format!("http://{addr}/paper.pdf");
        let err = run(download_pdf(&url)).expect_err("a redirect must not be followed");
        assert!(err.contains("HTTP 302"), "unexpected error: {err}");
    }

    #[test]
    fn redirect_policy_rejects_everything_but_absolute_https() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("https://cdn.example/paper.pdf"),
        );
        let next = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &headers) })
            .expect("a valid redirect target must be accepted");
        assert_eq!(next.as_deref(), Some("https://cdn.example/paper.pdf"));

        headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("http://evil.example/paper.pdf"),
        );
        let err = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &headers) })
            .expect_err("plaintext redirect targets must be rejected");
        assert!(err.contains("must be https"), "unexpected error: {err}");

        let no_location = reqwest::header::HeaderMap::new();
        let err = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &no_location) })
            .expect_err("a redirect without a location must be rejected");
        assert!(
            err.contains("without a location"),
            "unexpected error: {err}"
        );

        let ok_headers = reqwest::header::HeaderMap::new();
        let next = run(async { next_redirect_target(reqwest::StatusCode::OK, &ok_headers) })
            .expect("a non-redirect status is not a hop");
        assert!(next.is_none());
    }

    #[test]
    fn interpret_hop_decides_follow_error_and_done() {
        let mut redirect = reqwest::header::HeaderMap::new();
        redirect.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("https://cdn.example/paper.pdf"),
        );
        let next = interpret_hop(reqwest::StatusCode::FOUND, &redirect)
            .expect("redirect must be followed");
        assert_eq!(next.as_deref(), Some("https://cdn.example/paper.pdf"));

        let err = interpret_hop(reqwest::StatusCode::INTERNAL_SERVER_ERROR, &redirect)
            .expect_err("an http error is terminal");
        assert!(err.contains("500"), "unexpected error: {err}");

        let done = interpret_hop(reqwest::StatusCode::OK, &redirect).expect("ok is final");
        assert!(done.is_none());
    }

    #[test]
    fn guarded_redirect_chain_revalidates_the_next_target() {
        // The guarded loop's re-validation is what blocks SSRF via
        // redirects: hop 1 returns a Location, and the loop calls
        // validate_public_https on that target BEFORE requesting it. A
        // redirect pointing at a loopback/private host must be rejected
        // mid-chain, exactly as the real loop would.
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("https://127.0.0.1/evil.pdf"),
        );
        let next = interpret_hop(reqwest::StatusCode::FOUND, &headers)
            .expect("the hop decision accepts the redirect");
        let next = next.expect("a redirect target");

        let err = run(validate_public_https(&next))
            .expect_err("the redirect target must fail re-validation");
        assert!(err.contains("private"), "unexpected error: {err}");

        // The same for a host name resolving to loopback.
        let mut local_headers = reqwest::header::HeaderMap::new();
        local_headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("https://localhost/evil.pdf"),
        );
        let next = interpret_hop(reqwest::StatusCode::FOUND, &local_headers)
            .expect("the hop decision accepts the redirect");
        let err = run(validate_public_https(&next.expect("a redirect target")))
            .expect_err("localhost must fail re-validation");
        assert!(err.contains("private"), "unexpected error: {err}");
    }

    #[test]
    fn ensure_public_https_rejects_loopback_and_private_targets() {
        // IP literals resolve without DNS; localhost resolves via the
        // hosts file — both deterministic, no external network.
        let cases = [
            "http://127.0.0.1/paper.pdf",               // plaintext
            "https://127.0.0.1/paper.pdf",              // loopback
            "https://10.0.0.5/paper.pdf",               // private
            "https://192.168.1.10/paper.pdf",           // private
            "https://169.254.169.254/latest/meta-data", // metadata IP
            "https://localhost/paper.pdf",              // loopback via hosts file
            "https://user:pass@arxiv.org/paper.pdf",    // credentials
            "https:///paper.pdf",                       // no host
        ];
        for url in cases {
            let err = run(validate_public_https(url)).expect_err("must reject {url}");
            assert!(!err.is_empty(), "expected an error for {url}");
        }
    }
}
