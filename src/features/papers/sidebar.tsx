import { useTranslation } from "react-i18next";
import { ARXIV_CATEGORIES } from "@/lib/arxiv";
import { usePapersStore } from "@/stores/papers";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const { t } = useTranslation();
  const category = usePapersStore((s) => s.category);
  const setCategory = usePapersStore((s) => s.setCategory);

  return (
    <aside className="w-56 shrink-0 border-e bg-muted/30 p-4">
      <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("categories.title")}
      </h2>
      <nav className="mt-3 flex flex-col gap-1">
        {ARXIV_CATEGORIES.map((cat) => (
          <button
            key={cat.code}
            type="button"
            onClick={() => setCategory(cat.code)}
            title={cat.code}
            className={cn(
              "relative flex items-center justify-between rounded-md px-3 py-2 text-sm transition-all duration-200",
              category === cat.code
                ? "bg-accent font-medium text-accent-foreground before:absolute before:start-1.5 before:top-1/2 before:size-1 before:-translate-y-1/2 before:rounded-full before:bg-primary"
                : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
            )}
            aria-pressed={category === cat.code}
          >
            <span>{t(cat.key)}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
