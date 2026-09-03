import { useTranslation } from "react-i18next";
import type { Tab } from "./reader-tabs";

interface ContextRowProps {
  tab: Tab;
  walkthroughDone: boolean;
  walkthroughBusy: boolean;
  sectionsDone: number;
  sectionsTotal: number;
  hasSelection: boolean;
}

/**
 * Reader context row: current mode, walkthrough progress, and whether a
 * passage is selected — so the user always knows what the AI panel is
 * working with. Compact and direction-safe.
 */
export function ContextRow({
  tab,
  walkthroughDone,
  walkthroughBusy,
  sectionsDone,
  sectionsTotal,
  hasSelection,
}: ContextRowProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">
        {tab === "overview"
          ? t("reader.overviewTab")
          : tab === "walkthrough"
            ? t("reader.walkthroughTab")
            : tab === "notes"
              ? t("notes.title")
              : t("reader.askTab")}
      </span>
      {tab === "walkthrough" && !walkthroughDone && sectionsDone > 0 && sectionsTotal > 0 && (
        <span dir="ltr">
          {t("reader.sectionOf", {
            current: Math.min(sectionsDone + (walkthroughBusy ? 1 : 0), sectionsTotal),
            total: sectionsTotal,
          })}
        </span>
      )}
      {tab === "walkthrough" && walkthroughDone && <span>{t("reader.synthesis")}</span>}
      {hasSelection && <span>{t("reader.passageSelected")}</span>}
    </div>
  );
}
