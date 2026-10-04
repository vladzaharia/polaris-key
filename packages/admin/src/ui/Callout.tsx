import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "../lib/cn.js";
import { SignedGlyph } from "./SignedBadge.js";

/**
 * An inline explanation or warning (components.md §5.2): the tone's `subtle` background, its
 * `border` outline, an icon and a title in the tone's `fg`. `signed` is gold ("Signed by release
 * key rk-2026-09"): the glyph is gold, the text stays default text (gold is never text).
 *
 * `live` gives it `role="status"`: use it for a callout that appears in response to something
 * (a server change, a failed lookup). Static explanatory callouts get no role (EMR-2).
 */
export type CalloutTone = "info" | "success" | "warning" | "danger" | "signed";

const TONE: Record<CalloutTone, { box: string; title: string }> = {
  info: { box: "border-info-border bg-info-subtle", title: "text-info" },
  success: {
    box: "border-success-border bg-success-subtle",
    title: "text-success",
  },
  warning: {
    box: "border-warning-border bg-warning-subtle",
    title: "text-warning",
  },
  danger: {
    box: "border-danger-border bg-danger-subtle",
    title: "text-danger",
  },
  signed: {
    box: "border-signed-border bg-signed-subtle",
    title: "text-fg-strong",
  },
};

const ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const;

export interface CalloutProps {
  tone?: CalloutTone;
  title?: React.ReactNode;
  /** A button or link, placed at the end (stacks under the text when narrow). */
  action?: React.ReactNode;
  children?: React.ReactNode;
  live?: boolean;
  className?: string;
}

export function Callout({
  tone = "info",
  title,
  action,
  children,
  live = false,
  className,
}: CalloutProps): React.ReactElement {
  const t = TONE[tone];
  return (
    <div
      role={live ? "status" : undefined}
      data-tone={tone}
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-start",
        t.box,
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <span className={cn("mt-0.5 shrink-0", t.title)} aria-hidden>
          {tone === "signed" ? (
            <SignedGlyph size={12} className="mt-0.5" />
          ) : (
            React.createElement(ICON[tone], { className: "size-4" })
          )}
        </span>
        <div className="min-w-0 space-y-1">
          {title ? <p className={cn("font-bold", t.title)}>{title}</p> : null}
          {children ? <div className="text-fg">{children}</div> : null}
        </div>
      </div>
      {action ? <div className="shrink-0 sm:ml-auto">{action}</div> : null}
    </div>
  );
}
