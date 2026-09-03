import { BookOpenText, FileText, MessageSquareText, NotebookPen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { Tab } from "./reader-tabs";

interface TabListProps {
  tab: Tab;
  onTab: (tab: Tab) => void;
}

/** The four AI-panel tabs (overview / walkthrough / ask / notes). */
export function TabList({ tab, onTab }: TabListProps) {
  const { t } = useTranslation();

  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b p-2"
      role="tablist"
      aria-label={t("reader.chatTabs")}
    >
      <Button
        variant={tab === "overview" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => onTab("overview")}
        role="tab"
        aria-selected={tab === "overview"}
      >
        <FileText className="size-3.5" />
        {t("reader.overviewTab")}
      </Button>
      <Button
        variant={tab === "walkthrough" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => onTab("walkthrough")}
        role="tab"
        aria-selected={tab === "walkthrough"}
      >
        <BookOpenText className="size-3.5" />
        {t("reader.walkthroughTab")}
      </Button>
      <Button
        variant={tab === "ask" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => onTab("ask")}
        role="tab"
        aria-selected={tab === "ask"}
      >
        <MessageSquareText className="size-3.5" />
        {t("reader.askTab")}
      </Button>
      <Button
        variant={tab === "notes" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => onTab("notes")}
        role="tab"
        aria-selected={tab === "notes"}
      >
        <NotebookPen className="size-3.5" />
        {t("notes.title")}
      </Button>
      <div className="flex-1" />
    </div>
  );
}
