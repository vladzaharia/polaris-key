import * as React from "react";

/**
 * A table that may scroll sideways, inside a named, focusable region (WCAG 1.4.10 and 2.1.1; the
 * e2e `unlabelledScrollers` check). `label` names the region and `caption` (by default the label)
 * the table. A region's name is unique on the page: inside a section of the same name, give the
 * region its own label.
 */
export function ScrollTable({
  label,
  caption = label,
  className,
  children,
}: {
  label: string;
  caption?: string;
  /** The table's classes. */
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto"
    >
      <table className={className}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
