import * as React from "react";
import { cn } from "../../../lib/cn.js";
import type { ProductSection } from "../../router.js";
import { PHONE_ORDER, SECTION_LABEL } from "../../model/product.js";

/**
 * The in-page section nav (§4.20): a sticky TOC at ≥ 1180 px, sticky pill tabs in the phone's
 * task order on phones, hidden between. It lists only the sections present and marks the one on
 * screen. `labels` adds counts ("Devices 2").
 */
export function SectionNav({
  sections,
  current,
  labels,
  onPick,
  hrefFor,
  variant,
}: {
  sections: readonly ProductSection[];
  current: ProductSection | null;
  labels?: Partial<Record<ProductSection, string>>;
  onPick: (s: ProductSection) => void;
  hrefFor: (s: ProductSection) => string;
  variant: "toc" | "pills";
}): React.ReactElement {
  const order =
    variant === "pills"
      ? PHONE_ORDER.filter((s) => sections.includes(s))
      : sections;
  return (
    <nav
      aria-label={variant === "toc" ? "On this page" : "Sections"}
      // pk-vt-chrome: a sticky nav holds still through a list transition (src/motion.css).
      className={cn(
        "pk-vt-chrome",
        variant === "toc"
          ? "sticky top-24 hidden w-[9.25rem] shrink-0 self-start wide:block"
          : "sticky top-14 z-20 -mx-4 overflow-x-auto border-b border-border bg-surface-page px-4 py-2 desk:hidden",
      )}
    >
      <ul
        className={variant === "toc" ? "border-l border-border" : "flex gap-2"}
      >
        {order.map((s) => {
          const on = s === current;
          const text = labels?.[s] ?? SECTION_LABEL[s];
          return (
            <li key={s}>
              <a
                href={hrefFor(s)}
                aria-current={on ? "location" : undefined}
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
                {text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
