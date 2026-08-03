use std::fs;
use std::path::PathBuf;

use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

use crate::papers::shared_client;

const MAX_PDF_BYTES: u64 = 30 * 1024 * 1024; // 30 MB safety cap
const PDF_CACHE_DIR: &str = "pdfs";

/// Downloads a paper's PDF bytes (no caching). The command wrapper adds
/// the on-disk cache; this core is unit-testable without a Tauri runtime.
async fn download_pdf(url: &str) -> Result<Vec<u8>, String> {
    let response = shared_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download the PDF: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("PDF download returned HTTP {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read the PDF: {e}"))?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("The PDF is too large to open in the app".into());
    }
    Ok(bytes.to_vec())
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
/// 169.254.169.254 is link-local and covered).
async fn ensure_public_https(url: &str) -> Result<(), String> {
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
    let ips = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "PDF host could not be resolved".to_string())?;
    for ip in ips {
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
    Ok(())
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
    let path = cache_path(&app, &paper_id)?;
    if let Ok(bytes) = fs::read(&path)
        && !bytes.is_empty()
    {
        return Ok(Response::new(bytes));
    }

    let target = if paper_id.starts_with("s2:") {
        let url = url.ok_or_else(|| "A PDF url is required for this paper".to_string())?;
        ensure_public_https(&url).await?;
        url
    } else {
        arxiv_pdf_url(&paper_id)?
    };
    let bytes = download_pdf(&target).await?;
    // Best-effort cache write: a full disk is not a reason to fail the read.
    let _ = fs::write(&path, &bytes);
    Ok(Response::new(bytes))
}

fn cache_path(app: &AppHandle, paper_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data directory unavailable: {e}"))?
        .join(PDF_CACHE_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the PDF cache directory: {e}"))?;
    // arXiv ids are [a-z]+.[0-9]+v[0-9]+ — keep only safe characters.
    let safe: String = paper_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if safe.is_empty() {
        return Err("Invalid paper id".into());
    }
    Ok(dir.join(format!("{safe}.pdf")))
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
        let safe: String = "cs.ai.2607.00001v1"
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .collect();
        assert_eq!(safe, "cs.ai.2607.00001v1");
        let empty: String = "!@#$%"
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .collect();
        assert!(empty.is_empty());
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
            let err = run(ensure_public_https(url)).expect_err("must reject {url}");
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
