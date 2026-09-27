//! Backend-owned record of which base URL each provider's key is bound to.
//!
//! # Why this exists
//!
//! The user's API key lives in the OS keychain and is only ever read by
//! Rust. The base URL, however, arrives from the webview on every call,
//! in the same `ProviderConfig` that names the key. That is a key-exfiltration
//! path: a compromised or scripted webview can pass a real `provider_id`
//! together with `baseUrl: "https://attacker.example"`, and the backend
//! will cheerfully send that provider's key there as a bearer token and
//! hand the response back. `build_chat_url` already blocks plaintext
//! `http://` for non-loopback hosts, which stops the trivial case, but an
//! `https://` host of the caller's choosing still receives the key.
//!
//! Custom base URLs are a real feature (OpenRouter, DeepSeek, Ollama, a
//! corporate gateway), so the fix is not to remove them. It is to bind the
//! two together at the moment the user saves them: the base URL is recorded
//! here, in app data the webview cannot write, and every later call uses the
//! recorded URL. A webview that asks for a different host is refused.
//!
//! There is deliberately no in-memory cache. Every operation re-read the file
//! anyway, so a process-wide store bought nothing while coupling concurrent
//! readers to each other — the first version of this module had exactly that,
//! and its tests raced over the shared state.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use tauri::Manager;

const URLS_FILE: &str = "provider-urls.json";
/// A provider id is a short slug; a base URL is well under 2 KiB. The cap
/// keeps a corrupt or hostile file from turning into an unbounded read.
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_URL_LEN: usize = 2048;

#[derive(Debug, Default, Serialize, Deserialize)]
struct UrlsFile {
    #[serde(default)]
    version: u32,
    /// provider id -> validated chat-completions base URL.
    #[serde(default)]
    urls: BTreeMap<String, String>,
}

/// Where the bindings live. Test hook: `PAPYRUS_PROVIDER_URLS_DIR`
/// overrides the app data directory (tests cannot construct an AppHandle —
/// same pattern as `notes.rs`).
pub(crate) fn urls_path(app: Option<&tauri::AppHandle>) -> PathBuf {
    if let Some(dir) = crate::test_hooks::test_env("PAPYRUS_PROVIDER_URLS_DIR") {
        return PathBuf::from(dir).join(URLS_FILE);
    }
    let dir = app
        .and_then(|a| a.path().app_local_data_dir().ok())
        .unwrap_or_else(|| std::env::temp_dir().join("papyrus"));
    dir.join(URLS_FILE)
}

/// Reads the file. A missing, oversized or corrupt file is an empty map: the
/// worst outcome is that a caller falls back to the URL it was given, which
/// is the behaviour that predates this file.
fn read(app: Option<&tauri::AppHandle>) -> UrlsFile {
    let path = urls_path(app);
    let within_cap = fs::metadata(&path)
        .map(|m| m.len() <= MAX_FILE_BYTES)
        .unwrap_or(false);
    if !within_cap {
        return UrlsFile::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<UrlsFile>(&s).ok())
        .unwrap_or_default()
}

fn write(app: Option<&tauri::AppHandle>, file: &UrlsFile) -> Result<(), String> {
    let path = urls_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create data folder: {e}"))?;
    }
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("Could not serialise provider URLs: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Could not write provider URLs: {e}"))
}

/// Binds `provider_id` to `url`, which must already have passed
/// [`crate::ai::stream::build_chat_url`] (scheme and loopback checks).
pub(crate) fn save_binding(
    app: Option<&tauri::AppHandle>,
    provider_id: &str,
    url: &str,
) -> Result<(), String> {
    if provider_id.is_empty() || provider_id.len() > 64 {
        return Err("Invalid provider id".into());
    }
    if url.len() > MAX_URL_LEN {
        return Err("Base URL is too long".into());
    }
    let mut file = read(app);
    file.version = 1;
    file.urls.insert(provider_id.to_string(), url.to_string());
    write(app, &file)
}

/// The base URL bound to `provider_id`, if one was ever saved.
pub(crate) fn bound_url(app: Option<&tauri::AppHandle>, provider_id: &str) -> Option<String> {
    read(app).urls.get(provider_id).cloned()
}

/// Drops the binding for a provider, so removing a provider also removes
/// its remembered host.
pub(crate) fn delete_binding(app: Option<&tauri::AppHandle>, provider_id: &str) {
    let mut file = read(app);
    if file.urls.remove(provider_id).is_none() {
        return; // nothing changed; do not rewrite the file
    }
    let _ = write(app, &file);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The hook variable is process-wide, so the tests that set it must not
    /// run concurrently. Each still gets a private directory.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("papyrus-urls-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Serializes against the other tests in this module, then points the
    /// hook at a private directory.
    fn locked_dir(tag: &str) -> (std::sync::MutexGuard<'static, ()>, PathBuf) {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir(tag);
        // SAFETY: ENV_LOCK serializes every access to this variable.
        unsafe { std::env::set_var("PAPYRUS_PROVIDER_URLS_DIR", &dir) };
        (guard, dir)
    }

    #[test]
    fn round_trips_a_binding() {
        let (_guard, _dir) = locked_dir("roundtrip");
        save_binding(None, "openai", "https://api.openai.com/v1/chat/completions").unwrap();
        assert_eq!(
            bound_url(None, "openai").as_deref(),
            Some("https://api.openai.com/v1/chat/completions")
        );
    }

    #[test]
    fn a_second_provider_does_not_inherit_the_first_binding() {
        let (_guard, _dir) = locked_dir("isolation");
        save_binding(None, "openai", "https://api.openai.com/v1/chat/completions").unwrap();
        // The whole point: a call for an unbound id gets nothing, so the
        // caller's own base URL is never silently trusted.
        assert_eq!(bound_url(None, "attacker"), None);
    }

    #[test]
    fn deleting_a_provider_drops_its_binding() {
        let (_guard, _dir) = locked_dir("delete");
        save_binding(None, "ollama", "http://127.0.0.1:11434/v1/chat/completions").unwrap();
        assert!(bound_url(None, "ollama").is_some());
        delete_binding(None, "ollama");
        assert_eq!(bound_url(None, "ollama"), None);
    }

    #[test]
    fn rejects_an_absurd_id_or_url() {
        let (_guard, _dir) = locked_dir("ids");
        assert!(save_binding(None, "", "https://x.example").is_err());
        assert!(save_binding(None, &"a".repeat(65), "https://x.example").is_err());
        assert!(save_binding(None, "ok", &"h".repeat(MAX_URL_LEN + 1)).is_err());
    }

    #[test]
    fn a_corrupt_file_yields_no_bindings_but_recovers_on_save() {
        let (_guard, dir) = locked_dir("corrupt");
        fs::write(dir.join(URLS_FILE), "{not json").unwrap();
        assert_eq!(bound_url(None, "openai"), None);
        // A later save must recover rather than fail forever.
        assert!(save_binding(None, "openai", "https://api.openai.com/v1/chat/completions").is_ok());
        assert!(bound_url(None, "openai").is_some());
    }

    #[test]
    fn rebinding_replaces_the_previous_host() {
        let (_guard, _dir) = locked_dir("rebind");
        save_binding(None, "ollama", "http://127.0.0.1:11434/v1/chat/completions").unwrap();
        save_binding(None, "ollama", "https://ollama.example/v1/chat/completions").unwrap();
        assert_eq!(
            bound_url(None, "ollama").as_deref(),
            Some("https://ollama.example/v1/chat/completions")
        );
    }

    #[test]
    fn an_oversized_file_is_ignored_rather_than_read() {
        let (_guard, dir) = locked_dir("toobig");
        fs::write(dir.join(URLS_FILE), "x".repeat(MAX_FILE_BYTES as usize + 1)).unwrap();
        assert_eq!(bound_url(None, "openai"), None);
    }
}
