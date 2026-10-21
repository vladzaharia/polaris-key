import * as React from "react";
import { cn } from "../../../lib/cn.js";

/**
 * An Account section card (the MK-L2 anatomy): a header strip with a rule under it, the section's
 * h2 at the left and its one action at the right (it wraps under the title when the card is
 * narrow), then the body. The ids match `SectionCard` (`section-<id>`, `section-<id>-h`) so the
 * section nav, deep links and focus helpers work on either. PX-15 and PX-31b cards use this too.
 */
export function AccountCard({
  id,
  title,
  aside,
  subtitle,
  children,
  className,
}: {
  id: string;
  title: React.ReactNode;
  /** The section's action, in the header. */
  aside?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section
      id={`section-${id}`}
      aria-labelledby={`section-${id}-h`}
      data-section={id}
      className={cn(
        // Same landing offsets as SectionCard (the shell's scroll padding plus this margin).
        "scroll-mt-[calc(9rem_-_var(--pk-scroll-top,0px))] rounded-xl border border-border bg-surface-raised shadow-elevation-1 desk:scroll-mt-[max(2rem,calc(6rem_-_var(--pk-scroll-top,0px)))] short:scroll-mt-3",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-t-xl border-b border-border bg-hover px-4 py-3 desk:px-5 bigtext:max-sm:px-2">
        {/* tabIndex -1: a jump from the section nav moves focus here. */}
        <h2
          id={`section-${id}-h`}
          tabIndex={-1}
          className="min-w-0 max-w-full break-words text-lg font-semibold text-fg-strong outline-none bigtext:max-sm:text-base"
        >
          {title}
        </h2>
        {aside ? (
          <div className="max-w-full shrink-0 [&_button]:h-auto [&_button]:min-h-9 pointer-coarse:[&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:[overflow-wrap:anywhere]">
            {aside}
          </div>
        ) : null}
      </div>
      <div className="p-4 desk:p-6 bigtext:max-sm:p-2">
        {subtitle ? (
          <p className="mb-4 text-sm text-fg-muted">{subtitle}</p>
        ) : null}
        {children}
      </div>
    </section>
  );
}
