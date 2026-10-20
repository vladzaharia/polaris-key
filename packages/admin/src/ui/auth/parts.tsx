import * as React from "react";
import { cn } from "../../lib/cn.js";
import { t } from "../../lib/copy.js";

/**
 * The pieces every step of the card shares (SIGN-IN.md §3.2 step slots): the h1 the card focuses
 * on a step change, the "or" rule, and the quiet links under a rule.
 */
export function AuthTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <h1
      tabIndex={-1}
      className={cn(
        "text-2xl font-semibold text-fg-strong outline-none",
        className,
      )}
    >
      {children}
    </h1>
  );
}

/** "or" between the email form and the other ways (§3.3). */
export function OrDivider(): React.ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm text-fg-muted" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      {t("signin.or")}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * The quiet links under a rule (§3.3), centred and evenly spaced: 24 px from the rule to the text
 * and 24 px from the text to the card's bottom edge. Each link is a 44 px target with its 20 px
 * line centred in it (12 px either side), so the row adds 12 px of padding above it and pulls the
 * body's bottom padding (24 px on phones, 32 px wide) in by 12 px or 20 px below it.
 */
export function QuietLinks({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      data-quiet-links
      className="-mb-3 flex flex-wrap items-center justify-center gap-x-5 border-t border-border pt-3 text-sm text-fg-muted sm:-mb-5"
    >
      {children}
    </div>
  );
}

export function QuietLink({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-sm px-1 transition-colors duration-(--pk-duration-fast) hover:text-fg-strong"
    >
      {icon}
      {children}
    </button>
  );
}
