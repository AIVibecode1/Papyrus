import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ErrorBoundary } from "@/components/error-boundary";
import { TopBar } from "@/components/layout/top-bar";
import { PaperList } from "@/features/papers/paper-list";
import { Sidebar } from "@/features/papers/sidebar";
import { NotesPage } from "@/features/notes/notes-page";
import { ReaderView } from "@/features/reader/reader-view";
import { SettingsPage } from "@/features/settings/settings-page";
import { useFavoritesStore } from "@/stores/favorites";
import { useHistoryStore } from "@/stores/history";
import { useNotesStore } from "@/stores/notes";
import { usePapersStore } from "@/stores/papers";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useViewFocus } from "@/hooks/use-view-focus";

export default function App() {
  const { t } = useTranslation();
  const refresh = usePapersStore((s) => s.refresh);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadFavorites = useFavoritesStore((s) => s.load);
  const loadNotes = useNotesStore((s) => s.load);
  const loadHistory = useHistoryStore((s) => s.load);
  const view = useUiStore((s) => s.view);

  useEffect(() => {
    loadSettings();
    loadFavorites();
    void loadNotes();
    void loadHistory();
    void refresh();
  }, [loadSettings, loadFavorites, loadNotes, loadHistory, refresh]);

  // SPA route-change focus: keyboard/screen-reader users land at the top
  // of the new view instead of being stranded on the control that
  // triggered the switch. Each branch marks its root with data-view-root.
  useViewFocus(view);

  return (
    <ErrorBoundary>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
        >
          {t("a11y.skipToContent")}
        </a>
        {view === "papers" ? (
          <>
            <TopBar />
            <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1">
              <Sidebar />
              {/* Only the content column scrolls; the window, the top bar
                  and the sidebar stay fixed. */}
              <main
                id="main-content"
                data-view-root
                tabIndex={-1}
                className="min-h-0 flex-1 overflow-y-auto p-4 focus:outline-none lg:p-6"
              >
                <PaperList />
              </main>
            </div>
          </>
        ) : view === "reader" ? (
          // The reader is a full-height workspace with its own header
          // (back, title, stop). Rendering it inside the TopBar shell
          // would stack two headers and overflow the viewport.
          <ReaderView />
        ) : view === "notes" ? (
          <>
            <TopBar />
            <main
              id="main-content"
              data-view-root
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
            >
              {/* Placeholder until 042 mounts the real notes hub. */}
              <NotesPage />
            </main>
          </>
        ) : (
          <>
            <TopBar />
            <SettingsPage />
          </>
        )}
      </div>
    </ErrorBoundary>
  );
}
