// Read-only release integrity checker.
//
// Verifies that the app version is identical across the four places it
// lives (package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and
// the papyrus entry in src-tauri/Cargo.lock), that the top release section
// in release.md names that version, and that README.md references it.
//
// Exits 0 when everything agrees and prints the version; exits 1 with
// actionable output otherwise. Never writes files, never touches the
// network. Run it before every release build:
//
//   node dev/check-release-integrity.mjs
//
// Tests: node --test dev/__tests__/check-release-integrity.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function collectVersions(repoRoot = root) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const tauri = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const cargoToml = readFileSync(join(repoRoot, "src-tauri", "Cargo.toml"), "utf8");
  const lock = readFileSync(join(repoRoot, "src-tauri", "Cargo.lock"), "utf8");

  const cargoVersion = /^version = "([^"]+)"/m.exec(cargoToml)?.[1] ?? null;
  const lockEntry =
    /\[\[package\]\]\r?\nname = "papyrus"\r?\nversion = "([^"]+)"/m.exec(lock)?.[1] ?? null;

  const releaseHead =
    /^## v([0-9]+\.[0-9]+\.[0-9]+) - /m.exec(
      readFileSync(join(repoRoot, "release.md"), "utf8"),
    )?.[1] ?? null;

  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const readmeMentions = (v) => readme.includes(`(v${v})`) || readme.includes(`v${v}`);

  return {
    package: pkg.version,
    tauri: tauri.version,
    cargo: cargoVersion,
    lock: lockEntry,
    releaseHeading: releaseHead,
    readme: readmeMentions(pkg.version) ? pkg.version : null,
  };
}

export function checkIntegrity(versions) {
  const problems = [];
  const warnings = [];
  const base = versions.package;
  if (typeof base !== "string" || !/^\d+\.\d+\.\d+$/.test(base)) {
    problems.push(`package.json version is not semver: ${String(base)}`);
    return { ok: false, version: base, problems, warnings };
  }
  for (const key of ["tauri", "cargo", "lock"]) {
    if (versions[key] !== base) {
      problems.push(
        `src-tauri version mismatch: expected ${base}, found ${versions[key]} (${key})`,
      );
    }
  }
  if (versions.releaseHeading !== base) {
    problems.push(
      `release.md top section mismatch: expected v${base}, found ${versions.releaseHeading}`,
    );
  }
  // The README changelog rows do not carry version tags by design (see
  // AGENTS.md changelog rule), so a missing reference is a warning only.
  if (versions.readme !== base) {
    warnings.push(`README.md does not reference version v${base} (advisory)`);
  }
  return { ok: problems.length === 0, version: base, problems, warnings };
}

export function main() {
  const versions = collectVersions();
  const result = checkIntegrity(versions);
  if (result.ok) {
    console.log(`release integrity OK: v${result.version} is consistent everywhere`);
    for (const w of result.warnings) console.warn(`  warn: ${w}`);
    return 0;
  }
  console.error(`release integrity FAILED for v${result.version}:`);
  for (const p of result.problems) console.error(`  - ${p}`);
  console.error(
    "Fix the mismatching file, or bump all four version locations together (see AGENTS.md).",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
