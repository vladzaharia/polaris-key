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
            // Two per row below 1280 px, where an odd last tile spans the row so none is left an
            // orphan beside empty space; from 1280 px as many equal columns as there are tiles.
            <div
              data-tiles=""
              className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] max-xl:[&>:last-child:nth-child(odd)]:col-span-2"
            >
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

/** A titled card for a dashboard panel: the shared `Section` (EXPERIENCE.md §3), from `ui/`. */
export { Panel, type PanelProps } from "../../ui/Section.js";

export type AttentionTone = "danger" | "warning" | "info";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  /** The object the item is about: an `EntityLink`, a product name. */
  object: React.ReactNode;
  /** The object's full text when `object` is markup (a link): the truncated name's tooltip. */
  objectTitle?: string;
  /** One line: why it needs the operator. */
  reason: string;
  /** One action: a link (`href`) or a handler. */
  action?: { label: string; href?: string; onSelect?: () => void };
  /** For ordering within a tone: newest first. */
  at?: number;
}

// ── First-load stagger (notes/S-23 §6.1 stagger-list; MO-11) ───────────────────────────────────

/** A View Transition is running: the motion layer sets `html[data-vt]` for its length. */
function viewTransitionRunning(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-vt")
  );
}

/** Pages that have mounted in this document: a return visit is never a first load. */
const visitedPages = new Set<string>();
/** Pages whose first load has been committed: a list that mounts after it is not part of it. */
const loadedPages = new Set<string>();

/**
 * A dashboard's first load: `page` (a stable key such as `home` or `overview:<slug>`) on the
 * page's first mount in this document, `undefined` on every later one (a return visit, cached or
 * not). Pass it to `AttentionList`'s `stagger`. The first load ends with the first commit that has
 * the page's data (`pending` false): the list that mounts with the data is part of it, a list
 * mounted after that (a refetch that turns an empty list into one, a remount) is not, however
 * stale the prop it was given. Whether the page's data was cached does not matter (Overview gets
 * its product at once from the products list); a route change's View Transition does, and
 * `AttentionList` checks for one as its list mounts.
 */
export function useFirstLoad(
  page: string,
  pending: boolean,
): string | undefined {
  const [first] = React.useState(() => !visitedPages.has(page));
  React.useEffect(() => {
    visitedPages.add(page);
  }, [page]);
  React.useEffect(() => {
    if (!pending) loadedPages.add(page);
  }, [page, pending]);
  return first ? page : undefined;
}

/** Forget every first load: for tests, where each render stands for a fresh document. */
export function forgetFirstLoads(): void {
  visitedPages.clear();
  loadedPages.clear();
}

/**
 * The stagger-list pattern on an attention list (`.pk-stagger` in src/motion.css: each item rises
 * 30 ms after the last, at most 6 steps). Only when the list mounts as part of its page's first
 * load (`useFirstLoad`) with items to show, and never inside a View Transition (a route change's
 * fade-through, which a stagger would fight). Off for good once "Show all" is used: the extra
 * items appear in place, and an item still rising lands at once (the live state wins). The class
 * comes off when the items' own animations have finished (timers never decide it, S-23 §6.2 rule
 * 6), so an item a refetch adds later appears in place; under reduced motion there are none, so it
 * comes off at once. Without the Web Animations API (jsdom) it stays until "Show all".
 */
function useListStagger(
  page: string | undefined,
  nonEmpty: boolean,
  expanded: boolean,
): { className: string | undefined; ref: React.RefCallback<HTMLElement> } {
  const [on, setOn] = React.useState(
    () =>
      page !== undefined &&
      nonEmpty &&
      !loadedPages.has(page) &&
      !viewTransitionRunning(),
  );
  // Adjusted while rendering, so the expanded list never commits with the class.
  if (on && expanded) setOn(false);
  const ref = React.useCallback((el: HTMLElement | null) => {
    if (!el || typeof el.getAnimations !== "function") return;
    // getAnimations() resolves styles first, so the stagger's animations exist by now. Only the
    // items' own: an animation inside an item (a pill's pop) is not the stagger's.
    const own = el
      .getAnimations({ subtree: true })
      .filter(
        (a) =>
          (a.effect as KeyframeEffect | null)?.target?.parentElement === el,
      );
    void Promise.allSettled(own.map((a) => a.finished)).then(() =>
      setOn(false),
    );
  }, []);
  return { className: on ? "pk-stagger" : undefined, ref };
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
 * T1's attention list (ADMIN.md §3), drawn on the shared `Section` card metrics (radius, side
 * padding, light elevation) so it lines up with the panels under it: only rendered when non-empty, at most `max` items with
 * "Show all n". Each item: a tone pill (icon and word), the object, a one-line reason and one
 * action. On the page's first load (`stagger`, from `useFirstLoad`) the items rise in one after
 * another (MO-11).
 */
export function AttentionList({
  items,
  max = 5,
  title = "Needs attention",
  stagger,
}: {
  items: AttentionItem[];
  max?: number;
  title?: string;
  /** The page's first-load key (`useFirstLoad`): the items stagger in on that load only. */
  stagger?: string;
}): React.ReactElement | null {
  const [all, setAll] = React.useState(false);
  const motion = useListStagger(stagger, items.length > 0, all);
  const id = React.useId();
  if (items.length === 0) return null;
  const sorted = sortAttention(items);
  const shown = all ? sorted : sorted.slice(0, max);
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border border-border bg-surface-raised light:shadow-elevation-1"
    >
      <div
        data-card-header=""
        className="flex items-center justify-between border-b border-border px-5 py-2"
      >
        <h2 id={id} className="text-sm font-semibold text-fg-strong">
          {title}
        </h2>
        <StatusPill tone="warning" icon={false} size="sm">
          {items.length}
        </StatusPill>
      </div>
      <ul
        ref={motion.ref}
        className={cn("divide-y divide-border", motion.className)}
      >
        {shown.map((item) => (
          <li
            key={item.id}
            className="flex flex-col items-start gap-2 px-5 py-2.5 sm:flex-row sm:items-center"
          >
            <StatusPill tone={item.tone}>{TONE_WORD[item.tone]}</StatusPill>
            {/* The object never takes the reason's width: from 640 px it is capped at 40 % of the
                row and truncates (full text in the tooltip), and the reason keeps a 16ch floor so
                a long name cannot crush it to a letter per line. */}
            <span
              className="min-w-0 max-w-full truncate text-sm font-medium text-fg-strong sm:max-w-[40%]"
              title={
                item.objectTitle ??
                (typeof item.object === "string" ? item.object : undefined)
              }
            >
              {item.object}
            </span>
            <span className="min-w-0 flex-1 text-sm text-fg sm:min-w-[16ch]">
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
        <div className="border-t border-border px-5 py-2">
          <Button variant="link" size="sm" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${sorted.length}`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
