use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// In-flight AI operations keyed by the frontend-supplied operation id.
/// Every streaming command owns a fresh cancellation flag, so stopping one
/// explanation can never cancel (or reset) another. The entry is removed
/// when the command finishes, succeeds or fails.
static OPERATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

pub(crate) fn operations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn register_operation(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    operations()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.to_string(), flag.clone());
    flag
}

/// Sets the cancellation flag of ONE operation. Unknown ids are a no-op
/// (the operation already finished or never started).
pub(crate) fn cancel_operation(id: &str) {
    if let Some(flag) = operations()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(id)
    {
        flag.store(true, Ordering::SeqCst);
    }
}

pub(crate) fn unregister_operation(id: &str) {
    operations()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(id);
}
