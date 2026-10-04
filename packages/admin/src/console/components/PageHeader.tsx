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
 * Below 640 px every secondary action moves into "More actions" and the primary action becomes a
 * full-width button under the title.
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

  return (
    <header className={cn("space-y-3", className)}>
      {eyebrow}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
          {description || meta || freshness ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
              {description ? <p>{description}</p> : null}
              {meta}
              {freshness ? (
                <span className="inline-flex items-center gap-1">
                  <span>
                    Updated {formatRelative(freshness.updatedAt, freshness.now)}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    loading={freshness.refreshing}
                    iconStart={<RefreshCw aria-hidden />}
                    onClick={freshness.onRefresh}
                  >
                    Refresh
                  </Button>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {primaryAction ||
        secondaryActions.length > 0 ||
        dangerActions.length > 0 ? (
          <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center">
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
              <span className="inline-flex justify-end sm:hidden">
                <ActionMenu label="More actions" items={mobileMenu} />
              </span>
            ) : null}
            {primaryAction ? (
              <div className="[&>*]:w-full sm:[&>*]:w-auto">
                {primaryAction}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {tabs ? <div className="border-b border-border">{tabs}</div> : null}
      <RefetchBar active={refetching} />
      {sticky ? (
        <>
          <div ref={sentinel} aria-hidden className="h-px" />
          {condensed ? (
            <div
              data-condensed-header=""
              className="fixed inset-x-0 top-16 z-30 flex h-12 items-center justify-between gap-3 border-b border-border bg-surface-raised px-6 lg:left-(--sidebar-w)"
            >
              <span aria-hidden className="truncate font-bold text-fg-strong">
                {title}
              </span>
              {primaryAction ? (
                <span className="shrink-0">{primaryAction}</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </header>
  );
}
