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
  /** Loading state: announces itself to assistive tech and exposes
   * `aria-busy` so the spinner is not read as static decoration. */
  busy?: boolean;
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
  busy = false,
}: StatePanelProps) {
  const frame =
    tone === "destructive"
      ? "border-destructive/40"
      : tone === "dashed"
        ? "border-dashed"
        : "border-border";
  return (
    <Card className={frame}>
      <CardContent
        // A loading panel that only swaps in silently leaves a screen
        // reader user with no idea work is in progress. `role="status"`
        // implies aria-live="polite", so the transition into and out of
        // this state is announced without stealing focus.
        role={busy ? "status" : undefined}
        aria-busy={busy || undefined}
        className="flex flex-col items-center gap-3 py-12 text-center"
      >
        {/* The spinner is decorative; the title carries the message. */}
        <div className={cn(muted && "text-muted-foreground")} aria-hidden={busy || undefined}>
          {icon}
        </div>
        <p className={cn("text-sm font-medium", muted && "text-muted-foreground")}>{title}</p>
        {description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}
        {action && <div className="mt-1">{action}</div>}
      </CardContent>
    </Card>
  );
}
