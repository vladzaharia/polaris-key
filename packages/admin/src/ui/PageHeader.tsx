import * as React from "react";
import { CirclePause, CirclePlay, RefreshCw } from "lucide-react";
import { cn } from "../lib/cn.js";
import { formatRelative } from "../lib/format.js";
import { ActionMenu } from "./ActionMenu.js";
import { Button } from "./Button.js";
import { IconButton } from "./IconButton.js";
import { RefetchBar } from "./loading.js";
import { crumbItemsOf, useMasthead } from "./Masthead.js";
import { Switch } from "./Switch.js";

/** A secondary or danger page action (rendered inline or in "More actions"). */
export interface PageAction {
  label: string;
  onSelect: () => void;
  icon?: React.ReactNode;
  disabledReason?: string;
  /** Left out of the phone's "More actions" menu: the page draws it another way there. */
  hideOnPhone?: boolean;
  /** Only in the phone's "More actions": the page draws it another way from `sm` up. */
  phoneOnly?: boolean;
  /**
   * `ghost` draws a quiet inline action (no border) for a link-like destination beside the
   * outline ones (Licenses' Batches). Default `outline`.
   */
  variant?: "outline" | "ghost";
}

export interface PageHeaderProps {
  /** Above the title: `Breadcrumbs` on detail, editor and wizard pages. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /**
   * The title's step on the type scale (EXPERIENCE.md §3): `default` is the `title` size every h1
   * uses; `display` (30 px on phones, 40 px wide) is for the portal's Library and Product titles
   * only.
   */
  size?: "default" | "display";
  /**
   * Let a title of fixed copy (not a record's name) wrap to every line it needs: the two-line clamp
   * is for a name of any length, and would cut a sentence at a large text size (no-access pages).
   */
  unclampedTitle?: boolean;
  /** Beside the title: a `StatusPill`, a count. */
  titleAside?: React.ReactNode;
  /** Scope and context, one line. */
  description?: React.ReactNode;
  /** Badges after the description: `SourceBadge`, ids. */
  meta?: React.ReactNode;
  /**
   * A line of facts under the title row, the full width of the header (not just the title's
   * column, which the actions narrow): a record's id and "Changed …".
   */
  factsRow?: React.ReactNode;
  /** T1: "Updated 2 min ago" plus Refresh. */
  freshness?: {
    updatedAt: number;
    onRefresh: () => void;
    refreshing?: boolean;
    now?: number;
    /** The word before the age: "Updated" (default) or "Checked". */
    verb?: string;
    /**
     * An icon button that pauses the page's own refreshing (Platform → Status), instead of the
     * switch. While it runs there is no Refresh button; paused, Refresh returns.
     */
    pause?: { paused: boolean; onToggle: () => void };
    /** An auto-refresh switch, last in the cluster (flush right). */
    auto?: {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      label: string;
    };
  };
  /** A control that leads the action cluster (an editor's Form/JSON switch). */
  toolbar?: React.ReactNode;
  /** The one primary action (a `Button`). */
  primaryAction?: React.ReactNode;
  /** Up to two show inline on ≥ 640 px (`inlineSecondary`); the rest go to "More actions". */
  secondaryActions?: PageAction[];
  /** How many secondary actions show inline on ≥ 640 px (default 2; 0: all in "More actions"). */
  inlineSecondary?: number;
  /**
   * Draw "More actions" after the primary action, as the last thing on the row (a record with a
   * control beside its primary action). Not for headers with freshness.
   */
  menuLast?: boolean;
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
 * Inside a hub page that owns the `<h1>` (the product settings hub, ST-08), a child page's header
 * is the area's `<h2>`: the page still has exactly one h1, and focus after a navigation lands on
 * the hub's.
 */
export const PageHeaderNested = React.createContext(false);

/**
 * The page header every page in both apps shares (EXPERIENCE.md §4, components.md §1.6): the
 * page's one `<h1>`
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
  size = "default",
  unclampedTitle = false,
  titleAside,
  description,
  meta,
  factsRow,
  freshness,
  toolbar,
  primaryAction,
  secondaryActions = [],
  inlineSecondary = INLINE_SECONDARY,
  menuLast = false,
  dangerActions = [],
  tabs,
  refetching = false,
  sticky = false,
  className,
}: PageHeaderProps): React.ReactElement {
  const wide = secondaryActions.filter((a) => !a.phoneOnly);
  const inline = wide.slice(0, inlineSecondary);
  const overflow = wide.slice(inlineSecondary);
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
  const mobileMenu = withDanger(
    toItems(secondaryActions.filter((a) => !a.hideOnPhone)),
  );

  const nested = React.useContext(PageHeaderNested);
  const masthead = useMasthead();
  // The ONE orientation line (B4): the shell's chip and ancestors, with the page's own crumbs
  // folded in. A nested (hub child) header and a header outside the console draw none.
  const crumbItems = crumbItemsOf(eyebrow);
  const orientation =
    masthead && !nested ? masthead.orientation(crumbItems ?? []) : null;
  const eyebrowNode =
    masthead && !nested ? (crumbItems ? null : eyebrow) : eyebrow;
  const tile = masthead && !nested ? masthead.tile : null;
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

  // A ghost Refresh that ends the header row has no frame, so its 12 px of padding would leave
  // the visible ink ("Refresh") short of the content edge every other header action meets. When
  // it is the last thing on the row, a matching negative margin puts the ink on the edge. Below
  // 640 px the inline secondaries are hidden and the primary action has its own row, so the
  // question is asked per breakpoint.
  const refreshTrailsPhone = Boolean(
    freshness && !freshness.auto && !freshness.pause && mobileMenu.length === 0,
  );
  const refreshTrailsWide = Boolean(
    freshness &&
    !freshness.auto &&
    !freshness.pause &&
    inline.length === 0 &&
    desktopMenu.length === 0 &&
    !primaryAction,
  );

  const trailing = menuLast && !freshness;
  const hasCluster =
    Boolean(freshness) ||
    Boolean(toolbar) ||
    inline.length > 0 ||
    desktopMenu.length > 0 ||
    mobileMenu.length > 0;

  // A lone primary action (no cluster to share the row with) sits beside the title from 36 rem of
  // header, not 42: at 200 % text on a desktop the header is 37 rem, and a row of its own costs a
  // masthead 35 px over its budget.
  const loneAction = !hasCluster && !trailing;
  const primaryEl = primaryAction ? (
    <div
      className={cn(
        "col-span-2 [&>:not(.sr-only)]:w-full sm:[&>:not(.sr-only)]:w-auto",
        loneAction
          ? "sm:@xl:col-span-1 sm:@xl:row-start-1 sm:@max-xl:justify-self-end"
          : "sm:@2xl:col-span-1 sm:@2xl:row-start-1 sm:@max-2xl:justify-self-end",
        trailing
          ? "sm:@2xl:col-start-2"
          : cn(
              "sm:@max-2xl:short:col-span-1 sm:@max-2xl:short:col-start-2",
              // With a cluster the two share row 2; alone, the action sits beside the title.
              hasCluster
                ? "sm:@max-2xl:short:row-start-2"
                : "sm:@max-2xl:short:row-start-1",
              hasCluster ? "sm:@2xl:col-start-3" : "sm:@xl:col-start-2",
            ),
      )}
    >
      {primaryAction}
    </div>
  ) : null;

  return (
    <header
      data-masthead={masthead && !nested ? "" : undefined}
      className={cn(
        "@container relative",
        // Tight under the orientation line: the masthead is at most 140 px (B4).
        masthead && !nested ? "space-y-1" : "space-y-3",
        className,
      )}
    >
      {orientation}
      {eyebrowNode}
      {/* Title left; freshness, secondary actions and the primary action right. Below 640 px the
          "More actions" menu stays on the title row and the primary action takes its own
          full-width row. */}
      {/* A third column only when there is both a cluster and a primary action: an empty track
          would keep its gap and stop the actions short of the right edge. */}
      <div
        className={cn(
          // Three columns when the header itself has the room (a width in rem, so it follows the
          // text size). With less (a phone, or 200 % text) the cluster and the primary action
          // take their own end-aligned rows under the title instead of squeezing it.
          "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2",
          hasCluster &&
            primaryAction &&
            "sm:@2xl:grid-cols-[minmax(0,1fr)_auto_auto]",
        )}
      >
        <div className="flex min-w-0 items-start gap-4">
          {tile ? (
            <span
              aria-hidden
              data-masthead-tile=""
              className="hidden shrink-0 lg:inline-flex"
            >
              {tile}
            </span>
          ) : null}
          <div className="min-w-0 space-y-1">
            <div
              className={cn(
                "flex items-center gap-x-3 gap-y-1",
                // A status beside the title stays beside it: a long name shrinks (two lines,
                // then an ellipsis) instead of pushing the status onto a third row.
                titleAside ? "sm:flex-nowrap flex-wrap" : "flex-wrap",
              )}
            >
              {nested ? (
                <h2 className="text-lg font-medium tracking-tight text-fg-strong">
                  {title}
                </h2>
              ) : (
                <h1
                  tabIndex={-1}
                  data-page-title=""
                  className={cn(
                    "min-w-0 font-medium tracking-tight text-fg-strong outline-hidden forced-colors:outline-none",
                    size === "display"
                      ? "text-3xl lg:text-display"
                      : // 24/32 on a phone, 36/44 on a collection, 32/40 on a record (B4, B6:
                        // never a display size in the console). A long name wraps twice, then ends.
                        cn(
                          unclampedTitle ? "" : "line-clamp-2",
                          "text-2xl leading-8 [overflow-wrap:anywhere]",
                          masthead?.record
                            ? "sm:text-headline-lg sm:leading-10"
                            : "sm:text-4xl sm:leading-11",
                        ),
                  )}
                >
                  {title}
                </h1>
              )}
              {titleAside}
            </div>
            {description || meta ? (
              // A meta that is one flex span (its pieces separated by a gap) joins this row, so the
              // description and the meta share lines instead of stacking (masthead <= 140 px).
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted [&>span.flex]:contents">
                {description ? (
                  <p className="min-w-0 max-w-[72ch]">{description}</p>
                ) : null}
                {meta}
              </div>
            ) : null}
          </div>
        </div>
        {trailing ? primaryEl : null}
        {hasCluster ? (
          <div
            className={cn(
              "flex shrink-0 items-center justify-end gap-2",
              // Last: beside the title on the first row, after the primary action when wide.
              trailing && "col-start-2 row-start-1 sm:@2xl:col-start-3",
              // Below 42 rem the cluster takes its own row under the title. Alone (no primary
              // action to share the row with) it only does so below 36 rem: a lone action beside
              // a two-line title costs less height than a row of its own at 200 % browser zoom.
              !trailing &&
                (primaryAction
                  ? "sm:@max-2xl:col-span-2 sm:@max-2xl:justify-self-end"
                  : "sm:@max-xl:col-span-2 sm:@max-xl:justify-self-end"),
              // A short window (200 % zoom on a laptop): the cluster and the primary action share
              // one row under the title instead of taking one each.
              primaryAction &&
                !trailing &&
                "sm:@max-2xl:short:col-span-1 sm:@max-2xl:short:col-start-1 sm:@max-2xl:short:row-start-2",
              // With an auto-refresh switch the cluster is too wide to share a phone's title row.
              freshness?.auto && "col-span-2 sm:col-span-1",
              // On a phone, a header under 24 rem wide (320 px, or 200 % text): the
              // freshness line and Refresh take their own row instead of squeezing the title
              // against them (B-023).
              freshness && "max-sm:@max-sm:col-span-2",
            )}
          >
            {toolbar}
            {freshness ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-x-1 text-sm text-fg-muted">
                {/* Shown on a phone too: the freshness is the page's one trust cue (B-022). */}
                <span className="whitespace-nowrap">
                  {freshness.verb ?? "Updated"}{" "}
                  {formatRelative(freshness.updatedAt, freshness.now)}
                </span>
                {freshness.pause ? (
                  <IconButton
                    label={
                      freshness.pause.paused
                        ? "Resume refreshing"
                        : "Pause refreshing"
                    }
                    size="sm"
                    icon={
                      freshness.pause.paused ? <CirclePlay /> : <CirclePause />
                    }
                    onClick={freshness.pause.onToggle}
                  />
                ) : null}
                {freshness.pause && !freshness.pause.paused ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-trailing-ghost={
                      refreshTrailsPhone || refreshTrailsWide ? "" : undefined
                    }
                    className={cn(
                      // The overshoot matches the button's padding: big text and the condensed console
                      // cut it to 8 px (`px-2`), so the margin follows.
                      refreshTrailsPhone && "-me-3 bigtext:-me-2 conbig:-me-2",
                      refreshTrailsWide
                        ? "sm:-me-3 sm:bigtext:-me-2 sm:conbig:-me-2"
                        : "sm:me-0",
                    )}
                    loading={freshness.refreshing}
                    iconStart={<RefreshCw aria-hidden />}
                    onClick={freshness.onRefresh}
                  >
                    Refresh
                  </Button>
                )}
                {freshness.auto ? (
                  <Switch
                    className="ms-2"
                    checked={freshness.auto.checked}
                    onCheckedChange={freshness.auto.onCheckedChange}
                    label={freshness.auto.label}
                  />
                ) : null}
              </span>
            ) : null}
            {inline.map((a) => (
              <Button
                key={a.label}
                variant={a.variant ?? "outline"}
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
        {trailing ? null : primaryEl}
      </div>
      {factsRow ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
          {factsRow}
        </div>
      ) : null}
      {tabs ? (
        <div data-masthead-tabs="" className="border-b border-border pt-1">
          {tabs}
        </div>
      ) : null}
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
          // Inside the canvas (B4): under the top bar and its 3 px rule, not over the page frame.
          className="fixed inset-x-0 top-[67px] z-30 flex h-12 items-center justify-between gap-3 border-b border-border bg-surface-raised px-6 lg:start-(--sidebar-w) lg:end-4 lg:rounded-t-[15px]"
        >
          <span aria-hidden className="truncate font-medium text-fg-strong">
            {title}
          </span>
          <span className="shrink-0">{primaryAction}</span>
        </div>
      ) : null}
    </header>
  );
}
