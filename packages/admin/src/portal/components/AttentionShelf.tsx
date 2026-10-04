import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../../ui/Button.js";
import type { AttentionItem } from "../model/library.js";
import { href } from "../router.js";
import { ProductArt } from "./ProductArt.js";

/**
 * Needs attention (§4.15): only items the person can act on, each with its solid primary
 * action. Hidden when empty.
 */
export function AttentionShelf({
  items,
}: {
  items: readonly AttentionItem[];
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="attention-h" className="space-y-4">
      <h2
        id="attention-h"
        className="flex items-baseline gap-2 text-lg font-bold text-fg-strong"
      >
        Needs attention
        <span className="text-xs font-normal text-fg-muted">
          {items.length}
        </span>
      </h2>
      <ul className="grid gap-4 desk:grid-cols-3">
        {items.map(({ product, text, action }) => (
          <li
            key={product.slug}
            className="flex gap-4 rounded-xl border border-border bg-surface-raised p-4 shadow-elevation-1"
          >
            <ProductArt
              slug={product.slug}
              name={product.name}
              tint={product.presentation.tint}
              variant="thumb"
              className="hidden h-[4.625rem] w-[8.25rem] shrink-0 rounded-lg sm:block"
            />
            <div className="min-w-0 space-y-2">
              <h3 className="font-bold text-fg-strong">
                <a
                  href={href.product(product.slug)}
                  className="hover:underline"
                >
                  {product.name}
                </a>
              </h3>
              <p className="text-sm text-fg-muted">{text}</p>
              <Button asChild size="md">
                <a href={action.href} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden />
                  {action.label}
                </a>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
