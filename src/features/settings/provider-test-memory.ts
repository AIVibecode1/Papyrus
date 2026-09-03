import { categorizeTestError, redactSecrets, truncateError } from "@/lib/provider-errors";

/**
 * Last test result per provider, persisted so the card can show "last
 * test: OK / failed (category)" across sessions. No secrets are ever
 * stored: the detail is truncated and redacted before saving.
 */
export interface TestRecord {
  ok: boolean;
  category?: string;
  at: string;
  detail?: string;
}

export type TestMemory = Record<string, TestRecord>;

const TEST_MEMORY_KEY = "papyrus-provider-test-v1";

export function loadTestMemory(): TestMemory {
  try {
    const raw = JSON.parse(localStorage.getItem(TEST_MEMORY_KEY) ?? "{}") as TestMemory;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveTestMemory(memory: TestMemory) {
  try {
    localStorage.setItem(TEST_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // best-effort, like every other localStorage write in the app
  }
}

/** Records a passed test (the OK reply is provider text, truncated to a chip-friendly size). */
export function recordTestSuccess(id: string, reply: string) {
  const memory = loadTestMemory();
  memory[id] = {
    ok: true,
    at: new Date().toISOString(),
    detail: truncateError(reply),
  };
  saveTestMemory(memory);
}

/** Records a failed test with its category for the translated badge. */
export function recordTestFailure(id: string, message: string) {
  const memory = loadTestMemory();
  memory[id] = {
    ok: false,
    category: categorizeTestError(message),
    at: new Date().toISOString(),
    detail: truncateError(redactSecrets(message)),
  };
  saveTestMemory(memory);
}
