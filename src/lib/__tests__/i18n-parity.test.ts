// i18n parity gate (plan 044 WU7): every key in en.json must exist in
// ar.json with the same value type (string vs object), so a missing
// Arabic string can never ship silently.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LOCALES = join(import.meta.dirname, "..", "i18n", "locales");

function flatten(
  value: Record<string, unknown>,
  prefix = "",
): Array<{ key: string; type: string }> {
  const out: Array<{ key: string; type: string }> = [];
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      out.push(...flatten(v as Record<string, unknown>, key));
    } else {
      out.push({ key, type: typeof v });
    }
  }
  return out;
}

const en = JSON.parse(readFileSync(join(LOCALES, "en.json"), "utf8")) as Record<string, unknown>;
const ar = JSON.parse(readFileSync(join(LOCALES, "ar.json"), "utf8")) as Record<string, unknown>;
const arFlattened = new Map(flatten(ar).map((e) => [e.key, e.type]));

describe("i18n parity", () => {
  it("every en.json key exists in ar.json with the same value type", () => {
    const missing: string[] = [];
    const typeMismatch: string[] = [];
    for (const { key, type } of flatten(en)) {
      const arType = arFlattened.get(key);
      if (arType === undefined) missing.push(key);
      else if (arType !== type) typeMismatch.push(`${key} (en: ${type}, ar: ${arType})`);
    }
    expect(missing).toEqual([]);
    expect(typeMismatch).toEqual([]);
  });
});
