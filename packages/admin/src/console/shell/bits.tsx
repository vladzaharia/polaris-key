/**
 * Small pieces the shell components share: keyboard hints, service dots, a product's attention
 * count and the console's live region.
 */

import * as React from "react";
import type { ProductDetail, ProductRef } from "../../api.js";
import { SERVICE_TABLE } from "../../services.generated.js";
import { cn } from "../../lib/cn.js";

export { Kbd } from "../../ui/Kbd.js";

/** A product as the switcher and palette see it: the registry row when loaded, else the session's. */
export type ProductLike = ProductRef | ProductDetail;

/** The services a product runs, in canonical order, or `null` when unknown. */
export function enabledServices(p: ProductLike): string[] | null {
  const services = (p as ProductDetail).services;
  if (!services) return null;
  return SERVICE_TABLE.filter((row) => services[row.slug]?.enabled).map(
    (row) => row.slug,
  );
}

/** How many setup actions a product has outstanding (the switcher's attention badge). */
export function attentionCount(p: ProductLike): number {
  const detail = p as ProductDetail;
  const actions = detail.setup?.nextActions ?? [];
  return Array.isArray(actions) ? actions.length : 0;
}

/**
 * One accent dot per enabled service (ADMIN.md §1.3 "service dots"). Never colour alone: the dots
 * are hidden from assistive technology and an sr-only sentence names the services.
 */
export function ServiceDots({
  product,
  className,
}: {
  product: ProductLike;
  className?: string;
}): React.ReactElement | null {
  const slugs = enabledServices(product);
  if (!slugs) return null;
  const labels = SERVICE_TABLE.filter((row) => slugs.includes(row.slug)).map(
    (row) => row.label,
  );
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        className="inline-flex items-center gap-0.5"
        aria-hidden
        title={labels.length ? `Runs ${labels.join(", ")}` : undefined}
      >
        {slugs.map((slug) => (
          <span
            key={slug}
            data-service={slug}
            className="size-1.5 rounded-full bg-accent"
          />
        ))}
      </span>
      <span className="sr-only">
        {labels.length
          ? `Runs ${labels.join(", ")}.`
          : "Runs no optional services."}
      </span>
    </span>
  );
}

export { LiveRegion } from "../../ui/LiveRegion.js";
