import { Loader2, NotebookPen, Search, X } from "lucide-react";
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
import { NoteCard, resolvePaper } from "./note-card";

export function NotesPage() {
  const { t } = useTranslation();
  const notes = useNotesStore((s) => s.notes);
  const loaded = useNotesStore((s) => s.loaded);
  const query = useNotesStore((s) => s.query);
  const setQuery = useNotesStore((s) => s.setQuery);
  const filterPaperId = useNotesStore((s) => s.filterPaperId);
  const setFilterPaperId = useNotesStore((s) => s.setFilterPaperId);
  const remove = useNotesStore((s) => s.remove);
  const openReader = useReaderStore((s) => s.open);
  const setView = useUiStore((s) => s.setView);
  const favorites = useFavoritesStore((s) => s.byId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const visible = useMemo(
    () => filterNotes(notes, filterPaperId, query),
    [notes, filterPaperId, query],
  );
  const filteredPaperTitle = filterPaperId
    ? notes.find((n) => n.paperId === filterPaperId)?.paperTitle
    : undefined;

  const handleOpen = async (note: PaperNote) => {
    setOpeningId(note.id);
    try {
      const paper = favorites[note.paperId] ?? (await resolvePaper(note.paperId));
      if (paper) {
        await openReader(paper);
        setView("reader");
      }
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

      <div className="mt-4 flex flex-col gap-3">
        {!loaded ? (
          <StatePanel
            icon={<Loader2 className="size-8 animate-spin" />}
            title={t("notes.loadError")}
            muted
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
