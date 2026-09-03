import { Check, Copy, Highlighter, Loader2, MessageSquareText, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface SelectionBarProps {
  selection: string;
  copied: boolean;
  saving: boolean;
  onCopy: () => void;
  onSaveHighlight: () => void;
  onAsk: () => void;
  onClear: () => void;
}

/**
 * Plan 052: floating selection actions, pinned above the PDF viewer so
 * the copy/highlight/ask path lives next to the text instead of hiding
 * in the AI panel.
 */
export function SelectionBar({
  selection,
  copied,
  saving,
  onCopy,
  onSaveHighlight,
  onAsk,
  onClear,
}: SelectionBarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b bg-popover/90 px-3 py-1.5 backdrop-blur">
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        <span dir="ltr" className="line-clamp-1">
          {selection}
        </span>
      </span>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onCopy}>
        {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
        {copied ? t("reader.copied") : t("reader.copySelection")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px]"
        onClick={onSaveHighlight}
        disabled={saving}
      >
        {saving ? <Loader2 className="size-3 animate-spin" /> : <Highlighter className="size-3" />}
        {t("notes.highlight")}
      </Button>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onAsk}>
        <MessageSquareText className="size-3" />
        {t("reader.askTab")}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClear}
        aria-label={t("reader.clearSelection")}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}
