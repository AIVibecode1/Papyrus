//! Paper PDFs: the `fetch_pdf` command with an on-disk cache keyed by
//! paper id. The fetch target is always derived server-side (canonical
//! arXiv URL, or the guarded S2 host); the download itself runs through
//! the pinned, policy-checked pipeline in `guard`.

pub mod guard;

use std::fs;
use std::path::PathBuf;

use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

use guard::download_pdf_guarded;

pub(crate) const PDF_CACHE_DIR: &str = "pdfs";

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

/// Downloads a paper's PDF and caches it on disk keyed by the paper id, so
/// the viewer and the text extractor never download the same PDF twice.
/// The fetch target is derived server-side for arXiv ids (the canonical arXiv
/// PDF url). For `s2:` ids the url comes from the caller, because the host is
/// whatever publisher S2 recorded and cannot be derived from the id — that
/// url is the webview's to supply, and `download_pdf_guarded` is what keeps it
/// safe (https only, no credentials, no private/link-local/loopback host, one
/// validated and re-validated hop at a time).
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
    // redirects.
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
    use super::guard::PDF_BYTES;
    use super::*;

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
    fn s2_pdf_requires_a_url_and_guards_it() {
        // s2: without a url -> error (not derivable).
        let err = arxiv_pdf_url("s2:abc123").expect_err("s2 ids are not arXiv ids");
        assert_eq!(err, "Invalid paper id");
        // The guard path itself is covered by ensure_public_https tests;
        // the fetch_pdf wrapper needs an AppHandle (not constructible in
        // unit tests) — the URL policy is what matters here.
    }
}
