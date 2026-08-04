import { Channel, invoke } from "@tauri-apps/api/core";

// Single source of truth: the same prompts.json the Rust backend reads.
import prompts from "../../src-tauri/prompts.json";
import { isTauri, streamChatBrowser } from "@/lib/ai";
import type { Paper, ProviderConfig } from "@/lib/types";

export type ReaderStreamKind = "section" | "synthesis" | "qa";

function fullPaperSystem(language: string): string {
  const base = language === "ar" ? prompts.fullPaperStructureAr : prompts.fullPaperStructureEn;
  return `${base}\n\nThe user will send you ONE section of the paper at a time. Apply the section structure to that section only. Respond in the same language as the user's request.`;
}

// Format strings MUST match the Rust builders in src-tauri/src/ai.rs
// (build_section_messages / build_synthesis_messages / build_qa_messages).

export function buildSectionUser(
  paper: Paper,
  sectionIndex: number,
  totalSections: number,
  sectionText: string,
): string {
  return `Paper title: ${paper.title}\nAuthors: ${paper.authors.join(", ")}\n\nSection ${sectionIndex} of ${totalSections}:\n${sectionText}`;
}

export function buildSynthesisUser(paper: Paper, sectionsText: string): string {
  return `Paper title: ${paper.title}\nAuthors: ${paper.authors.join(", ")}\n\nFull text of the paper:\n${sectionsText}`;
}

export function buildQaUser(
  paper: Paper,
  question: string,
  selection: string | null,
  context: string | null,
): string {
  let user = `Paper title: ${paper.title}\nAuthors: ${paper.authors.join(", ")}\n`;
  if (selection) user += `\nSelected passage from the paper:\n${selection}\n`;
  if (context) user += `\nRelevant part of the paper:\n${context}\n`;
  user += `\nQuestion: ${question}`;
  return user;
}

export interface ReaderStreamOptions {
  provider: ProviderConfig;
  paper: Paper;
  language: string;
  /** Operation id shared with the Rust registry; Stop targets exactly this. */
  operationId: string;
  onChunk: (chunk: string) => void;
}

export interface SectionStreamOptions extends ReaderStreamOptions {
  sectionIndex: number;
  totalSections: number;
  sectionText: string;
}

/** Streams the mentor walkthrough of one paper section. */
export async function streamSectionExplanation(opts: SectionStreamOptions): Promise<void> {
  const {
    provider,
    paper,
    language,
    operationId,
    onChunk,
    sectionIndex,
    totalSections,
    sectionText,
  } = opts;
  if (isTauri()) {
    const channel = new Channel<string>();
    channel.onmessage = (msg) => onChunk(msg);
    await invoke("explain_section", {
      operationId,
      provider,
      paper,
      sectionIndex,
      totalSections,
      sectionText,
      language,
      onChunk: channel,
    });
    return;
  }
  await streamChatBrowser(
    provider,
    [
      { role: "system", content: fullPaperSystem(language) },
      { role: "user", content: buildSectionUser(paper, sectionIndex, totalSections, sectionText) },
    ],
    onChunk,
    operationId,
  );
}

export interface SynthesisStreamOptions extends ReaderStreamOptions {
  sectionsText: string;
}

/** Streams the end-of-paper synthesis. */
export async function streamSynthesis(opts: SynthesisStreamOptions): Promise<void> {
  const { provider, paper, language, operationId, onChunk, sectionsText } = opts;
  if (isTauri()) {
    const channel = new Channel<string>();
    channel.onmessage = (msg) => onChunk(msg);
    await invoke("explain_synthesis", {
      operationId,
      provider,
      paper,
      sectionsText,
      language,
      onChunk: channel,
    });
    return;
  }
  const system = language === "ar" ? prompts.synthesisPromptAr : prompts.synthesisPromptEn;
  await streamChatBrowser(
    provider,
    [
      { role: "system", content: system },
      { role: "user", content: buildSynthesisUser(paper, sectionsText) },
    ],
    onChunk,
    operationId,
  );
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AskStreamOptions extends ReaderStreamOptions {
  question: string;
  selection: string | null;
  context: string | null;
  /** Recent conversation turns, oldest first (max 8). */
  history: ChatTurn[];
}

/** Streams an answer to a question about the paper. */
export async function streamAsk(opts: AskStreamOptions): Promise<void> {
  const { provider, paper, language, operationId, onChunk, question, selection, context, history } =
    opts;
  if (isTauri()) {
    const channel = new Channel<string>();
    channel.onmessage = (msg) => onChunk(msg);
    await invoke("ask_about_paper", {
      operationId,
      provider,
      paper,
      question,
      selection,
      context,
      history,
      language,
      onChunk: channel,
    });
    return;
  }
  const system = language === "ar" ? prompts.qaPromptAr : prompts.qaPromptEn;
  const messages = [
    { role: "system", content: system },
    ...history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: buildQaUser(paper, question, selection, context) },
  ];
  await streamChatBrowser(provider, messages, onChunk, operationId);
}
