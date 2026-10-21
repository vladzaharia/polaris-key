import * as React from "react";
import { ServiceIcon } from "@polaris-key/brand/react";
import type { ServiceSlug } from "../api.js";
import { SERVICE_TABLE } from "../services.generated.js";
import { cn } from "../lib/cn.js";

/**
 * A service's glyph (components.md §6.6, ADMIN.md §2.4): the brand package's service icon set
 * (BRAND.md §1.1, UK-57), lucide's glyph on a 24 grid in `currentColor` with the stroke following
 * the size. It sets its own `data-service`, so it takes that service's accent wherever it sits;
 * it is the one component allowed to. Decorative: the label beside it names the service. The
 * Star Cut stays the Polaris Key Delivery mark; a service icon is never the Star Cut.
 */
export function ServiceGlyph({
  id,
  size = 16,
  className,
}: {
  id: ServiceSlug | "core";
  size?: 16 | 24;
  className?: string;
}): React.ReactElement {
  return (
    <span
      data-service={id}
      className={cn("inline-flex shrink-0 text-accent", className)}
    >
      <ServiceIcon id={id} size={size} />
    </span>
  );
}

/** A service's label, from the service table ("Core" for core). */
export function serviceLabel(id: ServiceSlug | "core"): string {
  if (id === "core") return "Core";
  return SERVICE_TABLE.find((s) => s.slug === id)?.label ?? id;
}

/** The glyph plus the label: product switcher rows, Services, the dashboard. */
export function ServiceBadge({
  id,
  size = 16,
  className,
}: {
  id: ServiceSlug | "core";
  size?: 16 | 24;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm text-fg",
        className,
      )}
    >
      <ServiceGlyph id={id} size={size} />
      <span>{serviceLabel(id)}</span>
    </span>
  );
}
