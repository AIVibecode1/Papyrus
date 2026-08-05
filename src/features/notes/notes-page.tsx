import { BookOpenText, Loader2, NotebookPen, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchPapers } from "@/lib/arxiv";
import { Markdown } from "@/components/markdown/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatUiDate } from "@/lib/dates";
import type { Paper, PaperNote } from "@/lib/types";
import { filterNotes, useNotesStore } from "@/stores/notes";
import { useFavoritesStore } from "@/stores/favorites";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";

/** Resolves a note's paper: favorites cache first, then a live arXiv id
 * lookup (plan 041). S2 ids cannot be resolved via arXiv and fall back
 * to the favorites cache only. */
async function resolvePaper(paperId: string): Promise<Paper | null> {
  if (paperId.startsWith("s2:")) return null;
  try {
    const { papers } = await fetchPapers("cs.AI", 5, paperId, undefined, 0, "arxiv", "id");
    return papers[0] ?? null;
  } catch {
    return null;
  }
}

function NoteCard({
  note,
  openingId,
  confirmId,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
  onOpen,
  onFilterPaper,
}: {
  note: PaperNote;
  openingId: string | null;
  confirmId: string | null;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
  onOpen: (note: PaperNote) => void;
  onFilterPaper: (paperId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const isConfirming = confirmId === note.id;
  const openedAt = formatUiDate(new Date(note.updatedAt), i18n.language, {
    dateStyle: "medium",
  });

  return (
    <Card className={note.kind === "highlight" ? "border-accent/50" : undefined}>
      <CardContent className="flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant={note.kind === "highlight" ? "secondary" : "outline"}
            className="text-[10px]"
          >
            {note.kind === "highlight" ? t("notes.kindHighlight") : t("notes.kindNote")}
          </Badge>
          {note.page != null && (
            <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
              {t("notes.page", { page: note.page })}
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">{openedAt}</span>
        </div>

        {note.kind === "highlight" && note.quote && (
          <blockquote
            dir="ltr"
            className="border-s-2 border-accent bg-muted/40 px-3 py-2 text-sm italic text-foreground/90"
          >
            “{note.quote}”
          </blockquote>
        )}

        {note.body.trim() && (
          <div className="text-sm">
            <Markdown>{note.body}</Markdown>
          </div>
        )}

        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <button
            type="button"
            onClick={() => onFilterPaper(note.paperId)}
            className="min-w-0 truncate text-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            title={t("notes.filteredTo", { title: note.paperTitle })}
          >
            {t("notes.forPaper", { title: note.paperTitle })}
          </button>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onOpen(note)}
              disabled={openingId === note.id}
            >
              {openingId === note.id ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <BookOpenText className="size-3" />
              )}
              {t("notes.openPaper")}
            </Button>
            {isConfirming ? (
              <span className="flex items-center gap-1.5">
                <span className="text-xs text-destructive">{t("notes.deleteConfirm")}</span>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onDelete(note.id)}
                >
                  {t("notes.delete")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={onCancelDelete}
                >
                  {t("settings.cancel")}
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => onConfirmDelete(note.id)}
              >
                <Trash2 className="size-3" />
                {t("notes.delete")}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

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
          <Card className="border-dashed">
            <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("notes.loadError")}
            </CardContent>
          </Card>
        ) : visible.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <NotebookPen className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium text-muted-foreground">
                {query.trim() || filterPaperId ? t("notes.noResults") : t("notes.empty")}
              </p>
            </CardContent>
          </Card>
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
