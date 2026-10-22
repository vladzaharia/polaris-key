/**
 * Platform → Activity's row pieces: the service an action belongs to, the actor and "what" words,
 * the product cell and the table (ST-51).
 */

import * as React from "react";
import type { PlatformActivityItem, ProductDetail } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { formatIso, fromSeconds } from "../../../../lib/format.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { Link } from "../../../router.js";
import { verbFor } from "../../core/model/activityVerbs.js";

/** The service an action's event references, for the row's accent (B17); platform events are core. */
export function serviceOfAction(action: string): string {
  if (
    action.startsWith("commerce.") ||
    action.startsWith("distribution.commerce.")
  )
    return "commerce";
  if (
    action.startsWith("release.") ||
    action.startsWith("package.") ||
    action.startsWith("feed.") ||
    action.startsWith("ci.")
  )
    return "release";
  if (action.startsWith("update.")) return "update";
  if (action.startsWith("distribution.") || action.startsWith("storefront."))
    return "distribution";
  if (action.startsWith("schema.") || action.startsWith("config."))
    return "config";
  if (
    action.startsWith("license.") ||
    action.startsWith("tier.") ||
    action.startsWith("device.") ||
    action.startsWith("key.")
  )
    return "license";
  return "core";
}

export function actorName(item: PlatformActivityItem): string {
  if (!item.actor.sub && !item.actor.email) return "Polaris Key";
  return item.actor.name || item.actor.email || item.actor.sub;
}

/** What happened, in the words the Worker wrote; a row without a summary reads as its action. */
export function whatOf(item: PlatformActivityItem): string {
  return item.summary || verbFor(item.action);
}

/** The product cell: its logo and name, or "Platform" for an event that belongs to none. */
export function ProductCell({
  slug,
  products,
}: {
  slug: string | null | undefined;
  products: Map<string, ProductDetail>;
}): React.ReactElement {
  if (!slug) return <span className="text-fg-muted">Platform</span>;
  const p = products.get(slug);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <ProductLogo
        name={p?.name ?? slug}
        presentation={p?.presentation}
        size={24}
      />
      <span className="truncate">{p?.name ?? slug}</span>
    </span>
  );
}

export function ActivityTable({
  items,
  selected,
  products,
  eventHref,
}: {
  items: PlatformActivityItem[];
  selected: string | undefined;
  products: Map<string, ProductDetail>;
  eventHref: (id: string) => string;
}): React.ReactElement {
  const th =
    "px-4 py-3 text-start text-xs font-semibold text-fg-strong max-sm:sr-only";
  // Phone: each row stacks, every cell under its own label.
  const td =
    "px-4 py-3.5 align-middle text-sm max-sm:flex max-sm:gap-3 max-sm:py-1 max-sm:before:w-16 max-sm:before:shrink-0 max-sm:before:text-xs max-sm:before:text-fg-muted max-sm:before:content-[attr(data-label)]";
  return (
    <div
      role="region"
      aria-label="Activity table"
      tabIndex={0}
      className="pk-scroll overflow-x-auto"
    >
      <table className="w-full table-fixed border-collapse max-sm:block">
        <caption className="sr-only">Activity</caption>
        <colgroup className="max-sm:hidden">
          <col className="w-36" />
          <col className="w-[22%]" />
          <col />
          <col className="w-[15%]" />
        </colgroup>
        <thead className="max-sm:contents">
          <tr className="border-b border-border max-sm:sr-only">
            <th scope="col" className={cn(th, "sm:text-end")}>
              When
            </th>
            <th scope="col" className={th}>
              Who
            </th>
            <th scope="col" className={th}>
              What
            </th>
            <th scope="col" className={th}>
              Product
            </th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {items.map((i) => {
            const on = i.id === selected;
            return (
              <tr
                key={i.id}
                data-service={serviceOfAction(i.action)}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "border-b border-border last:border-b-0 max-sm:block max-sm:px-0 max-sm:py-2",
                  on &&
                    "bg-accent-subtle shadow-[inset_3px_0_0_var(--color-accent-fg,currentColor)]",
                )}
              >
                <td
                  data-label="When"
                  className={cn(
                    td,
                    "whitespace-nowrap tabular-nums text-end max-sm:justify-between",
                  )}
                >
                  <time dateTime={formatIso(fromSeconds(i.at))}>
                    {new Intl.DateTimeFormat("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }).format(fromSeconds(i.at))}
                  </time>
                </td>
                <td data-label="Who" className={cn(td, "truncate")}>
                  {actorName(i)}
                </td>
                <td data-label="What" className={td}>
                  <Link
                    to={eventHref(i.id)}
                    className="inline-flex min-h-6 min-w-0 items-center break-words text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    {whatOf(i)}
                  </Link>
                </td>
                <td data-label="Product" className={td}>
                  <ProductCell slug={i.product} products={products} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
