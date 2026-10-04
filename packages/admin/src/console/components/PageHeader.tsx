import * as React from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { formatRelative } from "../../lib/format.js";
import { ActionMenu } from "../../ui/ActionMenu.js";
import { Button } from "../../ui/Button.js";
import { RefetchBar } from "../../ui/loading.js";

/** A secondary or danger page action (rendered inline or in "More actions"). */
export interface PageAction {
  label: string;
  onSelect: () => void;
  icon?: React.ReactNode;
  disabledReason?: string;
}

export interface PageHeaderProps {
  /** Above the title: `Breadcrumbs` on detail, editor and wizard pages. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Beside the title: a `StatusPill`, a count. */
  titleAside?: React.ReactNode;
  /** Scope and context, one line. */
  description?: React.ReactNode;
  /** Badges after the description: `SourceBadge`, ids. */
  meta?: React.ReactNode;
  /** T1: "Updated 2 min ago" plus Refresh. */
  freshness?: {
    updatedAt: number;
    onRefresh: () => void;
    refreshing?: boolean;
    now?: number;
  };
  /** The one primary action (a `Button`). */
  primaryAction?: React.ReactNode;
  /** Up to two show inline on ≥ 640 px; the rest go to "More actions". */
  secondaryActions?: PageAction[];
  /** Always last in "More actions", after a separator, styled danger. */
  dangerActions?: PageAction[];
  /** `PageTabs`, under the header. */
  tabs?: React.ReactNode;
  /** A background refetch is running: a 2 px line under the header after 400 ms. */
  refetching?: boolean;
  /**
   * `record` and `editor` templates: a condensed bar (title and primary action) pins under the
   * top bar once the header scrolls away.
   */
  sticky?: boolean;
  className?: string;
}

const INLINE_SECONDARY = 2;

/**
 * The page header every template shares (components.md §1.6, ADMIN.md §3): the page's one `<h1>`
 * (focus lands on it after a navigation, ADMIN.md §5.6), one primary action, up to two secondary
 * actions and the rest in "More actions", with danger actions last.
 *
 * Below 640 px every secondary action moves into "More actions" (on the title row) and the primary
 * action becomes a full-width button under the title. Freshness ("Updated … · Refresh") sits in the
 * action cluster, never inline with the description.
 */
export function PageHeader({
  eyebrow,
  title,
  titleAside,
  description,
  meta,
  freshness,
  primaryAction,
  secondaryActions = [],
  dangerActions = [],
  tabs,
  refetching = false,
  sticky = false,
  className,
}: PageHeaderProps): React.ReactElement {
  const inline = secondaryActions.slice(0, INLINE_SECONDARY);
  const overflow = secondaryActions.slice(INLINE_SECONDARY);
  const toItems = (actions: PageAction[], tone?: "danger") =>
    actions.map((a) => ({
      label: a.label,
      onSelect: a.onSelect,
      icon: a.icon,
      disabledReason: a.disabledReason,
      tone,
    }));
  const withDanger = (items: ReturnType<typeof toItems>) =>
    dangerActions.length
      ? [
          ...items,
          ...(items.length ? [{ type: "separator" as const }] : []),
          ...toItems(dangerActions, "danger"),
        ]
      : items;
  const desktopMenu = withDanger(toItems(overflow));
  const mobileMenu = withDanger(toItems(secondaryActions));

  const sentinel = React.useRef<HTMLDivElement>(null);
  const [condensed, setCondensed] = React.useState(false);
  React.useEffect(() => {
    if (!sticky || typeof IntersectionObserver === "undefined") return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) =>
      setCondensed(!entry!.isIntersecting),
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sticky]);

  const hasCluster =
    Boolean(freshness) ||
    inline.length > 0 ||
    desktopMenu.length > 0 ||
    mobileMenu.length > 0;

  return (
    <header className={cn("relative space-y-3", className)}>
      {eyebrow}
      {/* Title left; freshness, secondary actions and the primary action right. Below 640 px the
          "More actions" menu stays on the title row and the primary action takes its own
          full-width row. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1
              tabIndex={-1}
              data-page-title=""
              className="text-2xl font-bold tracking-tight text-fg-strong outline-hidden"
            >
              {title}
            </h1>
            {titleAside}
          </div>
          {description || meta ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
              {description ? <p>{description}</p> : null}
              {meta}
            </div>
          ) : null}
        </div>
        {hasCluster ? (
          <div className="flex shrink-0 items-center justify-end gap-2">
            {freshness ? (
              <span className="inline-flex items-center gap-1 text-sm text-fg-muted">
                <span className="hidden whitespace-nowrap sm:inline">
                  Updated {formatRelative(freshness.updatedAt, freshness.now)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={freshness.refreshing}
                  iconStart={<RefreshCw aria-hidden />}
                  onClick={freshness.onRefresh}
                >
                  Refresh
                </Button>
              </span>
            ) : null}
            {inline.map((a) => (
              <Button
                key={a.label}
                variant="outline"
                className="hidden sm:inline-flex"
                iconStart={a.icon}
                disabledReason={a.disabledReason}
                onClick={a.onSelect}
              >
                {a.label}
              </Button>
            ))}
            {desktopMenu.length > 0 ? (
              <span className="hidden sm:inline-flex">
                <ActionMenu label="More actions" items={desktopMenu} />
              </span>
            ) : null}
            {mobileMenu.length > 0 ? (
              <span className="inline-flex sm:hidden">
                <ActionMenu label="More actions" items={mobileMenu} />
              </span>
            ) : null}
          </div>
        ) : null}
        {primaryAction ? (
          <div className="col-span-2 sm:col-span-1 sm:col-start-3 sm:row-start-1 [&>:not(.sr-only)]:w-full sm:[&>:not(.sr-only)]:w-auto">
            {primaryAction}
          </div>
        ) : null}
      </div>
      {tabs ? <div className="border-b border-border">{tabs}</div> : null}
      {/* Out of the flow, so neither adds space under the header. */}
      <div className="pointer-events-none absolute inset-x-0 top-full">
        <RefetchBar active={refetching} />
        {sticky ? <div ref={sentinel} aria-hidden className="h-px" /> : null}
      </div>
      {/* The condensed bar exists for its primary action; a bare title would cost 48 px for
          nothing. */}
      {sticky && condensed && primaryAction ? (
        <div
          data-condensed-header=""
          className="fixed inset-x-0 top-16 z-30 flex h-12 items-center justify-between gap-3 border-b border-border bg-surface-raised px-6 lg:left-(--sidebar-w)"
        >
          <span aria-hidden className="truncate font-bold text-fg-strong">
            {title}
          </span>
          <span className="shrink-0">{primaryAction}</span>
        </div>
      ) : null}
    </header>
  );
}
