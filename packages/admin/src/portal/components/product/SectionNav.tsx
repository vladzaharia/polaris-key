import * as React from "react";
import { cn } from "../../../lib/cn.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import type { ProductSection } from "../../router.js";
import { SECTION_LABEL } from "../../model/product.js";

/**
 * The in-page section nav (§4.20): a sticky TOC at ≥ 1180 px, sticky pill tabs below that (under
 * the 56 px phone header, or the 64 px header from 761 px; at the top on a short screen, where the
 * header scrolls away). Both list only the sections present, in the page's order (`sections`, from
 * `presentSections`: the order the page reads in as it scrolls, owner polish 2026-10-07), and
 * mark the one being read. `counts` adds a count after the label as a small neutral pill, the
 * pill the page uses for its other facts ("Devices 2").
 */
export function SectionNav({
  sections,
  current,
  counts,
  onPick,
  hrefFor,
  variant,
}: {
  sections: readonly ProductSection[];
  current: ProductSection | null;
  counts?: Partial<Record<ProductSection, number>>;
  onPick: (s: ProductSection) => void;
  hrefFor: (s: ProductSection) => string;
  variant: "toc" | "pills";
}): React.ReactElement {
  return (
    <nav
      aria-label={variant === "toc" ? "On this page" : "Sections"}
      // pk-vt-chrome: a sticky nav holds still through a list transition (src/motion.css).
      className={cn(
        "pk-vt-chrome",
        variant === "toc"
          ? "sticky top-24 hidden w-[9.25rem] shrink-0 self-start wide:block short:top-6"
          : "sticky top-14 z-20 -mx-4 overflow-x-auto border-b border-border bg-surface-page px-4 py-2 desk:top-16 desk:-mx-8 desk:px-8 wide:hidden short:top-0",
      )}
    >
      <ul
        className={variant === "toc" ? "border-l border-border" : "flex gap-2"}
      >
        {sections.map((s) => {
          const on = s === current;
          const count = counts?.[s];
          return (
            <li key={s}>
              <a
                href={hrefFor(s)}
                aria-current={on ? "location" : undefined}
                data-nav-section={s}
                onClick={(e) => {
                  e.preventDefault();
                  onPick(s);
                }}
                className={cn(
                  variant === "toc"
                    ? "-ml-px block border-l-2 py-2 pl-4 text-sm"
                    : "inline-flex h-9 items-center whitespace-nowrap rounded-full border px-4 text-sm",
                  variant === "toc"
                    ? on
                      ? "border-accent font-bold text-fg-strong"
                      : "border-transparent text-fg-muted hover:text-fg-strong"
                    : on
                      ? "border-fg-strong bg-fg-strong font-bold text-surface-page"
                      : "border-border-strong text-fg-strong",
                )}
              >
                {/* One run of inline text, so the space is rendered and the link's name reads
                    "Devices 2". */}
                <span>
                  {SECTION_LABEL[s]}
                  {count !== undefined ? (
                    <>
                      {" "}
                      <StatusPill
                        tone="neutral"
                        icon={false}
                        size="sm"
                        className="ml-0.5 align-middle font-normal tabular-nums"
                      >
                        {count}
                      </StatusPill>
                    </>
                  ) : null}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
