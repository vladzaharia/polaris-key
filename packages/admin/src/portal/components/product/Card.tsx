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
}: {
  id: string;
  title: React.ReactNode;
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
        // A jump lands it 9rem (6rem on desk) below the top: the shell's scroll padding
        // (`--pk-scroll-top`: the header, and the section pills below desk) plus this margin.
        "scroll-mt-[calc(9rem_-_var(--pk-scroll-top,0px))] rounded-xl border border-border bg-surface-raised p-5 shadow-elevation-1 desk:scroll-mt-[calc(6rem_-_var(--pk-scroll-top,0px))] desk:p-6",
        className,
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {/* tabIndex -1: a jump from the section nav moves focus here (PS-05 review M4). */}
          <h2
            id={`section-${id}-h`}
            tabIndex={-1}
            className="text-lg font-bold text-fg-strong outline-none"
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
