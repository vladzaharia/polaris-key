/**
 * Small pieces the shell components share: service dots.
 */

import * as React from "react";
import type { ProductDetail, ProductRef } from "../../api.js";
import { FEATURES, SERVICE_TABLE } from "../../services.generated.js";
import { cn } from "../../lib/cn.js";

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

/**
 * One accent dot per running feature (ADMIN.md §1.3), the count and order Home's glyph row shows:
 * Ship builds is one dot however many of its services are on. Never colour alone: the dots are
 * hidden from assistive technology and an sr-only sentence names the features.
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
  const running = FEATURES.filter((f) =>
    f.services.some((s) => slugs.includes(s)),
  );
  const labels = running.map((f) => f.label);
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        className="inline-flex items-center gap-0.5"
        aria-hidden
        title={labels.length ? `Runs ${labels.join(", ")}` : undefined}
      >
        {running.map((f) => (
          <span
            key={f.id}
            data-service={f.accent}
            className="size-1.5 rounded-full bg-accent"
          />
        ))}
      </span>
      <span className="sr-only">
        {labels.length
          ? `Runs ${labels.join(", ")}.`
          : "Runs no optional features."}
      </span>
    </span>
  );
}
