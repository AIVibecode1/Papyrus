import { ChevronLeft, ChevronRight, Minus, Plus, Search, X } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Platform detection for shortcut hints (macOS uses the Command key).
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

interface PdfToolbarProps {
  currentPage: number;
  totalPages: number;
  scale: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  searchOpen: boolean;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  searchQuery: string;
  onQueryChange: (value: string) => void;
  matchCount: number;
  onJumpMatch: (direction: 1 | -1) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
}

/** Page navigation, zoom and find-in-page controls above the page list. */
export function PdfToolbar({
  currentPage,
  totalPages,
  scale,
  onPrevPage,
  onNextPage,
  onZoomOut,
  onZoomIn,
  searchOpen,
  onOpenSearch,
  onCloseSearch,
  searchQuery,
  onQueryChange,
  matchCount,
  onJumpMatch,
  searchInputRef,
}: PdfToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 p-2">
      <Button variant="ghost" size="icon-sm" onClick={onPrevPage} aria-label={t("reader.prevPage")}>
        {/* In RTL the previous page sits to the RIGHT (inline-start). */}
        <ChevronLeft className="size-4 rtl:rotate-180" />
      </Button>
      <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
        {currentPage} / {totalPages}
      </span>
      <Button variant="ghost" size="icon-sm" onClick={onNextPage} aria-label={t("reader.nextPage")}>
        <ChevronRight className="size-4 rtl:rotate-180" />
      </Button>

      <div className="mx-1 h-4 w-px bg-border" />

      <Button variant="ghost" size="icon-sm" onClick={onZoomOut} aria-label={t("reader.zoomOut")}>
        <Minus className="size-4" />
      </Button>
      <span className="w-10 text-center font-mono text-[11px] text-muted-foreground" dir="ltr">
        {Math.round(scale * 100)}%
      </span>
      <Button variant="ghost" size="icon-sm" onClick={onZoomIn} aria-label={t("reader.zoomIn")}>
        <Plus className="size-4" />
      </Button>

      <div className="mx-1 h-4 w-px bg-border" />

      {!searchOpen ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSearch}
            aria-label={t("reader.searchInPdf")}
          >
            <Search className="size-4" />
          </Button>
          <kbd>{IS_MAC ? "⌘F" : "Ctrl+F"}</kbd>
        </>
      ) : (
        <div className="flex items-center gap-1.5">
          <Input
            ref={searchInputRef}
            autoFocus
            aria-label={t("reader.searchInPdf")}
            value={searchQuery}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) onJumpMatch(-1);
                else onJumpMatch(1);
              }
              if (e.key === "Escape") {
                onCloseSearch();
              }
            }}
            placeholder={`${t("reader.searchInPdf")}…`}
            className="h-8 w-40 text-xs"
            dir="auto"
          />
          <span
            aria-live="polite"
            className="min-w-14 text-center text-xs text-muted-foreground"
            dir="ltr"
          >
            {matchCount > 0 ? `${matchCount} ${t("reader.matches")}` : t("reader.noMatches")}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCloseSearch}
            aria-label={t("reader.closeSearch")}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {searchQuery.trim() && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onJumpMatch(1)}
          aria-label={t("reader.nextMatch")}
        >
          <ChevronRight className="size-4 rtl:rotate-180" />
        </Button>
      )}
    </div>
  );
}
