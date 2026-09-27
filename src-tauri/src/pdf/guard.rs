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
        // One `resolve_to_addrs` call, not a loop of `resolve`: `resolve`
        // forwards to `resolve_to_addrs`, which does
        // `dns_overrides.insert(host, ...)`, so each call REPLACES the
        // previous entry and only the last address would survive. The SSRF
        // property held either way (the survivor is still a validated
        // address), but a host publishing A+AAAA whose last address is
        // unreachable would fail to download.
        builder = builder.resolve_to_addrs(host, &ips);
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

/// True when an IP is not globally routable, i.e. it points back into the
/// user's own network (or the cloud metadata service) rather than the
/// public internet.
///
/// This is the SSRF blocklist. The ranges come from the standard set
/// used by SSRF guards: RFC 1918 + loopback + link-local (which covers
/// the 169.254.169.254 metadata endpoint) + RFC 6598 shared address
/// space, and on IPv6 loopback + link-local + unique-local (fc00::/7),
/// the IPv6 counterpart of RFC 1918.
///
/// Split out as a pure function so every range is unit-testable as a
/// literal, not only through whatever a DNS lookup happens to return.
fn is_private_addr(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_multicast()
                // Shared address space, RFC 6598 (100.64.0.0/10).
                // Carriers hand these out on the CPE-to-CGNAT link, so
                // they are internal hops, not the public internet —
                // is_private() does not cover them.
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Link-local: fe80::/10 (metadata endpoints live here).
                || v6.is_unicast_link_local()
                // Unique local: fc00::/7, the IPv6 counterpart of
                // RFC 1918. Explicitly listed in every SSRF blocklist
                // and reachable on the local network.
                || v6.is_unique_local()
            {
                return true;
            }
            // A V4-mapped address (`::ffff:127.0.0.1`) is a different spelling
            // of an IPv4 host, so the V4 rules must decide it: without this,
            // `::ffff:127.0.0.1` is not ::1 and not link-local, so it would
            // sail past the checks above and point the download at the user's
            // own machine. `to_ipv4` covers the mapped form and the
            // deprecated compatible form, and is consulted only after the V6
            // tests because `::1` also decodes as the compatible 0.0.0.1,
            // which is not itself blocked.
            v6.to_ipv4()
                .is_some_and(|v4| is_private_addr(std::net::IpAddr::V4(v4)))
        }
    }
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
        if is_private_addr(ip.ip()) {
            return Err("PDF host resolves to a private address".into());
        }
    }
    Ok((host.to_string(), ips))
}

/// Decides the next hop for a response. Returns None when the response is
/// not a redirect; errors on missing or non-https locations. Pure so the
/// redirect policy is unit-testable without a server.
///
/// `base` is the url that produced this response, so a *relative* Location
/// (very common on publisher CDNs: `Location: /b?v=2`) resolves against the
/// current hop instead of being rejected outright. Resolution happens before
/// the https check, and the result is re-validated by the caller's loop, so
/// resolving cannot widen what is reachable.
fn next_redirect_target(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    base: &str,
) -> Result<Option<String>, String> {
    if !status.is_redirection() {
        return Ok(None);
    }
    let location = headers
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "PDF redirect without a location".to_string())?;
    // Resolve against the current hop so a relative Location works, then
    // apply the scheme check to the RESOLVED url. Checking `location` first
    // rejected same-host redirects like "/b?v=2" that publisher CDNs emit
    // routinely, which failed legitimate downloads.
    let resolved = reqwest::Url::parse(base)
        .and_then(|b| b.join(location))
        .map_err(|_| "PDF redirect has an unresolvable target".to_string())?;
    if resolved.scheme() != "https" {
        return Err("PDF redirect target must be https".into());
    }
    Ok(Some(resolved.to_string()))
}

/// Interprets a guarded hop's response: Ok(None) means the download is
/// final (success), Ok(Some(next)) means follow the redirect, Err is a
/// policy violation or HTTP failure. Pure so the decision sequence is
/// testable; the loop re-validates the next target with
/// validate_public_https before requesting it.
fn interpret_hop(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    base: &str,
) -> Result<Option<String>, String> {
    if let Some(next) = next_redirect_target(status, headers, base)? {
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
        if let Some(next) = interpret_hop(status, response.headers(), &target)? {
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

    /// A public-looking base for the redirect-policy tests. Only the url
    /// *resolution* is exercised here; no request is made.
    const BASE: &str = "https://papers.example/doi/pdf";
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
    fn a_relative_location_resolves_against_the_current_hop() {
        // Publisher CDNs routinely answer with `Location: /b?v=2`. Checking
        // the raw header rejected those as non-https, so legitimate PDFs
        // failed to open.
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("/b?v=2"),
        );
        let next = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &headers, BASE) })
            .expect("a same-host relative redirect must be accepted")
            .expect("a redirect target");
        assert_eq!(next, "https://papers.example/b?v=2");
    }

    #[test]
    fn a_relative_location_cannot_downgrade_the_scheme() {
        // Resolution happens before the scheme check, so the check must be
        // applied to the RESOLVED url. A protocol-relative `//host/x` keeps
        // https and is therefore allowed past this check — it is stopped
        // later by host validation, which is where a new host belongs. Only
        // an actual downgrade to plaintext is refused here.
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("http://papers.example/paper.pdf"),
        );
        let err = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &headers, BASE) })
            .expect_err("an explicit plaintext downgrade must be refused");
        assert!(err.contains("must be https"), "unexpected error: {err}");

        // A protocol-relative target survives the scheme check with https
        // intact, which is correct: it has not left https.
        headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("//cdn.example/paper.pdf"),
        );
        let next = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &headers, BASE) })
            .expect("a protocol-relative https target is not a downgrade")
            .expect("a redirect target");
        assert_eq!(next, "https://cdn.example/paper.pdf");
    }

    #[test]
    fn redirect_policy_rejects_everything_but_absolute_https() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("https://cdn.example/paper.pdf"),
        );
        let next = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &headers, BASE) })
            .expect("a valid redirect target must be accepted");
        assert_eq!(next.as_deref(), Some("https://cdn.example/paper.pdf"));

        headers.insert(
            reqwest::header::LOCATION,
            reqwest::header::HeaderValue::from_static("http://evil.example/paper.pdf"),
        );
        let err = run(async { next_redirect_target(reqwest::StatusCode::FOUND, &headers, BASE) })
            .expect_err("plaintext redirect targets must be rejected");
        assert!(err.contains("must be https"), "unexpected error: {err}");

        let no_location = reqwest::header::HeaderMap::new();
        let err =
            run(async { next_redirect_target(reqwest::StatusCode::FOUND, &no_location, BASE) })
                .expect_err("a redirect without a location must be rejected");
        assert!(
            err.contains("without a location"),
            "unexpected error: {err}"
        );

        let ok_headers = reqwest::header::HeaderMap::new();
        let next = run(async { next_redirect_target(reqwest::StatusCode::OK, &ok_headers, BASE) })
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
        let next = interpret_hop(reqwest::StatusCode::FOUND, &redirect, BASE)
            .expect("redirect must be followed");
        assert_eq!(next.as_deref(), Some("https://cdn.example/paper.pdf"));

        let err = interpret_hop(reqwest::StatusCode::INTERNAL_SERVER_ERROR, &redirect, BASE)
            .expect_err("an http error is terminal");
        assert!(err.contains("500"), "unexpected error: {err}");

        let done = interpret_hop(reqwest::StatusCode::OK, &redirect, BASE).expect("ok is final");
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
        let next = interpret_hop(reqwest::StatusCode::FOUND, &headers, BASE)
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
        let next = interpret_hop(reqwest::StatusCode::FOUND, &local_headers, BASE)
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

    /// Every address the guard must refuse, as literals. Kept separate from
    /// the host-based test above so the whole blocklist is readable at a
    /// glance and every entry is asserted, not just the ones a DNS lookup
    /// happens to return.
    #[test]
    fn private_address_blocklist_covers_the_reserved_ranges() {
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
        let blocked_v4 = [
            Ipv4Addr::LOCALHOST,               // 127.0.0.0/8
            Ipv4Addr::new(10, 0, 0, 5),        // RFC 1918
            Ipv4Addr::new(172, 16, 0, 5),      // RFC 1918
            Ipv4Addr::new(192, 168, 1, 5),     // RFC 1918
            Ipv4Addr::new(169, 254, 169, 254), // link-local / cloud metadata
            Ipv4Addr::new(100, 64, 0, 1),      // RFC 6598 CGNAT
            Ipv4Addr::new(100, 127, 255, 254), // CGNAT upper edge
            Ipv4Addr::new(0, 0, 0, 0),         // unspecified
            Ipv4Addr::new(255, 255, 255, 255), // broadcast
        ];
        for ip in blocked_v4 {
            assert!(
                is_private_addr(IpAddr::V4(ip)),
                "IPv4 {ip} must be treated as private"
            );
        }
        // Neighbours of the CGNAT range that ARE public: 100.63.x and
        // 100.128.x sit just outside /10 and must stay reachable.
        for ip in [
            Ipv4Addr::new(100, 63, 255, 255),
            Ipv4Addr::new(100, 128, 0, 0),
        ] {
            assert!(
                !is_private_addr(IpAddr::V4(ip)),
                "IPv4 {ip} is public and must not be blocked"
            );
        }

        let blocked_v6 = [
            Ipv6Addr::LOCALHOST,                        // ::1
            Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1), // fe80::/10 link-local
            Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 1), // fc00::/7 ULA
            Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1), // fd00::/8 ULA
            Ipv6Addr::UNSPECIFIED,
            // V4-mapped spellings of IPv4 hosts. These are the same host, so
            // the IPv4 rules decide them: a redirect to either of these must
            // not reach the user's own machine just by being written in hex.
            Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001), // ::ffff:127.0.0.1
            Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0xa00, 0x0001),  // ::ffff:10.0.0.1
            Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe), // ::ffff:169.254.169.254
            Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0x7f00, 0x0001),      // ::127.0.0.1 (compatible)
        ];
        for ip in blocked_v6 {
            assert!(
                is_private_addr(IpAddr::V6(ip)),
                "IPv6 {ip} must be treated as private"
            );
        }
        // A global unicast address stays reachable.
        assert!(!is_private_addr(IpAddr::V6(Ipv6Addr::new(
            0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111
        ))));
        // A V4-mapped *public* address must stay reachable too, or the
        // mapped check would just block every dual-stack host.
        assert!(!is_private_addr(IpAddr::V6(Ipv6Addr::new(
            0, 0, 0, 0, 0, 0xffff, 0x0808, 0x0808
        ))));
    }
}
