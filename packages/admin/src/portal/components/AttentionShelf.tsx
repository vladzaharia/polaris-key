import { t } from "../../lib/copy.js";
import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../../ui/Button.js";
import type { AttentionItem } from "../model/library.js";
import { href } from "../router.js";
import { ProductIcon } from "./ProductIcon.js";

/**
 * Needs you (§4.15, mockup `portal.library-12`): one bordered card with a row per item the
 * person can act on, each with its action: only the single most urgent item is solid, the others
 * are outlined (B12). Hidden when empty.
 *
 * A row is the product's icon, its name and reason, and the action end-aligned (under the text
 * on a phone, full width). The action is on one line (a long developer's name truncates; the
 * accessible name keeps it whole), and a truncated label shows in full on hover (`title`).
 */
export function AttentionShelf({
  items,
}: {
  items: readonly AttentionItem[];
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="attention-h"
      className="overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1"
    >
      <h2
        id="attention-h"
        className="flex items-baseline gap-2 px-4 py-2 text-md font-semibold text-fg-strong"
      >
        {t("locker.library.needsYou")}
        <span className="text-xs font-normal text-fg-muted">
          {items.length}
        </span>
      </h2>
      <ul className="divide-y divide-border border-t border-border">
        {items.map(({ product, text, action, urgent }) => (
          <li
            key={product.slug}
            className="flex min-w-0 flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3 bigtext:flex-col bigtext:items-start">
              <ProductIcon
                slug={product.slug}
                name={product.name}
                tint={product.presentation.tint}
                src={product.presentation.iconUrl}
                size={40}
                className="shrink-0"
              />
              <p className="min-w-0 text-sm text-fg-muted">
                <a
                  href={href.product(product.slug)}
                  dir="auto"
                  className="font-semibold text-fg-strong hover:underline"
                >
                  {product.name}
                </a>{" "}
                {text}
              </p>
            </div>
            <Button
              asChild
              size="md"
              variant={urgent ? "primary" : "quiet"}
              className="w-full min-w-0 sm:w-auto sm:max-w-[16rem] sm:shrink-0 bigtext:h-auto bigtext:min-h-10 bigtext:whitespace-normal bigtext:py-1.5"
            >
              {action.external ? (
                <a
                  href={action.href}
                  target="_blank"
                  rel="noreferrer"
                  title={action.label}
                >
                  <ExternalLink aria-hidden />
                  <span className="truncate bigtext:overflow-visible bigtext:whitespace-normal">
                    {action.label}
                  </span>
                </a>
              ) : (
                <a href={action.href} title={action.label}>
                  <span className="truncate bigtext:overflow-visible bigtext:whitespace-normal">
                    {action.label}
                  </span>
                </a>
              )}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
