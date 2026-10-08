import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../../ui/Button.js";
import type { AttentionItem } from "../model/library.js";
import { href } from "../router.js";
import { ProductArt } from "./ProductArt.js";

/**
 * Needs attention (§4.15): only items the person can act on, each with its solid primary
 * action. Hidden when empty.
 *
 * Three columns from 1180 px, two on tablets, one on phones (§8). Each card is a size container:
 * the thumbnail shows only when the card has room for it beside the text (22rem), and the action's
 * label wraps rather than running out of the card, since a developer's name can be any length.
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
      <ul className="grid gap-4 desk:grid-cols-2 wide:grid-cols-3">
        {items.map(({ product, text, action }) => (
          <li
            key={product.slug}
            className="flex min-w-0 gap-4 rounded-xl border border-border bg-surface-raised p-4 shadow-elevation-1 @container"
          >
            <ProductArt
              slug={product.slug}
              name={product.name}
              tint={product.presentation.tint}
              src={product.presentation.headerUrl}
              variant="thumb"
              className="hidden h-[4.625rem] w-[8.25rem] shrink-0 rounded-lg @[22rem]:block"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <h3 className="font-bold text-fg-strong">
                <a
                  href={href.product(product.slug)}
                  className="hover:underline"
                >
                  {product.name}
                </a>
              </h3>
              <p className="text-sm text-fg-muted">{text}</p>
              <Button
                asChild
                size="md"
                className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left"
              >
                {action.external ? (
                  <a href={action.href} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden />
                    {action.label}
                  </a>
                ) : (
                  <a href={action.href}>{action.label}</a>
                )}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
