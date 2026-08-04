use std::fs;
use std::path::PathBuf;

use futures_util::StreamExt;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

use crate::papers::USER_AGENT;

const MAX_PDF_BYTES: u64 = 30 * 1024 * 1024; // 30 MB safety cap
const MAX_PDF_REDIRECTS: usize = 5;
const PDF_CACHE_DIR: &str = "pdfs";

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

/// Builds the canonical arXiv PDF URL from a paper id (e.g.
/// `2607.29762v1` → `https://arxiv.org/pdf/2607.29762`). Never trusts the
/// webview with the fetch target. Rejects anything that is not an arXiv
/// id shape: the id must be `[a-z]+\.[0-9]+` optionally followed by `vN`.
fn arxiv_pdf_url(paper_id: &str) -> Result<String, String> {
    let id = paper_id.trim();
    // A version suffix (vN) at the very end is stripped; anything else
    // makes the whole id invalid (never truncate before validating).
    let base = match id.rfind('v') {
        Some(pos)
            if pos > 0
                && !id[pos + 1..].is_empty()
                && id[pos + 1..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            &id[..pos]
        }
        _ => id,
    };
    let valid = !base.is_empty()
        && base.contains('.')
        && !base.ends_with('v')
        && base
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.');
    if !valid {
        return Err("Invalid paper id".into());
    }
    Ok(format!("https://arxiv.org/pdf/{base}"))
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

/// Full download path for the command: validates the https/public policy,
/// pins the connection to the validated addresses (DNS-rebinding guard),
/// and follows redirects only one hop at a time, re-validating each target.
async fn download_pdf_guarded(url: &str) -> Result<Vec<u8>, String> {
    let mut target = url.to_string();
    for _ in 0..=MAX_PDF_REDIRECTS {
        let (host, ips) = validate_public_https(&target).await?;
        let response = pdf_client(Some((host.as_str(), ips)))
            .get(&target)
            .send()
            .await
            .map_err(|e| format!("Failed to download the PDF: {e}"))?;
        let status = response.status();
        if let Some(next) = next_redirect_target(status, response.headers())? {
            target = next;
            continue;
        }
        if !status.is_success() {
            return Err(format!("PDF download returned HTTP {status}"));
        }
        return fetch_body(response, MAX_PDF_BYTES).await;
    }
    Err("Too many PDF redirects".into())
}

/// Downloads a paper's PDF and caches it on disk keyed by the paper id, so
/// the viewer and the text extractor never download the same PDF twice.
/// The fetch target is DERIVED server-side: arXiv ids map to the canonical
/// arXiv PDF url; `s2:` ids (source-provided hosts) pass their url through
/// the https/public-host guard. The webview never picks a fetch target.
#[tauri::command]
pub async fn fetch_pdf(
    app: AppHandle,
    paper_id: String,
    url: Option<String>,
) -> Result<Response, String> {
    let path = cache_path(&app, &paper_id, url.as_deref())?;
    if let Ok(bytes) = fs::read(&path)
        && !bytes.is_empty()
    {
        return Ok(Response::new(bytes));
    }

    let target = if paper_id.starts_with("s2:") {
        url.ok_or_else(|| "A PDF url is required for this paper".to_string())?
    } else {
        arxiv_pdf_url(&paper_id)?
    };
    // Validation and DNS pinning happen inside, per hop, including
    // redirects; the webview never picks a fetch target.
    let bytes = download_pdf_guarded(&target).await?;
    // Best-effort cache write: a full disk is not a reason to fail the read.
    let _ = fs::write(&path, &bytes);
    Ok(Response::new(bytes))
}

/// Stable FNV-1a 64-bit hash. Cache names must be deterministic across app
/// versions (std's DefaultHasher is explicitly not) and distinct for
/// distinct identities, so the filename derives from the complete source
/// identity instead of character filtering.
fn stable_hash(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Cache identity: source plus paper id, and for S2 papers the validated
/// URL (the host is part of what the bytes came from).
fn cache_file_name(source: &str, paper_id: &str, url: Option<&str>) -> String {
    let mut identity = format!("{source}|{paper_id}");
    if let Some(url) = url {
        identity.push('|');
        identity.push_str(url);
    }
    format!("pdf-{:016x}.pdf", stable_hash(&identity))
}

/// The pre-hash cache name (safe characters only), kept as a one-time
/// migration target so existing users keep their cache hits.
fn legacy_cache_name(paper_id: &str) -> Option<String> {
    let safe: String = paper_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if safe.is_empty() { None } else { Some(safe) }
}

fn cache_path(app: &AppHandle, paper_id: &str, url: Option<&str>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data directory unavailable: {e}"))?
        .join(PDF_CACHE_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the PDF cache directory: {e}"))?;
    let source = if paper_id.starts_with("s2:") {
        "s2"
    } else {
        "arxiv"
    };
    let path = dir.join(cache_file_name(source, paper_id, url));
    if !path.exists()
        && let Some(legacy) = legacy_cache_name(paper_id)
    {
        let legacy_path = dir.join(format!("{legacy}.pdf"));
        if legacy_path.exists() {
            // One-time migration: keep the cached bytes, new name from now on.
            let _ = fs::rename(&legacy_path, &path);
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    const PDF_BYTES: &[u8] = b"%PDF-1.4 test-pdf-bytes";

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
    fn cache_file_roundtrip() {
        // The command wrapper needs a Tauri AppHandle which is not
        // constructible in unit tests; verify the cache contract itself:
        // bytes written once are read back unchanged.
        let dir = std::env::temp_dir().join(format!("papyrus-pdf-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("2607.00001.pdf");
        fs::write(&path, PDF_BYTES).unwrap();
        let cached = fs::read(&path).unwrap();
        assert_eq!(cached, PDF_BYTES);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_path_sanitizes_ids_and_rejects_empty() {
        // The legacy (pre-hash) name keeps only safe characters; the
        // collision-resistant name derives from the full identity.
        assert_eq!(
            legacy_cache_name("cs.ai.2607.00001v1").as_deref(),
            Some("cs.ai.2607.00001v1")
        );
        assert_eq!(legacy_cache_name("!@#$%"), None);
        let name = cache_file_name("arxiv", "cs.ai.2607.00001v1", None);
        assert!(name.starts_with("pdf-") && name.ends_with(".pdf"));
    }

    #[test]
    fn cache_names_are_stable_and_collision_resistant() {
        let a = cache_file_name("arxiv", "2607.00001", None);
        let b = cache_file_name("arxiv", "2607.00002", None);
        assert_ne!(a, b, "distinct ids must not share a cache file");
        assert_eq!(
            cache_file_name("arxiv", "2607.00001", None),
            a,
            "the same identity must hash stably"
        );
        let c = cache_file_name("s2", "s2:abc", Some("https://a.example/paper.pdf"));
        let d = cache_file_name("s2", "s2:abc", Some("https://b.example/paper.pdf"));
        assert_ne!(c, d, "distinct source urls must not share a cache file");
        assert_ne!(a, c, "arxiv and s2 identities must not collide");
        let e = cache_file_name("arxiv", "cs.ai.2607.00001", None);
        assert_ne!(a, e, "ids sharing a sanitized prefix must not collide");
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

        let mut no_location = reqwest::header::HeaderMap::new();
        let err = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &no_location) })
            .expect_err("a redirect without a location must be rejected");
        assert!(
            err.contains("without a location"),
            "unexpected error: {err}"
        );

        let mut ok_headers = reqwest::header::HeaderMap::new();
        let next = run(async { next_redirect_target(reqwest::StatusCode::OK, &mut ok_headers) })
            .expect("a non-redirect status is not a hop");
        assert!(next.is_none());
    }

    #[test]
    fn arxiv_pdf_url_accepts_versioned_and_bare_ids() {
        assert_eq!(
            arxiv_pdf_url("2607.29762v1").expect("versioned id should build"),
            "https://arxiv.org/pdf/2607.29762"
        );
        assert_eq!(
            arxiv_pdf_url("2607.29762").expect("bare id should build"),
            "https://arxiv.org/pdf/2607.29762"
        );
        // Old-style ids with a category prefix still pass.
        assert_eq!(
            arxiv_pdf_url("cs.ai.2607.00001v2").expect("prefixed id should build"),
            "https://arxiv.org/pdf/cs.ai.2607.00001"
        );
    }

    #[test]
    fn arxiv_pdf_url_rejects_garbage() {
        for bad in [
            "",                               // empty
            "nodots",                         // no dot
            "2607.29762v1/../etc/passwd",     // path separator
            "https://evil.example/paper.pdf", // full url, not an id
            "2607.29762v1!x",                 // invalid char
        ] {
            assert_eq!(
                arxiv_pdf_url(bad),
                Err("Invalid paper id".into()),
                "must reject {bad:?}"
            );
        }
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

    #[test]
    fn s2_pdf_requires_a_url_and_guards_it() {
        // s2: without a url -> error (not derivable).
        let err = arxiv_pdf_url("s2:abc123").expect_err("s2 ids are not arXiv ids");
        assert_eq!(err, "Invalid paper id");
        // The guard path itself is covered by ensure_public_https tests;
        // the fetch_pdf wrapper needs an AppHandle (not constructible in
        // unit tests) — the URL policy is what matters here.
    }
}
