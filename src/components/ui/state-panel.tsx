import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

interface StatePanelProps {
  icon: ReactNode;
  title: string;
  description?: string;
  /** Optional action row (e.g. a Retry or Clear button). */
  action?: ReactNode;
  /** Visual tone for the frame. */
  tone?: "default" | "destructive" | "dashed";
  /** Quiet empty-state look (muted title, muted icon). */
  muted?: boolean;
}

/** One shared pattern for empty / error / loading-adjacent states: a
 * centered icon, title and optional description and action. Direction-
 * safe by construction (flex centering, no physical edge utilities). */
export function StatePanel({
  icon,
  title,
  description,
  action,
  tone = "default",
  muted = false,
}: StatePanelProps) {
  const frame =
    tone === "destructive"
      ? "border-destructive/40"
      : tone === "dashed"
        ? "border-dashed"
        : "border-border";
  return (
    <Card className={frame}>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className={muted ? "text-muted-foreground" : undefined}>{icon}</div>
        <p className={cn("text-sm font-medium", muted && "text-muted-foreground")}>{title}</p>
        {description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}
        {action && <div className="mt-1">{action}</div>}
      </CardContent>
    </Card>
  );
}
