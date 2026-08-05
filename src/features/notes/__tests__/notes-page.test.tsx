// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// NotesPage pulls in the reader store (open-from-notes), which loads
// pdfjs-dist; jsdom lacks DOMMatrix, so mock the pdf layer entirely
// (same approach as reader-view tests).
vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
}));

import { NotesPage } from "@/features/notes/notes-page";
import type { PaperNote } from "@/lib/types";
import { useNotesStore } from "@/stores/notes";

function makeNote(overrides: Partial<PaperNote> = {}): PaperNote {
  return {
    id: "n1",
    paperId: "p1",
    paperTitle: "Attention Is All You Need",
    kind: "note",
    body: "Multi-head attention is the key idea.",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

describe("NotesPage", () => {
  beforeEach(() => {
    useNotesStore.setState({
      notes: [],
      loaded: true,
      filterPaperId: null,
      query: "",
    });
  });

  it("shows the empty state when there are no notes", () => {
    render(<NotesPage />);
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByText(/No notes yet/)).toBeInTheDocument();
  });

  it("lists notes with their paper and kind", () => {
    useNotesStore.setState({
      notes: [
        makeNote(),
        makeNote({
          id: "n2",
          kind: "highlight",
          quote: "we call it attention",
          body: "",
        }),
      ],
      loaded: true,
    });

    render(<NotesPage />);

    expect(screen.getAllByText(/From “Attention Is All You Need”/)).toHaveLength(2);
    expect(screen.getByText("Multi-head attention is the key idea.")).toBeInTheDocument();
    expect(screen.getByText(/“we call it attention”/)).toBeInTheDocument();
  });

  it("filters the list by the search box", () => {
    useNotesStore.setState({
      notes: [makeNote({ body: "transformers" }), makeNote({ id: "n2", body: "cnn layers" })],
      loaded: true,
    });

    render(<NotesPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search notes…" }), {
      target: { value: "transformer" },
    });

    expect(screen.getByText("transformers")).toBeInTheDocument();
    expect(screen.queryByText("cnn layers")).not.toBeInTheDocument();
  });

  it("deletes a note after confirmation", () => {
    useNotesStore.setState({ notes: [makeNote()], loaded: true });

    render(<NotesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this note?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(useNotesStore.getState().notes).toEqual([]);
  });
});
