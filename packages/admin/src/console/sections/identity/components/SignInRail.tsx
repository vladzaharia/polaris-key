/** "On this page": the right rail from 1280 px, pills below it. A dot marks a section with changes. */

import * as React from "react";
import { cn } from "../../../../lib/cn.js";

export interface RailSection {
  id: string;
  title: string;
  dirty?: boolean;
}

function go(id: string): void {
  const el = document.getElementById(id);
  el?.scrollIntoView({ block: "start" });
  el?.focus({ preventScroll: true });
}

export function SignInRail({
  sections,
  variant,
  className,
}: {
  sections: RailSection[];
  /** `pills` below 1280 px, `rail` from it. */
  variant: "pills" | "rail";
  className?: string;
}): React.ReactElement {
  const [active, setActive] = React.useState(sections[0]?.id ?? "");
  const link = (s: RailSection, pill: boolean): React.ReactElement => (
    <a
      key={s.id}
      href={`#${s.id}`}
      aria-current={s.id === active ? "location" : undefined}
      onClick={(e) => {
        e.preventDefault();
        setActive(s.id);
        go(s.id);
      }}
      // The rail's current-section marker on the inline-start edge (BRAND.md §5.4, C3).
      data-ui-allow={pill ? undefined : "border-width"}
      className={cn(
        "inline-flex items-center gap-1.5 text-sm hover:text-fg-strong",
        pill
          ? "shrink-0 rounded-full border border-border px-3 py-1"
          : "-ms-px border-s-2 py-0.5 ps-3",
        s.id === active
          ? "border-border-strong font-medium text-fg-strong"
          : "border-transparent text-fg-muted",
      )}
    >
      {s.title}
      {s.dirty ? (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-fg-strong" />
          <span className="sr-only">(unsaved changes)</span>
        </>
      ) : null}
    </a>
  );
  if (variant === "pills")
    return (
      <nav aria-label="Jump to section" className={cn("xl:hidden", className)}>
        <ul className="flex flex-wrap gap-1.5">
          {sections.map((s) => (
            <li key={s.id}>{link(s, true)}</li>
          ))}
        </ul>
      </nav>
    );
  return (
    <>
      <nav
        aria-label="On this page"
        className={cn("hidden xl:block", className)}
      >
        <p className="mb-2 text-xs font-medium text-fg-muted">On this page</p>
        <ul className="space-y-1 border-s border-border">
          {sections.map((s) => (
            <li key={s.id}>{link(s, false)}</li>
          ))}
        </ul>
      </nav>
    </>
  );
}
