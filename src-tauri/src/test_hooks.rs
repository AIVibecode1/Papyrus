//! Test-only environment overrides, compiled out of release builds.
//!
//! Several modules accept `PAPYRUS_*` environment variables so the test
//! suite can redirect the app's network and filesystem targets without
//! constructing a Tauri `AppHandle`. That is a real capability, not just
//! a test convenience: `PAPYRUS_NOTES_DIR` and friends choose where the
//! user's notes, history and exports are *written*, and the `*_URL`
//! variables redirect every outbound API call.
//!
//! In a shipped build none of that should be settable — anyone who can
//! set environment variables for the process (a crafted shortcut or
//! `.bat` that launches the app, a compromised parent) would otherwise
//! be able to redirect private data to a location of their choosing.
//!
//! The checks live here, in one place, gated with `#[cfg]` rather than
//! `cfg!` so the code is removed from release builds entirely instead of
//! relying on the optimizer to strip it.

/// Reads a test-override environment variable, or `None` in a release build.
///
/// ```
/// use crate::test_hooks::test_env;
/// // In a release build this is always None: the override cannot exist.
/// let _dir = test_env("PAPYRUS_NOTES_DIR");
/// ```
#[cfg(debug_assertions)]
pub(crate) fn test_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Release builds ignore the overrides entirely, so the hook code is not
/// compiled in at all.
#[cfg(not(debug_assertions))]
pub(crate) fn test_env(_key: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_set_override_in_debug_builds() {
        // SAFETY: single-threaded test body; the key is unique to this test.
        unsafe { std::env::set_var("PAPYRUS_TEST_HOOK_PROBE", "/tmp/x") };
        let got = test_env("PAPYRUS_TEST_HOOK_PROBE");
        unsafe { std::env::remove_var("PAPYRUS_TEST_HOOK_PROBE") };
        // The suite runs in debug, so the override must be visible here.
        assert_eq!(got, Some("/tmp/x".to_string()));
    }

    #[test]
    fn an_unset_key_is_none() {
        assert_eq!(test_env("PAPYRUS_TEST_HOOK_DEFINITELY_UNSET"), None);
    }
}
