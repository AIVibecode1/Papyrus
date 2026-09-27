import { BookOpenText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { relativeOpened } from "@/lib/relative-time";
import { useHistoryStore, paperFromEntry } from "@/stores/history";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";

/** Plan 073: the Continue-reading strip. Shows the three newest history
 * entries on the main papers feed so a half-read paper is one click away;
 * hidden entirely when there is nothing to resume. */
export function ContinueReading() {
  const { t, i18n } = useTranslation();
  const entries = useHistoryStore((s) => s.entries).slice(0, 3);

  if (entries.length === 0) return null;

  const openEntry = (paperId: string) => {
    const entry = useHistoryStore.getState().entries.find((e) => e.paperId === paperId);
    if (!entry) return;
    void useReaderStore.getState().open(paperFromEntry(entry));
    useUiStore.getState().setView("reader");
  };

  return (
    <section aria-label={t("papers.continueReading")} className="mb-3">
      <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("papers.continueReading")}
      </h2>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <button
            key={entry.paperId}
            type="button"
            onClick={() => openEntry(entry.paperId)}
            className="group flex w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-start transition-colors hover:bg-accent"
          >
            <BookOpenText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.title}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t("history.opened", { rel: relativeOpened(entry.lastOpenedAt, i18n.language) })}
            </span>
            {entry.lastPage != null && (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground" dir="ltr">
                {t("history.page", { page: entry.lastPage })}
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
