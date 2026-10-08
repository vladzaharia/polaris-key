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
 * Three columns from 900 px; two at 761–899 px, where an odd last card spans both; one on phones
 * (§8). Each card is a size container: the thumbnail shows only when the card has 22rem for it
 * beside the title and reason. The action has its own row at the card's foot, full width and on
 * one line (a long developer's name truncates; the accessible name keeps it whole), so the actions
 * in a row line up.
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
      <ul className="grid gap-4 desk:grid-cols-2 desk:[&>li:last-child:nth-child(odd)]:col-span-2 mid:grid-cols-3 mid:[&>li:last-child:nth-child(odd)]:col-span-1">
        {items.map(({ product, text, action }) => (
          <li
            key={product.slug}
            className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface-raised p-4 shadow-elevation-1 @container"
          >
            <div className="flex min-w-0 gap-4">
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
              </div>
            </div>
            <Button asChild size="md" className="mt-auto w-full min-w-0">
              {action.external ? (
                <a href={action.href} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden />
                  <span className="truncate">{action.label}</span>
                </a>
              ) : (
                <a href={action.href}>
                  <span className="truncate">{action.label}</span>
                </a>
              )}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
