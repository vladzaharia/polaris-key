import * as React from "react";
import { cn } from "../../../lib/cn.js";

/** A product- or account-page section card: `surface-raised`, `xl` radius, an `h2`, anchored by
 *  id. */
export function SectionCard({
  id,
  title,
  aside,
  subtitle,
  children,
  className,
  plain = false,
}: {
  id: string;
  title: React.ReactNode;
  aside?: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** A card of only a head (Help: its action sits in the head): no space under it. */
  plain?: boolean;
}): React.ReactElement {
  return (
    <section
      id={`section-${id}`}
      aria-labelledby={`section-${id}-h`}
      data-section={id}
      className={cn(
        // A jump lands it 9rem (6rem on desk) below the top: the shell's scroll padding
        // (`--pk-scroll-top`: the header, and the section pills) plus this margin; never closer
        // than 2rem under the tablet pills, and 0.75rem under whatever sticks on a short screen
        // (styles.css).
        "scroll-mt-[calc(9rem_-_var(--pk-scroll-top,0px))] rounded-xl border border-border bg-surface-raised p-5 shadow-elevation-1 bigtext:p-3 desk:scroll-mt-[max(2rem,calc(6rem_-_var(--pk-scroll-top,0px)))] desk:p-6 short:scroll-mt-3",
        className,
      )}
    >
      <div
        className={cn(
          "flex flex-wrap justify-between gap-x-3 gap-y-1",
          plain ? "items-center" : "mb-4 items-start desk:mb-2",
        )}
      >
        <div className="min-w-0 space-y-1">
          {/* tabIndex -1: a jump from the section nav moves focus here (PS-05 review M4). */}
          <h2
            id={`section-${id}-h`}
            tabIndex={-1}
            className="text-lg font-semibold text-fg-strong outline-none"
          >
            {title}
          </h2>
          {subtitle ? (
            <p className="text-sm text-fg-muted">{subtitle}</p>
          ) : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
