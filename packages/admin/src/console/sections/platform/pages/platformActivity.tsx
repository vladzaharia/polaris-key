/**
 * Platform → Activity (ST-51; admin.platform-activity, admin.platform-activity-event): the
 * platform's own audit trail, newest first (D10: platform events only by default; the Product facet
 * chooses a product or Any product), in one workbench: the facets and the view switch are the band,
 * Timeline or Table below, Load more from the server, and a routed drawer for one event (the URL
 * names it).
 *
 * - The filters are actor, action area, target kind and date range, with the platform's own action
 *   and target lists, plus the Product facet; the Worker applies them before it pages
 *   (`GET /platform/activity?product=platform`), and they live in the URL, so a filtered view is a
 *   link.
 * - The feed carries no total, so the foot counts what is loaded and never implies a full history.
 * - A row carries the service its action belongs to (`data-service`, B17): the selected row's tint
 *   and bar take that accent.
 */

import * as React from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download, List, Rows3 } from "lucide-react";
import {
  api,
  type PlatformActivityFilters,
  type PlatformActivityItem,
  type PlatformActivityPage,
  type PlatformSetting,
  type ProductDetail,
} from "../../../../api.js";
import { formatIso, fromSeconds, toSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { downloadCsv, toCsv } from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Timeline, TimelineItem } from "../../../../ui/Timeline.js";
import { toast } from "../../../../ui/toast.js";
import { qk } from "../../../data/queries.js";
import { EventDrawer } from "./platformActivityEvent.js";
import {
  ActivityTable,
  FacetSelect,
  actorName,
  whatOf,
} from "./platformActivityParts.js";
import { filterListsFor } from "./platformActivityFilters.js";
import { settingOf, valueText } from "./platformActivityValues.js";
import { useProducts } from "../../../data/hooks.js";
import { Link, navigate, useLocation } from "../../../router.js";
import { r } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useQueryParams } from "../../core/model/urlState.js";

const PAGE_SIZE = 50;
const PLATFORM = "platform";
const ALL = "all";

const RANGES: { value: string; label: string; hours: number | null }[] = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
  { value: "90d", label: "Last 90 days", hours: 24 * 90 },
  { value: "all", label: "Any time", hours: null },
];
const DEFAULT_RANGE = "7d";

const KEYS = ["actor", "action", "kind", "product", "range", "view"] as const;
type Params = Record<(typeof KEYS)[number], string>;

/** What the filters send. `since` is fixed per range choice and refresh. */
function serverFilters(p: Params, anchor: number): PlatformActivityFilters {
  const range = RANGES.find((x) => x.value === (p.range || DEFAULT_RANGE));
  return {
    product: p.product || PLATFORM,
    ...(p.actor ? { actor: p.actor } : {}),
    ...(p.action ? { action: p.action } : {}),
    ...(p.kind ? { targetKind: p.kind } : {}),
    ...(range?.hours ? { since: toSeconds(anchor) - range.hours * 3600 } : {}),
  };
}

/** Focus a row's link once it is drawn (after the last Load more, the button is gone). */
function focusEventLink(id: string | undefined): void {
  if (!id) return;
  requestAnimationFrame(() =>
    [...document.querySelectorAll<HTMLElement>("[data-event-link]")]
      .find((el) => el.dataset.eventLink === id)
      ?.focus(),
  );
}

function useActivityFeed(filters: PlatformActivityFilters) {
  return useInfiniteQuery({
    queryKey: qk.platformActivityFeed(JSON.stringify(filters)),
    queryFn: ({ pageParam }) =>
      api.platformActivity(pageParam, filters, PAGE_SIZE),
    initialPageParam: null as PlatformActivityPage["nextCursor"],
    getNextPageParam: (last: PlatformActivityPage) =>
      last.nextCursor ?? undefined,
  });
}

/** The route's record: the list, or the list with one event's drawer open. */
export function PlatformActivityRoute({
  id,
}: {
  id?: string;
}): React.ReactElement {
  return <PlatformActivityPage eventId={id} />;
}

export function PlatformActivityPage({
  eventId,
}: {
  eventId?: string;
}): React.ReactElement {
  const [params, setParams] = useQueryParams(KEYS);
  const { route } = useLocation();
  const [anchor, setAnchor] = React.useState(() => Date.now());
  const filters = React.useMemo(
    () => serverFilters(params, anchor),
    [params, anchor],
  );
  const feed = useActivityFeed(filters);
  useLoadingAnnouncement("activity", feed.isPending || feed.isRefetching);
  const products = useProducts();
  const platformSettings = useQuery({
    queryKey: qk.platformSettings(),
    queryFn: () => api.platformSettings(),
  });
  const settings = React.useMemo(
    () =>
      new Map<string, PlatformSetting>(
        (platformSettings.data?.settings ?? []).map((s) => [s.key, s]),
      ),
    [platformSettings.data],
  );

  const items = React.useMemo(
    () => feed.data?.pages.flatMap((p) => p.items) ?? [],
    [feed.data],
  );
  const byProduct = React.useMemo(
    () => new Map((products.data ?? []).map((p) => [p.slug, p])),
    [products.data],
  );
  // Every actor seen on this page, so choosing one does not collapse the facet to it.
  const seenActors = React.useRef(new Map<string, string>());
  const actors = React.useMemo(() => {
    const seen = seenActors.current;
    for (const i of items) if (i.actor.sub) seen.set(i.actor.sub, actorName(i));
    if (params.actor && params.actor !== "system" && !seen.has(params.actor))
      seen.set(params.actor, params.actor);
    return [
      { value: "system", label: "Polaris Key" },
      ...[...seen.entries()].map(([value, label]) => ({ value, label })),
    ];
  }, [items, params.actor]);

  const range = params.range || DEFAULT_RANGE;
  const filtered =
    Boolean(params.actor || params.action || params.kind || params.product) ||
    range !== DEFAULT_RANGE;
  const view = params.view === "timeline" ? "timeline" : "table";
  const lists = filterListsFor(params.product);
  const loadMore = (): void => {
    void feed.fetchNextPage().then((res) => {
      // The button unmounts with the last page; focus moves to the first new row.
      if (res.hasNextPage || res.isError) return;
      focusEventLink(res.data?.pages.at(-1)?.items[0]?.id);
    });
  };
  const clear = (): void => {
    setAnchor(Date.now());
    setParams({
      actor: null,
      action: null,
      kind: null,
      product: null,
      range: null,
    });
  };

  const eventHref = (id: string): string =>
    r.platformActivityEvent(id, Object.fromEntries(route.query));
  const listHref = (): string =>
    r.platformActivity(Object.fromEntries(route.query));

  const exportLoaded = (): void => {
    const csv = toCsv(
      [
        "at",
        "actor_name",
        "actor",
        "action",
        "product",
        "target_kind",
        "target_id",
        "summary",
        "before",
        "after",
      ],
      items.map((i) => {
        const setting = settingOf(i, settings);
        return [
          formatIso(fromSeconds(i.at)),
          actorName(i),
          i.actor.email || i.actor.sub || "polaris-key",
          i.action,
          i.product ?? PLATFORM,
          i.target?.kind ?? "",
          i.target?.id ?? "",
          i.summary,
          valueText(i.before, setting)?.text ?? "",
          valueText(i.after, setting)?.text ?? "",
        ];
      }),
    );
    if (!downloadCsv("platform-activity.csv", csv))
      toast.error("Couldn't save the file");
  };

  const tryAgain = (
    <Button variant="outline" size="sm" onClick={() => void feed.refetch()}>
      Try again
    </Button>
  );

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Activity"
          primaryAction={
            <Button
              variant="outline"
              disabled={items.length === 0}
              onClick={exportLoaded}
            >
              <Download aria-hidden />
              {items.length === 0
                ? "Export CSV"
                : `Export ${items.length} loaded ${items.length === 1 ? "event" : "events"}`}
            </Button>
          }
        />
      }
    >
      <div
        data-workbench=""
        className="overflow-hidden rounded-xl border border-border bg-surface-raised"
      >
        <div
          data-workbench-toolbar=""
          role="search"
          aria-label="Filter activity"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-(--pk-admin-band) px-4 py-3 [@media(max-height:500px)]:py-2 [@media(max-height:500px)]:flex-nowrap [@media(max-height:500px)]:overflow-x-auto"
        >
          <FacetSelect
            label="Actor"
            options={actors}
            value={params.actor || null}
            set={Boolean(params.actor)}
            emptyLabel="Anyone"
            onChange={(v) => setParams({ actor: v })}
          />
          <FacetSelect
            label="Action"
            options={lists.actions}
            value={params.action || null}
            set={Boolean(params.action)}
            emptyLabel="Any action"
            onChange={(v) => setParams({ action: v })}
          />
          <FacetSelect
            label="Target kind"
            options={lists.kinds}
            value={params.kind || null}
            set={Boolean(params.kind)}
            emptyLabel="Any target"
            onChange={(v) => setParams({ kind: v })}
          />
          <FacetSelect
            label="Date range"
            options={RANGES.map(({ value, label }) => ({ value, label }))}
            value={range}
            set={range !== DEFAULT_RANGE}
            onChange={(v) => {
              setAnchor(Date.now());
              setParams({ range: v === DEFAULT_RANGE ? null : v });
            }}
          />
          <FacetSelect
            label="Product"
            options={[
              { value: PLATFORM, label: "Platform" },
              { value: ALL, label: "Any product" },
              ...(products.data ?? []).map((p: ProductDetail) => ({
                value: p.slug,
                label: p.name,
              })),
            ]}
            value={params.product || PLATFORM}
            set={Boolean(params.product)}
            onChange={(v) => setParams({ product: v === PLATFORM ? null : v })}
          />
          <div className="ms-auto flex shrink-0 items-center gap-2">
            {filtered && !(feed.data && items.length === 0) ? (
              <Button variant="ghost" size="sm" onClick={clear}>
                Clear filters
              </Button>
            ) : null}
            <SegmentedControl
              aria-label="View"
              value={view}
              onChange={(v) =>
                setParams({ view: v === "timeline" ? "timeline" : null })
              }
              options={[
                {
                  value: "timeline",
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <List aria-hidden className="size-3.5" />
                      Timeline
                    </span>
                  ),
                },
                {
                  value: "table",
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Rows3 aria-hidden className="size-3.5" />
                      Table
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </div>

        {feed.isPending ? (
          <div
            aria-hidden
            className="pk-skeleton-group space-y-3 px-4 py-4"
            data-testid="activity-loading"
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-1/5" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : feed.isError && !feed.data ? (
          <div className="p-4">
            <ErrorState
              error={feed.error}
              context={{ read: true }}
              onRetry={() => void feed.refetch()}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="p-4">
            {filtered ? (
              <EmptyState
                kind="no-results"
                variant="inline"
                title="No activity matches these filters"
                description="Widen the date range or clear a filter."
                onClearFilters={clear}
                secondaryAction={tryAgain}
              />
            ) : (
              <EmptyState
                kind="first-run"
                variant="inline"
                title="No activity yet"
                description="Each change made in the console, and each security event the runtime records, appears here with who made it."
                secondaryAction={tryAgain}
              />
            )}
          </div>
        ) : (
          <>
            {view === "timeline" ? (
              <div className="px-4 py-4">
                <Timeline<PlatformActivityItem>
                  label="Activity"
                  headingLevel={2}
                  items={items}
                  getKey={(i) => i.id}
                  getTime={(i) => fromSeconds(i.at)}
                  renderItem={(i) => (
                    <TimelineItem
                      actor={
                        i.actor.sub || i.actor.email
                          ? { name: actorName(i) }
                          : "system"
                      }
                      verb={whatOf(i)}
                      target={
                        <>
                          {i.product ? (
                            <span className="text-fg-muted">
                              · {byProduct.get(i.product)?.name ?? i.product}
                            </span>
                          ) : null}{" "}
                          <Link
                            to={eventHref(i.id)}
                            data-event-link={i.id}
                            className="inline-flex min-h-6 items-center text-xs text-accent-fg underline-offset-4 hover:underline"
                          >
                            Details
                            <span className="sr-only">: {whatOf(i)}</span>
                          </Link>
                        </>
                      }
                      at={fromSeconds(i.at)}
                    />
                  )}
                />
              </div>
            ) : (
              <ActivityTable
                items={items}
                selected={eventId}
                products={byProduct}
                eventHref={eventHref}
              />
            )}
            <div className="flex items-center gap-3 border-t border-border px-4 py-3 text-sm text-fg-muted">
              <span className="tabular-nums" aria-live="polite">
                {items.length === 1 ? "1 event" : `${items.length} events`}
              </span>
              {feed.isFetchNextPageError ? (
                <span role="alert" className="text-danger">
                  Couldn't load more.
                </span>
              ) : null}
              {feed.hasNextPage ? (
                <Button
                  className="ms-auto"
                  variant="outline"
                  size="sm"
                  loading={feed.isFetchingNextPage}
                  onClick={loadMore}
                >
                  {feed.isFetchNextPageError ? "Try again" : "Load more"}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>

      <EventDrawer
        id={eventId}
        loaded={items}
        products={byProduct}
        settings={settings}
        onClose={() => navigate(listHref())}
      />
    </CollectionTemplate>
  );
}
