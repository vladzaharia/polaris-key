import * as React from "react";
import {
  Box,
  CircleArrowUp,
  KeyRound,
  Package,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { PolarisMark } from "@polaris-key/brand/react";
import type { ServiceSlug } from "../api.js";
import { SERVICE_TABLE } from "../services.generated.js";
import { cn } from "../lib/cn.js";

/**
 * A service's glyph (components.md §6.6, ADMIN.md §2.4): the Star Cut ("Polaris Key Delivery")
 * for Distribution, a lucide icon for the others (Update: `CircleArrowUp`, the recognisable
 * "update available" glyph; `RefreshCw` stays the refresh/resync verb). It sets its own `data-service`, so
 * it takes that service's accent wherever it sits; it is the one component allowed to.
 * Decorative: the label beside it names the service. The Star Cut is identity only, never a
 * status or progress indicator (BRAND.md §7.1).
 */
const LUCIDE: Record<string, LucideIcon> = {
  core: Box,
  license: KeyRound,
  config: SlidersHorizontal,
  release: Package,
  update: CircleArrowUp,
  identity: UserRound,
};

const STAR_CUT = new Set(["distribution"]);

export function ServiceGlyph({
  id,
  size = 16,
  className,
}: {
  id: ServiceSlug | "core";
  size?: 16 | 24;
  className?: string;
}): React.ReactElement {
  if (STAR_CUT.has(id)) {
    return (
      <span
        data-service={id}
        className={cn("inline-flex shrink-0 text-accent", className)}
      >
        <PolarisMark kind="update" size={size} theme="mono" />
      </span>
    );
  }
  const Icon = LUCIDE[id] ?? Box;
  return (
    <span
      data-service={id}
      className={cn("inline-flex shrink-0 text-accent", className)}
    >
      <Icon aria-hidden width={size} height={size} />
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
