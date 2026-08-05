import { BookOpenText, Bookmark, Clock, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/state-panel";
import type { ReadingHistoryEntry } from "@/lib/types";
import { useFavoritesStore } from "@/stores/favorites";
import { useHistoryStore, paperFromEntry } from "@/stores/history";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";

/** Relative "Opened X ago" label in the active UI language (pure, so
 * tests can pin it). Falls back to the raw date when the input is
 * unparseable. */
export function relativeOpened(iso: string, lang: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((Date.now() - then) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(-days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return rtf.format(-months, "month");
  return rtf.format(Math.round(months / 12), "year");
}

/** Compact row for one history entry: title, "Opened …", and the Open /
 * Save to favorites / Remove actions. */
function HistoryRow({ entry }: { entry: ReadingHistoryEntry }) {
  const { t, i18n } = useTranslation();
  const isFavorite = useFavoritesStore((s) => s.ids.includes(entry.paperId));
  const toggleFavorite = useFavoritesStore((s) => s.toggle);

  const open = () => {
    // Same reader path as the feed: page-position restore still works.
    void useReaderStore.getState().open(paperFromEntry(entry));
    useUiStore.getState().setView("reader");
  };

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border bg-card p-3 transition-colors hover:border-primary/30">
      <div className="min-w-0">
        <h3 dir="ltr" className="truncate text-sm font-medium">
          {entry.title}
        </h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {entry.authors.slice(0, 3).join(", ")}
          {entry.authors.length > 0 && " · "}
          {t("history.opened", { rel: relativeOpened(entry.lastOpenedAt, i18n.language) })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={open}
          aria-label={t("history.open")}
          title={t("history.open")}
        >
          <BookOpenText className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => toggleFavorite(paperFromEntry(entry))}
          disabled={isFavorite}
          aria-label={t("history.save")}
          title={t("history.save")}
        >
          <Bookmark className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void useHistoryStore.getState().remove(entry.paperId)}
          aria-label={t("history.remove")}
          title={t("history.remove")}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** The history surface: automatic list of papers opened in the reader
 * (plan 060). Reuses the papers shell; history is not favorites. */
export function HistoryList() {
  const { t } = useTranslation();
  const loaded = useHistoryStore((s) => s.loaded);
  const entries = useHistoryStore((s) => s.entries);

  if (!loaded) {
    return (
      <StatePanel
        icon={<Loader2 className="size-8 animate-spin" />}
        title={t("papers.loading")}
        muted
      />
    );
  }

  if (entries.length === 0) {
    return <StatePanel icon={<Clock className="size-8" />} title={t("history.empty")} muted />;
  }

  return (
    <div className="flex flex-col gap-3" aria-label={t("history.title")}>
      {entries.map((entry) => (
        <HistoryRow key={entry.paperId} entry={entry} />
      ))}
    </div>
  );
}
