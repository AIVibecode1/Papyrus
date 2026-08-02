import * as pdfjsLib from "pdfjs-dist";
// Vite resolves this to the worker asset URL; pdf.js needs a worker to
// parse PDFs off the main thread.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let workerConfigured = false;

/**
 * Extracts plain text from PDF bytes with pdf.js (one line per text item,
 * pages joined with blank lines). Used by the reader to build the section
 * walkthrough and the grounded chat. pdf.js is already loaded for the
 * viewer, so no extra dependency ships.
 */
export async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
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
