// Vite resolves this to the worker asset URL; pdf.js needs a worker to
// parse PDFs off the main thread.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let workerConfigured = false;

/**
 * Extracts plain text from PDF bytes with pdf.js (one line per text item,
 * pages joined with blank lines). Used by the reader to build the section
 * walkthrough and the grounded chat.
 *
 * pdf.js is a ~350 kB dependency and the reader store imports this module
 * eagerly, so a static top-level import put it in the startup bundle: the
 * app paid for (and parsed) the whole parser before the user opened a
 * single paper. Loading it on first use keeps startup lean and moves the
 * cost to the reader, which needs it anyway. The viewer lazy-loads the
 * same module, so the browser caches it across both paths.
 */
export async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    workerConfigured = true;
  }

  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const pages: string[] = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => {
          const str = (item as { str?: string }).str;
          return str ?? "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push(line);
    }
  } finally {
    await doc.cleanup();
  }
  return pages.join("\n\n");
}
