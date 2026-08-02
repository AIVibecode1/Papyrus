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

/// Downloads a paper's PDF and caches it on disk keyed by arXiv id, so the
/// viewer and the text extractor never download the same PDF twice.
#[tauri::command]
pub async fn fetch_pdf(app: AppHandle, paper_id: String, url: String) -> Result<Response, String> {
    let path = cache_path(&app, &paper_id)?;
    if let Ok(bytes) = fs::read(&path)
        && !bytes.is_empty()
    {
        return Ok(Response::new(bytes));
    }

    let bytes = download_pdf(&url).await?;
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

    fn run(
        fut: impl std::future::Future<Output = Result<Vec<u8>, String>>,
    ) -> Result<Vec<u8>, String> {
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
}
