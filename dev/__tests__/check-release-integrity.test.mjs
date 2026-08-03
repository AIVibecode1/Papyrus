// Tests for dev/check-release-integrity.mjs.
// Run with: node --test dev/__tests__/check-release-integrity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkIntegrity, collectVersions } from "../check-release-integrity.mjs";

function makeRepo(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "papyrus-integrity-"));
  mkdirSync(join(dir, "src-tauri"), { recursive: true });
  const files = {
    "package.json": JSON.stringify({ name: "papyrus", version: "1.0.4" }),
    "src-tauri/tauri.conf.json": JSON.stringify({ version: "1.0.4" }),
    "src-tauri/Cargo.toml": '[package]\nname = "papyrus"\nversion = "1.0.4"\n',
    "src-tauri/Cargo.lock":
      'version = 4\n\n[[package]]\nname = "papyrus"\nversion = "1.0.4"\ndependencies = []\n',
    "release.md": "# Papyrus releases\n\n## v1.0.4 - 2026-08-04\n\nStatus: built.\n",
    "README.md": "# Papyrus\n\nChangelog for v1.0.4.\n",
  };
  for (const [rel, content] of Object.entries({ ...files, ...overrides })) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

test("all matching manifests pass", () => {
  const dir = makeRepo();
  try {
    const versions = collectVersions(dir);
    const result = checkIntegrity(versions);
    assert.equal(result.ok, true);
    assert.equal(result.version, "1.0.4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cargo manifest mismatch fails with the expected path", () => {
  const dir = makeRepo({
    "src-tauri/Cargo.toml": '[package]\nname = "papyrus"\nversion = "1.0.2"\n',
  });
  try {
    const result = checkIntegrity(collectVersions(dir));
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((p) => p.includes("expected 1.0.4") && p.includes("cargo")),
      result.problems.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockfile mismatch fails", () => {
  const dir = makeRepo({
    "src-tauri/Cargo.lock":
      'version = 4\n\n[[package]]\nname = "papyrus"\nversion = "1.0.2"\ndependencies = []\n',
  });
  try {
    const result = checkIntegrity(collectVersions(dir));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("lock")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release.md heading mismatch fails", () => {
  const dir = makeRepo({
    "release.md": "# Papyrus releases\n\n## v1.0.3 - 2026-08-04\n\nStatus: built.\n",
  });
  try {
    const result = checkIntegrity(collectVersions(dir));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("release.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("README without the version reference warns but does not fail", () => {
  const dir = makeRepo({ "README.md": "# Papyrus\n\nNo version mention here.\n" });
  try {
    const result = checkIntegrity(collectVersions(dir));
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes("README")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
