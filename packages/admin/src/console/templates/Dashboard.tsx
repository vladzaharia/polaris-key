/**
 * T1 · Overview / dashboard (ADMIN.md §3): Home, product Overview, Distribution → Health and the
 * Platform pages (Deployment, Operations; S-13 §9.1).
 *
 *   PageHeader (no breadcrumb; the description states scope and freshness)
 *   Attention list (only when non-empty)
 *   2–4 StatTiles (each its own query: its own skeleton or error)
 *   Primary panel (2/3) | Side panel (1/3)   ← the side panel drops below under 1024 px
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

export function DashboardTemplate({
  header,
  attention,
  tiles,
  primary,
  side,
  children,
  firstRun,
}: {
  header: React.ReactNode;
  /** An `AttentionList`; render nothing when it is empty. */
  attention?: React.ReactNode;
  /** 2–4 `StatTile`s: 4 → 2 → 1 columns. */
  tiles?: React.ReactNode;
  primary?: React.ReactNode;
  side?: React.ReactNode;
  /** Full-width panels after the main row. */
  children?: React.ReactNode;
  /** When the scope has nothing yet, a first-run `EmptyState` replaces tiles and panels. */
  firstRun?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-6" data-template="dashboard">
      {header}
      {attention}
      {firstRun ?? (
        <>
          {tiles ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {tiles}
            </div>
          ) : null}
          {primary || side ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              {primary ? (
                <div
                  className={cn(
                    "min-w-0",
                    side ? "lg:col-span-2" : "lg:col-span-3",
                  )}
                >
                  {primary}
                </div>
              ) : null}
              {side ? <div className="min-w-0">{side}</div> : null}
            </div>
          ) : null}
          {children}
        </>
      )}
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
        "rounded-lg border border-border bg-surface-raised",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <Heading id={id} className="text-base font-bold text-fg-strong">
            {title}
          </Heading>
          {description ? (
            <p className="text-sm text-fg-muted">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
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
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 id={id} className="text-sm font-bold text-fg-strong">
          {title}
        </h2>
        <span className="text-sm tabular-nums text-fg-muted">
          {items.length}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {shown.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center"
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
