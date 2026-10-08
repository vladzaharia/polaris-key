import * as React from "react";
import { cn } from "../../../lib/cn.js";

/** A product-page section card: `surface-raised`, `xl` radius, an `h2`, anchored by id. */
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
        // Clears the sticky header and the section pills below 1180 px; the header alone above.
        "scroll-mt-36 rounded-xl border border-border bg-surface-raised p-5 shadow-elevation-1 desk:p-6 wide:scroll-mt-24",
        className,
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2
            id={`section-${id}-h`}
            className="text-lg font-bold text-fg-strong"
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
