import { useTranslation } from "react-i18next";
import { ARXIV_CATEGORIES } from "@/lib/arxiv";
import { usePapersStore } from "@/stores/papers";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const { t } = useTranslation();
  const category = usePapersStore((s) => s.category);
  const setCategory = usePapersStore((s) => s.setCategory);

  return (
    <aside className="min-h-0 w-56 shrink-0 overflow-y-auto border-e bg-muted/60 p-4">
      <h2 className="px-2 font-mono text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground">
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
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:border-ring",
              category === cat.code
                ? "bg-accent font-medium text-accent-foreground before:absolute before:start-1.5 before:top-1/2 before:size-1 before:-translate-y-1/2 before:rounded-full before:bg-primary"
                : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
            )}
            aria-current={category === cat.code ? "true" : undefined}
          >
            <span>{t(cat.key)}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
