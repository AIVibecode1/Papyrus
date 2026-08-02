import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { TopBar } from "@/components/layout/top-bar";
import { PaperList } from "@/features/papers/paper-list";
import { Sidebar } from "@/features/papers/sidebar";
import { SettingsPage } from "@/features/settings/settings-page";
import { useFavoritesStore } from "@/stores/favorites";
import { usePapersStore } from "@/stores/papers";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";

export default function App() {
  const { t } = useTranslation();
  const refresh = usePapersStore((s) => s.refresh);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadFavorites = useFavoritesStore((s) => s.load);
  const view = useUiStore((s) => s.view);

  useEffect(() => {
    loadSettings();
    loadFavorites();
    void refresh();
  }, [loadSettings, loadFavorites, refresh]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {t("a11y.skipToContent")}
      </a>
      <TopBar />
      {view === "papers" ? (
        <div className="mx-auto flex w-full max-w-6xl flex-1">
          <Sidebar />
          <main id="main-content" className="flex-1 p-4 lg:p-6">
            <PaperList />
          </main>
        </div>
      ) : (
        <SettingsPage />
      )}
    </div>
  );
}
