import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { readPdfPosition, savePdfPosition } from "@/lib/pdf-position";

/**
 * Reading-position memory: restores the last page once pages have real
 * layout heights, then saves on every page change. The guard prevents
 * the mount-time save (page 1) from clobbering a stored position before
 * the restore pass has read it.
 */
export function useReadingPosition(
  paperId: string | undefined,
  pageCount: number,
  currentPage: number,
  setCurrentPage: Dispatch<SetStateAction<number>>,
  getWrap: (index: number) => HTMLDivElement | null,
) {
  const restoreDoneRef = useRef(false);

  useEffect(() => {
    if (!restoreDoneRef.current) return;
    savePdfPosition(paperId, currentPage);
  }, [currentPage, paperId]);

  // The load effect alone is too early: canvases start at zero height,
  // and a scroll to a zero-height page is a no-op that leaves the
  // scroll tracker on page 1.
  useEffect(() => {
    if (pageCount === 0) return;
    const saved = readPdfPosition(paperId);
    if (saved && saved >= 1 && saved <= pageCount) {
      setCurrentPage(saved);
      const timer = setTimeout(() => {
        getWrap(saved - 1)?.scrollIntoView({ block: "start" });
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [pageCount, paperId, setCurrentPage, getWrap]);

  // Enable position saves once the restore pass has run (whether or not
  // a saved position existed).
  useEffect(() => {
    if (pageCount > 0) restoreDoneRef.current = true;
  }, [pageCount]);
}
