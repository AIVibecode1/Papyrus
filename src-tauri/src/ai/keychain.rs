use keyring::Entry;

use crate::ai::ProviderConfig;

/// Service name for the OS keychain entries.
pub(crate) const KEYRING_SERVICE: &str = "papyrus";

/// Reports whether a host is a loopback address, where plaintext HTTP is
/// acceptable because no on-path observer can read the API key.
pub(crate) fn is_loopback_host(host: &str) -> bool {
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
/// Extracts the host portion of a base URL ("https://localhost:11434/v1"
/// -> "localhost:11434"). Used by checks that decide whether a provider
/// is local, so a remote host named `localhost.evil.com` can never be
/// mistaken for loopback.
pub(crate) fn base_url_host(base_url: &str) -> &str {
    let after_scheme = base_url
        .strip_prefix("https://")
        .or_else(|| base_url.strip_prefix("http://"))
        .unwrap_or(base_url);
    after_scheme.split('/').next().unwrap_or(after_scheme)
}

/// Reports whether a base URL points at a local server (Ollama etc.),
/// where an API key may be omitted. Strict host check: only genuine
/// loopback hosts qualify, never hosts whose NAME merely contains
/// "localhost" (e.g. `https://localhost.evil.com`).
pub(crate) fn is_local_base_url(base_url: &str) -> bool {
    is_loopback_host(base_url_host(base_url))
}

/// Reads a secret from the OS keychain (Windows Credential Manager / macOS
/// Keychain). `Ok(None)` means no entry exists for the account; genuine
/// keychain failures are returned as errors.
pub(crate) fn get_key(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(service, account)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read key from the system keychain: {e}")),
    }
}

/// Saves a secret to the OS keychain, creating or replacing the entry.
pub(crate) fn set_key(service: &str, account: &str, key: &str) -> Result<(), String> {
    let entry = Entry::new(service, account)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))?;
    entry
        .set_password(key)
        .map_err(|e| format!("Failed to save key to the system keychain: {e}"))
}

/// Removes a secret from the OS keychain.
pub(crate) fn delete_key(service: &str, account: &str) -> Result<(), String> {
    let entry = Entry::new(service, account)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to remove key from the system keychain: {e}"))
}

/// Loads the stored API key for a provider. Local endpoints (Ollama etc.) may have no key.
pub(crate) fn load_key(provider: &ProviderConfig) -> Result<String, String> {
    let key = get_key(KEYRING_SERVICE, &provider.id)?;
    let is_local = is_local_base_url(&provider.base_url);
    match key {
        Some(k) => Ok(k),
        None if is_local => Ok(String::new()),
        None => Err("No API key found for this provider. Add it in Settings → Providers.".into()),
    }
}
