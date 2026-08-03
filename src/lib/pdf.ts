import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/ai";

/**
 * Fetches a paper's PDF bytes. Inside Tauri the Rust backend downloads
 * (and caches on disk); in the browser preview arXiv sends no CORS
 * headers, so remote fetches fall back to a bundled sample PDF purely
 * to exercise the viewer UI.
 */
export async function getPdfBytes(paperId: string, url: string): Promise<Uint8Array> {
  if (isTauri()) {
    // The fetch target is derived server-side from the id (plan 006); only
    // source-provided papers (s2:) round-trip their url through the
    // https/public-host guard.
    const raw = await invoke<unknown>("fetch_pdf", {
      paperId,
      ...(paperId.startsWith("s2:") ? { url } : {}),
    });
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (raw instanceof Uint8Array) return raw;
    // Some IPC layers deliver { data: [...] }; accept it defensively.
    if (raw && typeof raw === "object" && "data" in raw) {
      return new Uint8Array((raw as { data: number[] }).data);
    }
    throw new Error("PDF download returned an unexpected payload");
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    if (import.meta.env.DEV) {
      // Dev-only: bundled sample so the viewer can be tested in the
      // browser preview (arXiv blocks browser CORS requests).
      const res = await fetch("/src/dev/sample.pdf");
      if (!res.ok) throw new Error("Sample PDF not found");
      return new Uint8Array(await res.arrayBuffer());
    }
    throw new Error("The PDF could not be downloaded");
  }
}
