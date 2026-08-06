import { Search, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SearchField } from "@/lib/arxiv";
import type { PaperSortMode } from "@/lib/paper-sort";

interface PapersSearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  /** Field the free-text query targets (plan 041 mode select). */
  field: SearchField;
  onFieldChange: (field: SearchField) => void;
  /** When true, the sort dropdown renders embedded at the field end. */
  sortVisible: boolean;
  sortMode: PaperSortMode;
  onSortChange: (value: string) => void;
  /** Renders the X button + Escape handler; clears the search. */
  onClear?: () => void;
}

/**
 * The search input frame: gray border-input box, page-background interior,
 * zero shadows (user-mandated spec). The field-mode select sits at the
 * start edge; the sort dropdown embeds at the end edge when the list is
 * populated; the clear button sits between the input and the sort divider.
 */
export function PapersSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  field,
  onFieldChange,
  sortVisible,
  sortMode,
  onSortChange,
  onClear,
}: PapersSearchFieldProps) {
  const { t } = useTranslation();

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && onClear && value) {
      e.preventDefault();
      onClear();
    }
  };

  return (
    <div
      /* Plan 063: the parent toolbar owns the max width (28rem middle
         grid track); the field fills whatever width it is given, so it
         cannot force a full-row width or wrap to the direction start
         edge. */
      className="flex h-9 w-full items-center gap-1.5 rounded-md border border-input bg-background px-2.5 transition-colors focus-within:border-ring"
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <Select value={field} onValueChange={(v) => onFieldChange(v as SearchField)}>
        <SelectTrigger
          className="h-7 w-auto shrink-0 gap-1 border-0 bg-transparent p-0 text-xs shadow-none focus:ring-0 dark:bg-transparent dark:hover:bg-transparent"
          aria-label={t("papers.searchField")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("papers.fieldAll")}</SelectItem>
          <SelectItem value="title">{t("papers.fieldTitle")}</SelectItem>
          <SelectItem value="author">{t("papers.fieldAuthor")}</SelectItem>
          <SelectItem value="abstract">{t("papers.fieldAbstract")}</SelectItem>
          <SelectItem value="id">{t("papers.fieldId")}</SelectItem>
        </SelectContent>
      </Select>
      <div className="h-4 w-px shrink-0 bg-border" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="h-7 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      {onClear && value.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          aria-label={t("papers.clearSearch")}
          title={t("papers.clearSearch")}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <X className="size-3.5" />
        </button>
      )}
      {sortVisible && (
        <>
          <div className="h-4 w-px shrink-0 bg-border" />
          <Select value={sortMode} onValueChange={onSortChange}>
            <SelectTrigger
              className="h-7 w-auto shrink-0 gap-1 border-0 bg-transparent p-0 text-xs shadow-none focus:ring-0 dark:bg-transparent dark:hover:bg-transparent"
              aria-label={t("papers.sortBy")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">{t("papers.sortNewest")}</SelectItem>
              <SelectItem value="cited">{t("papers.sortCited")}</SelectItem>
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  );
}
