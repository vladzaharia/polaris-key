/**
 * T1 · Overview / dashboard (ADMIN.md §3): Home, product Overview, Distribution → Health and the
 * Platform pages (Deployment, Operations; S-13 §9.1).
 *
 *   PageHeader (no breadcrumb; the description states scope and freshness)
 *   Attention list (only when non-empty)
 *   2–4 StatTiles (each its own query: its own skeleton or error)
 *   Primary panel (2/3) | Side panel (1/3)   ← `split`: 2-1 (default) or 1-1; the side panel
 *                                              drops below under 1024 px. Keep the two cells'
 *                                              natural heights close: the shorter cell's last
 *                                              panel stretches to the taller cell, so a tall
 *                                              stack of side panels leaves the primary half
 *                                              empty (and a lone short side panel, the side)
 *   PanelRow: further panels, 50/50
 *   Further full-width panels (tables: deploy history, cron runs…)
 *
 * The template is layout only. Each tile and panel loads independently, so one failing query
 * never blanks the page.
 */

import * as React from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/Button.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Link } from "../router.js";

/**
 * A cell of a side-by-side row of panels: the row's cells stretch to the tallest, and the cell's
 * last panel grows to fill its cell, so neighbouring panels share their top and bottom edges
 * instead of leaving the page running on under the shorter one.
 */
export const STRETCH_CELL =
  "flex min-w-0 flex-col gap-6 [&>:last-child]:flex-1";

export function DashboardTemplate({
  header,
  attention,
  tiles,
  primary,
  side,
  children,
  firstRun,
  split = "2-1",
}: {
  header: React.ReactNode;
  /** An `AttentionList`; render nothing when it is empty. */
  attention?: React.ReactNode;
  /** 2–4 `StatTile`s: one row from 1280 px, two per row below. */
  tiles?: React.ReactNode;
  primary?: React.ReactNode;
  side?: React.ReactNode;
  /** Full-width panels after the main row. */
  children?: React.ReactNode;
  /** When the scope has nothing yet, a first-run `EmptyState` replaces tiles and panels. */
  firstRun?: React.ReactNode;
  /** The primary/side ratio at ≥ 1024 px: 2/3 + 1/3, or 50/50 for two equal-weight panels. */
  split?: "2-1" | "1-1";
}): React.ReactElement {
  const half = split === "1-1";
  return (
    <div className="space-y-6" data-template="dashboard">
      {header}
      {attention}
      {firstRun ?? (
        <>
          {tiles ? (
            // Two per row on a phone; from 1280 px as many equal columns as there are tiles.
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
              {tiles}
            </div>
          ) : null}
          {primary || side ? (
            <div
              className={cn(
                "grid grid-cols-1 gap-6",
                half ? "lg:grid-cols-2" : "lg:grid-cols-3",
              )}
            >
              {primary ? (
                <div
                  className={cn(
                    STRETCH_CELL,
                    half
                      ? !side && "lg:col-span-2"
                      : side
                        ? "lg:col-span-2"
                        : "lg:col-span-3",
                  )}
                >
                  {primary}
                </div>
              ) : null}
              {side ? <div className={STRETCH_CELL}>{side}</div> : null}
            </div>
          ) : null}
          {children}
        </>
      )}
    </div>
  );
}

/**
 * A full-width row of equal-weight panels (50/50 from 1024 px, stacked below): each panel is its
 * own stretch cell, so the pair shares its edges. Pair panels of close natural height; a panel
 * that is much taller than its neighbour belongs on its own row, or the shorter one is left with
 * a well of empty card under its content.
 */
export function PanelRow({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {React.Children.toArray(children).map((child, i) => (
        <div key={i} className={STRETCH_CELL}>
          {child}
        </div>
      ))}
    </div>
  );
}

/** A titled card for a dashboard panel, with an optional "View all →" link. */
export function Panel({
  title,
  description,
  action,
  children,
  className,
  headingLevel = 2,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A link or button at the header's end. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}): React.ReactElement {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex flex-col rounded-lg border border-border bg-surface-raised",
        className,
      )}
    >
      {/* The title takes the free width and the action stays top-right; only an action wider
          than what is left (a phone) wraps under the title. */}
      <div
        data-card-header=""
        className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <Heading id={id} className="text-base font-bold text-fg-strong">
            {title}
          </Heading>
          {description ? (
            <p className="text-sm text-fg-muted">{description}</p>
          ) : null}
        </div>
        {/* A labelled ghost button that ends the header meets the edge by its ink (the trailing
            ghost rule in styles.css; the header is a data-card-header). */}
        {action ? <div className="max-w-full">{action}</div> : null}
      </div>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </section>
  );
}

export type AttentionTone = "danger" | "warning" | "info";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  /** The object the item is about: an `EntityLink`, a product name. */
  object: React.ReactNode;
  /** One line: why it needs the operator. */
  reason: string;
  /** One action: a link (`href`) or a handler. */
  action?: { label: string; href?: string; onSelect?: () => void };
  /** For ordering within a tone: newest first. */
  at?: number;
}

const TONE_ORDER: Record<AttentionTone, number> = {
  danger: 0,
  warning: 1,
  info: 2,
};
const TONE_WORD: Record<AttentionTone, string> = {
  danger: "Urgent",
  warning: "Warning",
  info: "Note",
};

/** Danger, then warning, then info; within a tone, newest first. */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || (b.at ?? 0) - (a.at ?? 0),
  );
}

/**
 * T1's attention list (ADMIN.md §3): only rendered when non-empty, at most `max` items with
 * "Show all n". Each item: a tone pill (icon and word), the object, a one-line reason and one
 * action.
 */
export function AttentionList({
  items,
  max = 5,
  title = "Needs attention",
}: {
  items: AttentionItem[];
  max?: number;
  title?: string;
}): React.ReactElement | null {
  const [all, setAll] = React.useState(false);
  const id = React.useId();
  if (items.length === 0) return null;
  const sorted = sortAttention(items);
  const shown = all ? sorted : sorted.slice(0, max);
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-border bg-surface-raised"
    >
      <div
        data-card-header=""
        className="flex items-center justify-between border-b border-border px-4 py-2"
      >
        <h2 id={id} className="text-sm font-bold text-fg-strong">
          {title}
        </h2>
        <StatusPill tone="warning" icon={false} size="sm">
          {items.length}
        </StatusPill>
      </div>
      <ul className="divide-y divide-border">
        {shown.map((item) => (
          <li
            key={item.id}
            className="flex flex-col items-start gap-2 px-4 py-2.5 sm:flex-row sm:items-center"
          >
            <StatusPill tone={item.tone}>{TONE_WORD[item.tone]}</StatusPill>
            <span className="shrink-0 text-sm font-bold text-fg-strong">
              {item.object}
            </span>
            <span className="min-w-0 flex-1 text-sm text-fg">
              {item.reason}
            </span>
            {item.action ? (
              item.action.href ? (
                <Link
                  to={item.action.href}
                  className="inline-flex shrink-0 items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
                >
                  {item.action.label}
                  <ArrowRight aria-hidden className="size-3.5" />
                </Link>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={item.action.onSelect}
                >
                  {item.action.label}
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {sorted.length > max ? (
        <div className="border-t border-border px-4 py-2">
          <Button variant="link" size="sm" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${sorted.length}`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
