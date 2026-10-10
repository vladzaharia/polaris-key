import * as React from "react";
import { BookOpen, SearchX } from "lucide-react";
import type { ServiceSlug } from "../api.js";
import { cn } from "../lib/cn.js";
import { Button } from "./Button.js";
import { markPartPath } from "./markPath.js";
import { ServiceGlyph, serviceLabel } from "./ServiceBadge.js";

/**
 * Nothing to show, and why (components.md §5.4, BRAND.md §7.7). Copy says what the thing is, why
 * you would want one, and the action.
 *
 * - `first-run`: the **stationary star** motif, the kit's star path (never rotated, never
 *   animated) in `text-fg-subtle` at 48 px inside a faint guide circle.
 * - `no-results`: no illustration; the title ("No licenses match") followed by the active
 *   filters ("status: expired"), and Clear filters.
 * - `service-off`: the service's glyph in its accent, and an "Enable {Service}" action.
 * - `not-found`: names what is missing.
 *
 * There is no error kind: a failed load is `ErrorState` (UI-14).
 */
export type EmptyKind =
  | "first-run"
  | "no-results"
  | "service-off"
  | "not-found";

export interface EmptyStateProps {
  kind: EmptyKind;
  title: React.ReactNode;
  description?: React.ReactNode;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  /** A docs URL: renders a "Docs" link. */
  docs?: string;
  /** service-off: which service. */
  service?: ServiceSlug;
  /** no-results: the active filters as text ("status: expired"). */
  filters?: string;
  onClearFilters?: () => void;
  /** Heading level for the title (default: a paragraph; use 2 on a page whose body this is). */
  headingLevel?: 2 | 3;
  /**
   * `inline` sits inside a card (a settings section, a panel, a table): compact and left-aligned,
   * with no illustration, no dashed border of its own and the docs as a text link, so it never
   * nests a box inside a box. It adds no side padding: the card's body pads it.
   */
  variant?: "default" | "inline";
  className?: string;
}

const STAR = markPartPath("star", { kind: "key", size: 48, theme: "mono" });

/** The stationary star: static, upright, alone. */
export function StationaryStar({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      data-stationary-star=""
      className={cn(
        "inline-flex size-20 items-center justify-center rounded-full border border-border text-fg-subtle",
        className,
      )}
    >
      <svg
        width={48}
        height={48}
        viewBox={STAR.viewBox}
        className="fill-current"
      >
        <path d={STAR.d} />
      </svg>
    </span>
  );
}

export function EmptyState({
  kind,
  title,
  description,
  primaryAction,
  secondaryAction,
  docs,
  service,
  filters,
  onClearFilters,
  headingLevel,
  variant = "default",
  className,
}: EmptyStateProps): React.ReactElement {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  const inline = variant === "inline";
  if (inline && kind !== "service-off") {
    // In a card: one compact, left-aligned block (title, a line of context, actions), never the
    // large centred page-level state.
    return (
      <div
        data-empty={kind}
        className={cn("flex flex-col items-start gap-2 py-1", className)}
      >
        <div className="space-y-0.5">
          <Title className="text-sm font-semibold text-fg-strong">
            {title}
            {kind === "no-results" && filters ? (
              <>
                {" "}
                <span className="rounded-sm bg-surface-sunken px-1 font-mono text-xs">
                  {filters}
                </span>
              </>
            ) : null}
          </Title>
          {description || docs ? (
            <p className="text-sm text-fg-muted">
              {description}
              {description && docs ? " " : null}
              {docs ? (
                <a
                  href={docs}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 whitespace-nowrap text-accent-fg underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <BookOpen aria-hidden className="size-3.5" />
                  Docs
                </a>
              ) : null}
            </p>
          ) : null}
        </div>
        {primaryAction ||
        secondaryAction ||
        (kind === "no-results" && onClearFilters) ? (
          <div className="flex flex-wrap items-center gap-2">
            {kind === "no-results" && onClearFilters ? (
              <Button variant="outline" size="sm" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : null}
            {primaryAction}
            {secondaryAction}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div
      data-empty={kind}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        inline
          ? "gap-3 px-4 py-6"
          : "gap-4 rounded-lg border border-dashed border-border px-6 py-12",
        className,
      )}
    >
      {kind === "first-run" && !inline ? <StationaryStar /> : null}
      {kind === "service-off" && service ? (
        <span
          data-service={service}
          aria-hidden
          className="inline-flex size-14 items-center justify-center rounded-full bg-accent-subtle"
        >
          <ServiceGlyph id={service} size={24} />
        </span>
      ) : null}
      {kind === "not-found" ? (
        <SearchX aria-hidden className="size-8 text-fg-subtle" />
      ) : null}
      <div className="max-w-md space-y-1">
        <Title className="text-base font-semibold text-fg-strong">
          {title}
          {kind === "no-results" && filters ? (
            <>
              {" "}
              <span className="rounded-sm bg-surface-sunken px-1 font-mono text-sm">
                {filters}
              </span>
            </>
          ) : null}
        </Title>
        {description ? (
          <p className="text-sm text-fg-muted">{description}</p>
        ) : null}
      </div>
      {primaryAction ||
      secondaryAction ||
      docs ||
      (kind === "no-results" && onClearFilters) ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {kind === "no-results" && onClearFilters ? (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : null}
          {kind === "service-off" && service ? (
            <span data-service={service} className="contents">
              {primaryAction}
            </span>
          ) : (
            primaryAction
          )}
          {secondaryAction}
          {docs ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={docs} target="_blank" rel="noreferrer">
                <BookOpen aria-hidden className="size-4" />
                Docs
                {kind === "service-off" && service ? (
                  <span className="sr-only"> for {serviceLabel(service)}</span>
                ) : null}
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
