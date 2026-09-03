// Operation registry: each in-flight stream owns its AbortController,
// keyed by the same operation id the Rust backend registers. Stopping one
// operation can never abort another (mirror of the Rust registry in
// src-tauri/src/ai/).
const activeControllers = new Map<string, AbortController>();

/** Fresh unique operation id for one stream command (browser + Tauri). */
export function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Registers a stream's controller so stop can abort exactly this operation. */
export function trackOperation(operationId: string): AbortController {
  const controller = new AbortController();
  activeControllers.set(operationId, controller);
  return controller;
}

/** Forgets a settled stream; stopping it afterwards is a no-op. */
export function untrackOperation(operationId: string) {
  activeControllers.delete(operationId);
}

/** True when the stream was stopped (its signal is aborted). */
export function isOperationAborted(operationId: string): boolean {
  return activeControllers.get(operationId)?.signal.aborted ?? false;
}

/** Aborts exactly one in-flight stream; unknown ids are a no-op. */
export function abortOperation(operationId: string | null) {
  if (operationId) {
    activeControllers.get(operationId)?.abort();
  }
}
