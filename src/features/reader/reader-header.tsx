import { ArrowLeft, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { ReaderTextScale } from "@/hooks/use-reader-text-scale";

interface ReaderHeaderProps {
  title: string;
  busy: boolean;
  onBack: () => void;
  onStop: () => void;
  scale: ReaderTextScale;
  onScaleUp: () => void;
  onScaleDown: () => void;
}

/** Reader top bar: back, title, stop (while streaming) and the AI-prose text-size stepper. */
export function ReaderHeader({
  title,
  busy,
  onBack,
  onStop,
  scale,
  onScaleUp,
  onScaleDown,
}: ReaderHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onBack}
        aria-label={t("reader.back")}
        title={t("reader.back")}
      >
        {/* Back points left in LTR and right in RTL; one icon + rotation covers both. */}
        <ArrowLeft className="size-4 rtl:rotate-180" />
      </Button>
      <div className="min-w-0 flex-1">
        {/* `dir` goes on the inner span, not the block. A Latin paper title
            does need LTR, but putting it on the block also flips the
            block's own `text-align: start` to the left — so in an Arabic
            header the title hugged the far left with ~900px of dead space
            to its right, while the back button sat on the right. Isolating
            just the text keeps the title LTR and the block aligned to the
            reading start edge. */}
        <h1 className="truncate text-sm font-semibold tracking-tight">
          <span dir="ltr">{title}</span>
        </h1>
      </div>
      {busy && (
        <Button variant="outline" size="sm" onClick={onStop}>
          <Square className="size-3.5" />
          {t("explain.stop")}
        </Button>
      )}
      {/* Plan 064b: explanation text size stepper (A- / A+). Applies to
        the AI prose only; the PDF pages keep their own zoom. */}
      <div className="flex items-center gap-1" role="group" aria-label={t("reader.textScale")}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onScaleDown}
          disabled={scale === "sm"}
          aria-label={t("reader.textSmaller")}
          title={t("reader.textSmaller")}
        >
          <span className="text-xs font-semibold">A−</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onScaleUp}
          disabled={scale === "lg"}
          aria-label={t("reader.textLarger")}
          title={t("reader.textLarger")}
        >
          <span className="text-sm font-semibold">A+</span>
        </Button>
      </div>
    </header>
  );
}
