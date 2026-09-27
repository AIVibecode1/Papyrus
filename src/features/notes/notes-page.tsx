import { AlertCircle, Loader2, NotebookPen, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/state-panel";
import { Input } from "@/components/ui/input";
import type { PaperNote } from "@/lib/types";
import { filterNotes, useNotesStore } from "@/stores/notes";
import { useFavoritesStore } from "@/stores/favorites";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";
import { NoteCard } from "./note-card";
import { resolvePaper } from "./resolve-paper";

export function NotesPage() {
  const { t } = useTranslation();
  const notes = useNotesStore((s) => s.notes);
  const loaded = useNotesStore((s) => s.loaded);
  const query = useNotesStore((s) => s.query);
  const setQuery = useNotesStore((s) => s.setQuery);
  const filterPaperId = useNotesStore((s) => s.filterPaperId);
  const setFilterPaperId = useNotesStore((s) => s.setFilterPaperId);
  const remove = useNotesStore((s) => s.remove);
  const loadError = useNotesStore((s) => s.loadError);
  const openReader = useReaderStore((s) => s.open);
  const setView = useUiStore((s) => s.setView);
  const favorites = useFavoritesStore((s) => s.byId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const visible = useMemo(
    () => filterNotes(notes, filterPaperId, query),
    [notes, filterPaperId, query],
  );
  const filteredPaperTitle = filterPaperId
    ? notes.find((n) => n.paperId === filterPaperId)?.paperTitle
    : undefined;

  // `load` is a no-op once `loaded` is set, so a retry has to clear the
  // flag first or the button would silently do nothing.
  const retryLoad = async () => {
    useNotesStore.setState({ loaded: false, loadError: null });
    await useNotesStore.getState().load();
  };

  const handleOpen = async (note: PaperNote) => {
    setOpeningId(note.id);
    setOpenError(null);
    try {
      const paper = favorites[note.paperId] ?? (await resolvePaper(note.paperId));
      if (paper) {
        await openReader(paper);
        setView("reader");
        return;
      }
      // A dead end must say so. S2 ids cannot be resolved through arXiv
      // and an unfavorited arXiv paper can be gone from the feed, so
      // resolvePaper returning null is routine, not exceptional — the
      // button used to do nothing at all, which reads as a broken app.
      setOpenError(t("notes.openPaperUnavailable"));
    } catch (err) {
      setOpenError(
        t("notes.openPaperUnavailable") + (err instanceof Error ? ` (${err.message})` : ""),
      );
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl p-4 lg:p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("notes.title")}</h1>
        {filterPaperId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilterPaperId(null)}
            title={
              filteredPaperTitle ? t("notes.filteredTo", { title: filteredPaperTitle }) : undefined
            }
          >
            <X className="size-3.5" />
            {t("notes.clearFilter")}
          </Button>
        )}
      </div>

      {filterPaperId && filteredPaperTitle && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("notes.filteredTo", { title: filteredPaperTitle })}
        </p>
      )}

      <div className="relative mt-4">
        <Search className="absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("notes.searchPlaceholder")}
          aria-label={t("notes.searchPlaceholder")}
          className="ps-8"
        />
      </div>

      {openError && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {openError}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {!loaded ? (
          <StatePanel
            icon={<Loader2 className="size-8 animate-spin" />}
            title={t("notes.loading")}
            busy
            muted
          />
        ) : loadError ? (
          // A failed read must not masquerade as "you have no notes" —
          // that would read as data loss for work the user still has.
          <StatePanel
            icon={<AlertCircle className="size-8 text-destructive" />}
            title={t("notes.loadError")}
            description={loadError}
            tone="destructive"
            action={
              <Button size="sm" variant="outline" onClick={() => void retryLoad()}>
                {t("papers.retry")}
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <StatePanel
            icon={<NotebookPen className="size-8" />}
            title={query.trim() || filterPaperId ? t("notes.noResults") : t("notes.empty")}
            muted
          />
        ) : (
          visible.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              openingId={openingId}
              confirmId={confirmId}
              onConfirmDelete={setConfirmId}
              onCancelDelete={() => setConfirmId(null)}
              onDelete={(id) => {
                void remove(id);
                setConfirmId(null);
              }}
              onOpen={(n) => void handleOpen(n)}
              onFilterPaper={setFilterPaperId}
            />
          ))
        )}
      </div>
    </div>
  );
}
