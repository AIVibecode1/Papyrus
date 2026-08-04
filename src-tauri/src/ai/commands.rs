use std::sync::atomic::AtomicBool;

use serde_json::json;
use tauri::ipc::Channel;

use crate::ai::ProviderConfig;
use crate::ai::keychain::{KEYRING_SERVICE, delete_key, get_key, load_key, set_key};
use crate::ai::prompts::{
    ChatTurn, build_qa_messages, build_section_messages, build_synthesis_messages,
};
use crate::ai::registry::{cancel_operation, register_operation, unregister_operation};
use crate::ai::stream::{
    TEST_TIMEOUT, build_chat_url, explain_with_failover, stream_chat, stream_messages,
    validate_provider,
};
use crate::papers::{Paper, shared_client};

/// Generates a streaming explanation of a paper in the current UI language.
/// Explains a paper by trying an ordered chain of providers, failing over
/// to the next one when the active provider fails BEFORE delivering any
/// content. Returns the winning provider's id so the UI can show who
/// actually answered.
#[tauri::command]
// The argument list is the IPC contract between the frontend and Rust.
#[allow(clippy::too_many_arguments)]
pub async fn explain_paper(
    operation_id: String,
    providers: Vec<ProviderConfig>,
    paper: Paper,
    language: String,
    on_chunk: Channel<String>,
) -> Result<String, String> {
    let flag = register_operation(&operation_id);
    let result = explain_with_failover(&flag, &providers, &paper, &language, &mut |c| {
        let _ = on_chunk.send(c.to_string());
    })
    .await;
    unregister_operation(&operation_id);
    result
}

/// Internal chain: try each provider; retry ONLY pre-first-chunk failures.
/// The typed cancellation marker is terminal (never retried, never folded
/// into the aggregate); post-first-chunk errors propagate because partial
/// text is already on screen.
/// Sends a minimal request to verify a provider configuration.
#[tauri::command]
pub async fn test_provider(provider: ProviderConfig) -> Result<String, String> {
    validate_provider(&provider)?;
    let key = load_key(&provider)?;
    let url = build_chat_url(&provider.base_url)?;
    let client = shared_client();

    let body = json!({
        "model": provider.model,
        "messages": [{"role": "user", "content": "Reply with the single word: OK"}],
        "stream": false,
        "max_tokens": 8,
    });

    let cancel_flag = AtomicBool::new(false);
    let reply = stream_chat(
        client,
        &url,
        &key,
        body,
        TEST_TIMEOUT,
        &cancel_flag,
        &mut |_| {},
    )
    .await?;
    Ok(reply.trim().to_string())
}

/// Cancels ONE in-flight explanation by its operation id. Unknown ids are
/// a no-op: the operation already finished or never started, and nothing
/// else may be affected.
/// Cancels ONE in-flight explanation by its operation id. Unknown ids are
/// a no-op: the operation already finished or never started, and nothing
/// else may be affected.
#[tauri::command]
pub fn stop_explaining(operation_id: String) {
    cancel_operation(&operation_id);
}

/// Mentor walkthrough of a single paper section (whole-paper reader).
#[tauri::command]
// The argument list is the IPC contract between the frontend and Rust.
#[allow(clippy::too_many_arguments)]
pub async fn explain_section(
    operation_id: String,
    provider: ProviderConfig,
    paper: Paper,
    section_index: usize,
    total_sections: usize,
    section_text: String,
    language: String,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let messages = build_section_messages(
        &paper,
        section_index,
        total_sections,
        &section_text,
        &language,
    );
    let flag = register_operation(&operation_id);
    let result = stream_messages(&flag, &provider, messages, on_chunk).await;
    unregister_operation(&operation_id);
    result
}

/// Final synthesis after all sections were walked through.
/// Final synthesis after all sections were walked through.
#[tauri::command]
pub async fn explain_synthesis(
    operation_id: String,
    provider: ProviderConfig,
    paper: Paper,
    sections_text: String,
    language: String,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let messages = build_synthesis_messages(&paper, &sections_text, &language);
    let flag = register_operation(&operation_id);
    let result = stream_messages(&flag, &provider, messages, on_chunk).await;
    unregister_operation(&operation_id);
    result
}

/// Answers a question about the paper, grounded in the selected passage
/// and the relevant section context, with recent chat history.
/// Answers a question about the paper, grounded in the selected passage
/// and the relevant section context, with recent chat history.
#[tauri::command]
// The argument list is the IPC contract between the frontend and Rust;
// grouping it into a struct would add indirection without removing any
// of the fields the webview must send.
#[allow(clippy::too_many_arguments)]
pub async fn ask_about_paper(
    operation_id: String,
    provider: ProviderConfig,
    paper: Paper,
    question: String,
    selection: Option<String>,
    context: Option<String>,
    history: Vec<ChatTurn>,
    language: String,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let messages = build_qa_messages(
        &paper,
        &question,
        selection.as_deref(),
        context.as_deref(),
        &history,
        &language,
    );
    let flag = register_operation(&operation_id);
    let result = stream_messages(&flag, &provider, messages, on_chunk).await;
    unregister_operation(&operation_id);
    result
}

/// Saves an API key to the OS keychain (Windows Credential Manager / macOS Keychain).
/// Saves an API key to the OS keychain (Windows Credential Manager / macOS Keychain).
#[tauri::command]
pub async fn save_api_key(provider_id: String, key: String) -> Result<(), String> {
    if provider_id.is_empty() || provider_id.len() > 64 {
        return Err("Invalid provider id".into());
    }
    if key.trim().is_empty() {
        return Err("API key cannot be empty".into());
    }
    set_key(KEYRING_SERVICE, &provider_id, key.trim())
}

/// Removes a stored API key from the OS keychain.
/// Removes a stored API key from the OS keychain.
#[tauri::command]
pub async fn delete_api_key(provider_id: String) -> Result<(), String> {
    delete_key(KEYRING_SERVICE, &provider_id)
}

/// Reports whether a key is stored for the provider — never exposes the key itself.
/// Reports whether a key is stored for the provider — never exposes the key itself.
#[tauri::command]
pub async fn has_api_key(provider_id: String) -> Result<bool, String> {
    get_key(KEYRING_SERVICE, &provider_id).map(|k| k.is_some())
}
