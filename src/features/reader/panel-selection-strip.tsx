import { Check, Copy, Highlighter, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface PanelSelectionStripProps {
  selection: string;
  copied: boolean;
  saving: boolean;
  onCopy: () => void;
  onClear: () => void;
  onSaveHighlight: () => void;
}

/**
 * The AI-panel copy of the selection strip: labeled quote + copy /
 * clear / save-highlight actions. (The PDF-side floating bar is
 * SelectionBar; this one lives above the tab list and keeps the Ask
 * shortcut out because the Ask tab is one tap away.)
 */
export function PanelSelectionStrip({
  selection,
  copied,
  saving,
  onCopy,
  onClear,
  onSaveHighlight,
}: PanelSelectionStripProps) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-start gap-2 border-b bg-primary/5 p-2.5">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t("reader.selectionLabel")}:</span>{" "}
        <span dir="ltr" className="line-clamp-2">
          {selection}
        </span>
      </p>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onCopy}
        aria-label={copied ? t("reader.copied") : t("reader.copySelection")}
        title={copied ? t("reader.copied") : t("reader.copySelection")}
      >
        {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClear}
        aria-label={t("reader.clearSelection")}
      >
        <X className="size-3.5" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onSaveHighlight}
        disabled={saving}
      >
        {saving ? <Loader2 className="size-3 animate-spin" /> : <Highlighter className="size-3" />}
        {t("notes.highlight")}
      </Button>
    </div>
  );
}
