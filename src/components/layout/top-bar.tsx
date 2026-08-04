import { Lamp, Moon, ScrollText, Settings, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import { LANGUAGES } from "@/i18n";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

export function TopBar() {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ScrollText className="size-4" />
          </div>
          <span className="font-serif text-lg leading-none tracking-tight">{t("app.name")}</span>
          <span className="hidden text-sm text-muted-foreground sm:inline">{t("app.tagline")}</span>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex items-center rounded-md border bg-muted p-0.5"
            role="group"
            aria-label={t("topbar.language")}
          >
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                type="button"
                onClick={() => i18n.changeLanguage(lang.code)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-semibold transition-colors",
                  "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring",
                  i18n.language === lang.code
                    ? "border bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={i18n.language === lang.code}
              >
                {lang.code === "en" ? "EN" : "عربي"}
              </button>
            ))}
          </div>
          <Button
            variant={view === "settings" ? "secondary" : "outline"}
            size="icon"
            onClick={() => setView(view === "settings" ? "papers" : "settings")}
            aria-label={t("nav.settings")}
            title={t("nav.settings")}
          >
            <Settings className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={toggleTheme}
            aria-label={t("topbar.theme")}
            title={t("topbar.theme")}
          >
            {theme === "dark" ? (
              <Moon className="size-4" />
            ) : theme === "sepia" ? (
              <Lamp className="size-4" />
            ) : (
              <Sun className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </header>
  );
}
