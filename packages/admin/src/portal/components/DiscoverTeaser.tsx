import * as React from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useDiscover } from "../data.js";
import { offerReason } from "../model/discover.js";
import { href } from "../router.js";
import { ProductArt } from "./ProductArt.js";

/** How many offers the empty Library shows before "See all" (§4.12). */
export const TEASER_LIMIT = 3;

/**
 * "Ready to add" on the empty Library (PORTAL.md §4.12): up to three Discover offers as rows
 * (thumb, name, why), each opening its storefront page (PS-05), with **See all**. Only offers with
 * something to add: a link-only listing is not "ready to add". Renders nothing while Discover is
 * empty, still loading, or failed: the empty Library never waits on it or shows its error.
 */
export function DiscoverTeaser({
  discoverCount,
}: {
  /** The library's count of offers; the offers are fetched only when it is above zero. */
  discoverCount: number | null;
}): React.ReactElement | null {
  const discover = useDiscover((discoverCount ?? 0) > 0);
  const offers =
    discover.data?.filter((o) => o.cta === "add").slice(0, TEASER_LIMIT) ?? [];
  if (!discoverCount || offers.length === 0) return null;
  return (
    <section aria-labelledby="ready-h" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="ready-h"
          className="flex flex-wrap items-baseline gap-x-3 text-lg font-bold text-fg-strong"
        >
          Ready to add
          <span className="text-sm font-normal text-fg-muted">
            From Discover · no key needed
          </span>
        </h2>
        <a
          href={href.discover()}
          className="inline-flex items-center gap-1 text-sm font-bold text-accent-fg hover:underline"
        >
          See all
          <ArrowRight aria-hidden className="size-4" />
        </a>
      </div>
      <ul className="grid gap-4 desk:grid-cols-3">
        {offers.map((o) => (
          <li key={o.product} className="grid">
            <a
              href={href.storefront(o.product)}
              className="flex items-center gap-4 rounded-xl border border-border bg-surface-raised p-2.5 pr-4 shadow-elevation-1 hover:bg-hover"
            >
              <ProductArt
                slug={o.product}
                name={o.name}
                tint={o.tintColor}
                src={o.headerUrl}
                variant="thumb"
                className="aspect-video w-28 shrink-0 rounded-lg"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold text-fg-strong">
                  {o.name}
                </span>
                <span className="block text-sm text-fg-muted">
                  {offerReason(o)?.text}
                </span>
              </span>
              <ChevronRight
                aria-hidden
                className="size-4 shrink-0 text-fg-muted"
              />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
