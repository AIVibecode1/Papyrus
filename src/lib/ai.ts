import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./ai-browser-keys";
import { streamExplanationBrowser } from "./ai-browser-chat";
import { toIpcProvider } from "./ai-contract";
import type { ExplainOptions } from "./ai-contract";
import { abortOperation } from "./ai-operations";

// Public facade: every existing import path (`@/lib/ai`) keeps working.
// New code can import leaf modules directly; the facade re-exports them.
export {
  CANCELLED_MARKER,
  buildMessages,
  normalizeBaseUrl,
  redactTokens,
  toIpcProvider,
} from "./ai-contract";
export type { ExplainOptions } from "./ai-contract";
export {
  deleteBrowserKey,
  getBrowserKey,
  hasBrowserKey,
  isTauri,
  setBrowserKey,
} from "./ai-browser-keys";
export {
  streamChatBrowser,
  streamExplanationBrowser,
  testProviderBrowser,
} from "./ai-browser-chat";
export { abortOperation, newOperationId } from "./ai-operations";

/** Streams an explanation through the provider chain. Inside Tauri the
 * Rust backend tries each provider (keys fetched from the OS keychain
 * there); in a plain browser the same loop runs here with the in-memory
 * dev keys. Resolves with the WINNING provider id. */
export async function streamExplanation(opts: ExplainOptions): Promise<string> {
  const { providers, paper, language, operationId, onChunk } = opts;

  if (isTauri()) {
    const channel = new Channel<string>();
    channel.onmessage = (msg) => onChunk(msg);
    return await invoke<string>("explain_paper", {
      operationId,
      providers: providers.map(toIpcProvider),
      paper,
      language,
      onChunk: channel,
    });
  }

  return streamExplanationBrowser(opts);
}

export async function stopExplanation(operationId: string | null): Promise<void> {
  if (isTauri()) {
    await invoke("stop_explaining", { operationId });
    return;
  }
  abortOperation(operationId);
}
