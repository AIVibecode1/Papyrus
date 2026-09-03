import type { SearchField } from "@/lib/arxiv";

// Non-secret search preferences survive restarts (the raw query string is
// deliberately NOT persisted: privacy + no surprise on reopen).

const FIELD_STORAGE_KEY = "papyrus-search-field";
const LIMIT_CATEGORY_STORAGE_KEY = "papyrus-search-limit-category";

export function readSearchField(): SearchField {
  let value: string | null;
  try {
    value = localStorage.getItem(FIELD_STORAGE_KEY);
  } catch {
    // Node test env has no localStorage; defaults apply.
    value = null;
  }
  return value === "title" || value === "author" || value === "abstract" || value === "id"
    ? value
    : "all";
}

export function writeSearchField(field: SearchField) {
  try {
    localStorage.setItem(FIELD_STORAGE_KEY, field);
  } catch {
    // Best-effort persistence; the in-memory value still applies.
  }
}

export function readLimitToCategory(): boolean {
  try {
    // Missing key = off (plan 050: archive search must see other
    // categories by default; the checkbox is a deliberate opt-in).
    return localStorage.getItem(LIMIT_CATEGORY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeLimitToCategory(value: boolean) {
  try {
    localStorage.setItem(LIMIT_CATEGORY_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Best-effort persistence; the in-memory value still applies.
  }
}
