import * as React from "react";
import { ArrowRight } from "lucide-react";
import type { ServiceSlug } from "../../../../services.generated.js";
import { cn } from "../../../../lib/cn.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { FEATURES } from "../../../../services.generated.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Link } from "../../../router.js";

/** The Overview's feature cards (products.overview): the board's card, its off cell and the section head. */

/** Ship builds is one feature: its services share the Releases accent (and one card). */
const SHIP_BUILDS: readonly ServiceSlug[] = [
  "release",
  "distribution",
  "update",
];

export function tileAccent(service: ServiceSlug): ServiceSlug {
  return SHIP_BUILDS.includes(service) ? "release" : service;
}

/** A card's title is the feature's name, the one Home and the sidebar use. */
export function tileTitle(service: ServiceSlug): string {
  return FEATURES.find((f) => f.services.includes(service))?.label ?? service;
}

/** A section's head on the Overview: the title at 18/24 and, where there is one, a link at its end. */
export function SectionHead({
  id,
  title,
  action,
}: {
  id: string;
  title: string;
  action?: { label: string; to: string };
}): React.ReactElement {
  return (
    <div className="col-span-full flex min-h-6 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id={id} className="text-lg/6 font-semibold text-fg-strong">
        {title}
      </h2>
      {action ? (
        <Link
          to={action.to}
          className="inline-flex min-h-6 shrink-0 items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          {action.label}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

/**
 * One feature on the board: its tile, the name (a link covering the card), the key number with its
 * unit on the right and one foot line. A card with something to fix keeps only a warning dot on
 * its tile (the hero says the problem).
 */
export function FeatureCard({
  service,
  href,
  number,
  unit,
  foot,
  attention = 0,
  loading,
  error,
  onRetry,
}: {
  service: ServiceSlug;
  href: string;
  number?: React.ReactNode;
  unit?: string;
  foot?: React.ReactNode;
  /** How many items need attention here. */
  attention?: number;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}): React.ReactElement {
  const title = tileTitle(service);
  return (
    <article
      data-service={tileAccent(service)}
      data-feature=""
      className="relative flex min-w-0 flex-col justify-center rounded-xl border border-border bg-surface-raised px-4 py-3 hover:bg-hover has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-accent"
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
        <span className="relative">
          <span className="inline-flex size-8 items-center justify-center rounded-md bg-accent-subtle">
            <ServiceGlyph id={service} />
          </span>
          {attention > 0 ? (
            <span
              aria-hidden
              data-attention=""
              className="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-warning ring-2 ring-surface-raised"
            />
          ) : null}
        </span>
        <h3 className="min-w-0 text-base font-medium text-fg-strong">
          <Link
            to={href}
            aria-label={
              attention > 0
                ? `${title}: ${attention} needs attention`
                : undefined
            }
            className="outline-none after:absolute after:inset-0 after:rounded-[inherit]"
          >
            {title}
          </Link>
        </h3>
        {loading ? (
          <Skeleton className="h-6 w-12" />
        ) : number !== undefined ? (
          <span className="text-2xl/8 font-semibold tabular-nums text-fg-strong">
            {number}
            {unit ? (
              <small className="ms-1 text-sm font-normal text-fg-muted">
                {unit}
              </small>
            ) : null}
          </span>
        ) : (
          <span />
        )}
        <span />
        <div className={cn("col-span-2 min-w-0 text-sm text-fg-muted")}>
          {error ? (
            <ErrorState compact error={error} onRetry={onRetry} />
          ) : loading ? (
            <Skeleton className="h-4 w-32" />
          ) : (
            foot
          )}
        </div>
      </div>
    </article>
  );
}

/** A feature the product does not run: a dashed cell in its canonical place, only as tall as its line. */
export function OffCard({
  service,
  href,
}: {
  service: ServiceSlug;
  href: string;
}): React.ReactElement {
  const title = tileTitle(service);
  return (
    <article
      data-service={tileAccent(service)}
      data-feature="off"
      className="relative flex min-w-0 items-center gap-3 rounded-xl border border-dashed border-border-strong px-4 py-2 text-fg-muted has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-accent"
    >
      <span className="inline-flex size-8 items-center justify-center rounded-md bg-surface-sunken text-fg-muted">
        <ServiceGlyph id={service} className="text-fg-muted" />
      </span>
      <h3 className="min-w-0 flex-1 text-base font-normal">
        <Link
          to={href}
          aria-label={`${title}: off. Turn on`}
          className="outline-none after:absolute after:inset-0 after:rounded-[inherit]"
        >
          {title}
        </Link>
      </h3>
      <span
        aria-hidden
        className="inline-flex items-center gap-1 text-sm text-accent-fg"
      >
        Turn on
        <ArrowRight className="size-3.5" />
      </span>
      <span aria-hidden className="text-sm">
        Off
      </span>
    </article>
  );
}
