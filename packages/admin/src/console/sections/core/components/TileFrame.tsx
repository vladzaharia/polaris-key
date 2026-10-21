import * as React from "react";
import { ArrowRight } from "lucide-react";
import type { ServiceSlug } from "../../../../services.generated.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { FEATURES } from "../../../../services.generated.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Link } from "../../../router.js";

/** The Overview's per-service tile frame and its two text styles (moved out of `Overview.tsx`). */

/**
 * A tile's title is the feature's name, the one Home and the sidebar use. Ship builds runs three
 * services, each with its own tile, so those are titled by what the tile shows.
 */
const SHIP_BUILDS_TITLES: Partial<Record<ServiceSlug, string>> = {
  release: "Releases",
  distribution: "Rollouts",
  update: "In-app updates",
};

/** Ship builds is one feature: its three tiles wear the Releases accent, not one each. */
const SHIP_BUILDS_ACCENT: ServiceSlug = "release";

export function tileAccent(service: ServiceSlug): ServiceSlug {
  return service in SHIP_BUILDS_TITLES ? SHIP_BUILDS_ACCENT : service;
}

export function tileTitle(service: ServiceSlug): string {
  return (
    SHIP_BUILDS_TITLES[service] ??
    FEATURES.find((f) => f.services.includes(service))?.label ??
    service
  );
}

export function TileFrame({
  service,
  badge,
  href,
  linkLabel,
  loading,
  error,
  onRetry,
  children,
}: {
  service: ServiceSlug;
  /**
   * A pill at the header's right edge: a neutral fact ("Schema v8") or an issue ("Needs
   * setup"). Never a healthy state: pills mean attention (ADMIN.md §5.11).
   */
  badge?: React.ReactNode;
  href: string;
  linkLabel: string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  const id = `tile-${service}`;
  return (
    <section
      data-service={tileAccent(service)}
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-border border-t-2 border-t-accent bg-surface-raised p-4"
    >
      <div data-card-header="" className="flex items-center gap-2">
        <h2
          id={id}
          className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-fg-strong"
        >
          <ServiceGlyph id={service} />
          <span className="min-w-0 break-words">{tileTitle(service)}</span>
        </h2>
        {badge}
      </div>
      <div className="min-h-12 flex-1 space-y-1 text-sm text-fg">
        {loading ? (
          <>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-32" />
          </>
        ) : error ? (
          <ErrorState compact error={error} onRetry={onRetry} />
        ) : (
          children
        )}
      </div>
      <Link
        to={href}
        className="inline-flex min-h-6 items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
      >
        {linkLabel}
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </section>
  );
}

export function Big({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <p className="text-xl font-semibold tabular-nums text-fg-strong">
      {children}
    </p>
  );
}

export function Line({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <p className="text-sm text-fg-muted">{children}</p>;
}
