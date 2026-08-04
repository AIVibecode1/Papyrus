use std::sync::OnceLock;

use serde_json::{Value, json};

use crate::ai::stream::truncate;
use crate::papers::Paper;

/// Shared AI-layer resource (system prompts + cancellation marker) — the
/// single source of truth for both languages. Rust reads it via
/// `include_str!`; TypeScript imports the same file from src/lib/ai.ts
/// (`../../src-tauri/prompts.json`). Edit the JSON, never the code.
const PROMPTS_JSON: &str = include_str!("../../prompts.json");

static PROMPTS: OnceLock<serde_json::Value> = OnceLock::new();

pub(crate) fn prompts() -> &'static serde_json::Value {
    PROMPTS.get_or_init(|| {
        serde_json::from_str(PROMPTS_JSON).expect("src-tauri/prompts.json must be valid JSON")
    })
}

/// System prompt for the given UI language, from the shared resource.
pub(crate) fn system_prompt(language: &str) -> &'static str {
    let key = if language == "ar" {
        "systemPromptAr"
    } else {
        "systemPromptEn"
    };
    prompts()[key]
        .as_str()
        .expect("prompts.json must contain a string systemPromptEn/systemPromptAr")
}

/// Typed cancellation marker from the shared resource. Emitted instead of a
/// human-readable string when a user stops an explanation. The frontend
/// classifies a stop by this exact prefix (exported as `CANCELLED_MARKER` in
/// src/lib/ai.ts), so provider errors that merely contain the word "stop"
/// can never be mislabeled.
pub(crate) fn cancelled_marker() -> &'static str {
    prompts()["cancelledMarker"]
        .as_str()
        .expect("prompts.json must contain a string cancelledMarker")
}

pub(crate) fn build_messages(paper: &Paper, language: &str) -> Vec<Value> {
    let system = system_prompt(language);
    let user = format!(
        "Title: {}\nAuthors: {}\nPublished: {}\nCategories: {}\n\nAbstract:\n{}",
        paper.title,
        paper.authors.join(", "),
        paper.published,
        paper.categories.join(", "),
        paper.summary
    );
    vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": user }),
    ]
}

/// Extracts the host portion of a base URL ("https://localhost:11434/v1"
/// -> "localhost:11434"). Used by checks that decide whether a provider
/// is local, so a remote host named `localhost.evil.com` can never be
/// mistaken for loopback.
pub(crate) fn prompt_for(language: &str, en: &'static str, ar: &'static str) -> &'static str {
    if language == "ar" { ar } else { en }
}

pub(crate) fn full_paper_prompt(language: &str) -> &'static str {
    prompt_for(
        language,
        prompts()["fullPaperStructureEn"]
            .as_str()
            .expect("prompts.json fullPaperStructureEn"),
        prompts()["fullPaperStructureAr"]
            .as_str()
            .expect("prompts.json fullPaperStructureAr"),
    )
}

pub(crate) fn qa_prompt(language: &str) -> &'static str {
    prompt_for(
        language,
        prompts()["qaPromptEn"]
            .as_str()
            .expect("prompts.json qaPromptEn"),
        prompts()["qaPromptAr"]
            .as_str()
            .expect("prompts.json qaPromptAr"),
    )
}

pub(crate) fn synthesis_prompt(language: &str) -> &'static str {
    prompt_for(
        language,
        prompts()["synthesisPromptEn"]
            .as_str()
            .expect("prompts.json synthesisPromptEn"),
        prompts()["synthesisPromptAr"]
            .as_str()
            .expect("prompts.json synthesisPromptAr"),
    )
}

/// Safety cap for paper text sent to a provider (defensive; the frontend
/// splits sections well below this).
const MAX_PAPER_TEXT_CHARS: usize = 60_000;

/// Mentor walkthrough message for ONE section of the paper. The format
/// string must stay in sync with the browser path in src/lib/reader-ai.ts
/// (ai-contract tests cross-check the shape).
pub(crate) fn build_section_messages(
    paper: &Paper,
    section_index: usize,
    total_sections: usize,
    section_text: &str,
    language: &str,
) -> Vec<Value> {
    let system = format!(
        "{}\n\nThe user will send you ONE section of the paper at a time. Apply the section structure to that section only. Respond in the same language as the user's request.",
        full_paper_prompt(language)
    );
    let user = format!(
        "Paper title: {}\nAuthors: {}\n\nSection {} of {}:\n{}",
        paper.title,
        paper.authors.join(", "),
        section_index,
        total_sections,
        truncate(section_text, MAX_PAPER_TEXT_CHARS)
    );
    vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": user }),
    ]
}

/// End-of-paper synthesis message (whole text as context).
pub(crate) fn build_synthesis_messages(
    paper: &Paper,
    sections_text: &str,
    language: &str,
) -> Vec<Value> {
    let user = format!(
        "Paper title: {}\nAuthors: {}\n\nFull text of the paper:\n{}",
        paper.title,
        paper.authors.join(", "),
        truncate(sections_text, MAX_PAPER_TEXT_CHARS)
    );
    vec![
        json!({ "role": "system", "content": synthesis_prompt(language) }),
        json!({ "role": "user", "content": user }),
    ]
}

/// One prior chat turn, sent back to the provider so follow-up questions
/// have real conversation context (serde matches the JS `{role, content}`).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

/// Question-answer message: the question plus (optionally) the selected
/// passage and the relevant section as grounding context, and the recent
/// conversation history so follow-ups are answered in context.
pub(crate) fn build_qa_messages(
    paper: &Paper,
    question: &str,
    selection: Option<&str>,
    context: Option<&str>,
    history: &[ChatTurn],
    language: &str,
) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "system", "content": qa_prompt(language) })];
    // Prior turns first (max 8, oldest to newest), then the live question.
    for turn in history.iter().take(8) {
        let role = if turn.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        messages.push(json!({ "role": role, "content": turn.content }));
    }
    let mut user = format!(
        "Paper title: {}\nAuthors: {}\n",
        paper.title,
        paper.authors.join(", ")
    );
    if let Some(selection) = selection {
        user.push_str(&format!(
            "\nSelected passage from the paper:\n{selection}\n"
        ));
    }
    if let Some(context) = context {
        user.push_str(&format!(
            "\nRelevant part of the paper:\n{}\n",
            truncate(context, MAX_PAPER_TEXT_CHARS)
        ));
    }
    user.push_str(&format!("\nQuestion: {question}"));
    messages.push(json!({ "role": "user", "content": user }));
    messages
}
