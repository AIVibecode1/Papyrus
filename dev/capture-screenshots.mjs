// Reusable screenshot capture for the Papyrus README.
//
// Requires: vite dev server on :1420, mock AI server on :8765 (pnpm mock-ai),
// and puppeteer-core (pnpm add -D puppeteer-core).
//
// Run: pnpm exec node dev/capture-screenshots.mjs
// Output: docs/screenshots/*.png (1280x800 viewport captures)

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const APP_URL = "http://localhost:1420";
const OUT_DIR = path.resolve("docs/screenshots");

const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

const MOCK_PROVIDER = {
  id: "mock-1",
  name: "Mock AI",
  baseUrl: "http://localhost:8765/v1",
  model: "mock-model",
};

async function newPage(browser, { theme, lang }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Seed app state BEFORE any page script runs (main.tsx reads these keys
  // at module load time, before React mounts).
  await page.evaluateOnNewDocument(
    ({ theme, lang, providers, activeProvider }) => {
      localStorage.setItem("papyrus-theme", theme);
      localStorage.setItem("papyrus-lang", lang);
      localStorage.setItem("papyrus-providers", JSON.stringify(providers));
      localStorage.setItem("papyrus-active-provider", activeProvider);
    },
    {
      theme,
      lang,
      providers: [MOCK_PROVIDER],
      activeProvider: MOCK_PROVIDER.id,
    },
  );
  return page;
}

async function gotoPapers(page) {
  await page.goto(APP_URL, { waitUntil: "networkidle0", timeout: 30000 });
  // Wait for the paper list to render (h3 = paper title).
  await page.waitForFunction(
    () => document.querySelectorAll("h3").length > 0,
    { timeout: 15000 },
  );
  // Let fonts/layout settle.
  await new Promise((r) => setTimeout(r, 1200));
}

function findButtonByText(page, text) {
  return page.evaluate((t) => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === t,
    );
    if (!btn) return null;
    btn.click();
    return true;
  }, text);
}

async function capturePapers(browser, file, theme, lang) {
  const page = await newPage(browser, { theme, lang });
  await gotoPapers(page);
  await page.screenshot({ path: path.join(OUT_DIR, file) });
  await page.close();
}

async function captureExplain(browser, file) {
  const page = await newPage(browser, { theme: "dark", lang: "ar" });
  await gotoPapers(page);

  // Click the first paper's Explain button (Arabic label).
  const clicked = await findButtonByText(page, "اشرح");
  if (!clicked) {
    throw new Error("Explain button (اشرح) not found on the papers view");
  }

  // Wait for the mock stream to finish: the Stop button (إيقاف) disappears
  // and the explanation block holds real text.
  await page.waitForFunction(
    () => {
      const stopBtn = [...document.querySelectorAll("button")].some((b) =>
        b.textContent.includes("إيقاف"),
      );
      if (stopBtn) return false;
      const blocks = [...document.querySelectorAll("div")].filter((d) =>
        (d.className ?? "").includes("whitespace-pre-wrap"),
      );
      return blocks.some((b) => b.textContent.trim().length > 100);
    },
    { timeout: 30000 },
  );
  await new Promise((r) => setTimeout(r, 600));

  await page.screenshot({ path: path.join(OUT_DIR, file) });
  await page.close();
}

async function captureSettings(browser, file) {
  const page = await newPage(browser, { theme: "light", lang: "ar" });
  await gotoPapers(page);

  // Gear button in the top bar (aria-label = localized nav.settings).
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="الإعدادات"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) {
    throw new Error("Settings gear button (aria-label=الإعدادات) not found");
  }

  // Settings page rendered: heading + seeded provider card.
  await page.waitForFunction(
    () =>
      document.querySelectorAll("h1").length > 0 &&
      document.body.textContent.includes("Mock AI"),
    { timeout: 15000 },
  );
  await new Promise((r) => setTimeout(r, 800));

  await page.screenshot({ path: path.join(OUT_DIR, file) });
  await page.close();
}

async function main() {
  const executablePath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) {
    throw new Error(
      `No browser found at: ${BROWSER_CANDIDATES.join(" | ")}`,
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless: true, // new headless
  });

  try {
    await capturePapers(browser, "papers-en-light.png", "light", "en");
    await capturePapers(browser, "papers-en-dark.png", "dark", "en");
    await captureExplain(browser, "explain-ar-dark.png");
    await captureSettings(browser, "settings-ar-light.png");
  } finally {
    await browser.close();
  }

  const MIN_BYTES = 50 * 1024;
  for (const f of [
    "papers-en-light.png",
    "papers-en-dark.png",
    "explain-ar-dark.png",
    "settings-ar-light.png",
  ]) {
    const p = path.join(OUT_DIR, f);
    const size = fs.statSync(p).size;
    console.log(`${f}: ${(size / 1024).toFixed(1)} KB`);
    if (size < MIN_BYTES) {
      // Warning, not failure: each shot already asserts real content in the
      // DOM before capture (papers rendered, explanation text present,
      // settings page + provider card), and sparse pages such as Settings
      // legitimately compress below 50 KB.
      console.warn(
        `  WARN: ${f} is under 50 KB — eyeball it to rule out a blank capture`,
      );
    }
  }
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
