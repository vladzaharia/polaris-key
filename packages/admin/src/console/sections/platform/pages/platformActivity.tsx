/**
 * Platform → Activity (ST-51; admin.platform-activity, admin.platform-activity-event): every
 * product's audit trail and the platform's own, newest first, in one workbench: the facets and the
 * view switch are the band, Timeline or Table below, Load more from the server, and a routed
 * drawer for one event (the URL names it).
 *
 * - The filters are the product Activity's (actor, action area, target kind, date range) plus the
 *   Product facet; the Worker applies them before it pages (`GET /platform/activity?product=all`),
 *   and they live in the URL, so a filtered view is a link.
 * - The feed carries no total, so the foot counts what is loaded and never implies a full history.
 * - A row carries the service its action belongs to (`data-service`, B17): the selected row's tint
 *   and bar take that accent.
 */

import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, List, Rows3 } from "lucide-react";
import {
  api,
  type PlatformActivityFilters,
  type PlatformActivityItem,
  type PlatformActivityPage,
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
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Timeline, TimelineItem } from "../../../../ui/Timeline.js";
import { toast } from "../../../../ui/toast.js";
import { qk } from "../../../data/queries.js";
import { EventDrawer } from "./platformActivityEvent.js";
import { ActivityTable, actorName, whatOf } from "./platformActivityParts.js";
import { useProducts } from "../../../data/hooks.js";
import { Link, navigate, useLocation } from "../../../router.js";
import { r } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { ACTION_GROUPS, TARGET_KINDS } from "../../core/model/activityVerbs.js";
import { useQueryParams } from "../../core/model/urlState.js";

const PAGE_SIZE = 50;
const PLATFORM = "platform";

const RANGES: { value: string; label: string; hours: number | null }[] = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
  { value: "90d", label: "Last 90 days", hours: 24 * 90 },
  { value: "all", label: "Any time", hours: null },
];
const DEFAULT_RANGE = "7d";

// `who` is the actor's display name, for a link that names the person (Members → Show activity).
const KEYS = [
  "actor",
  "who",
  "action",
  "kind",
  "product",
  "range",
  "view",
] as const;
type Params = Record<(typeof KEYS)[number], string>;

/** What the filters send. `since` is fixed per range choice and refresh. */
function serverFilters(p: Params, anchor: number): PlatformActivityFilters {
  const range = RANGES.find((x) => x.value === (p.range || DEFAULT_RANGE));
  return {
    product: p.product || "all",
    ...(p.actor ? { actor: p.actor } : {}),
    ...(p.action ? { action: p.action } : {}),
    ...(p.kind ? { targetKind: p.kind } : {}),
    ...(range?.hours ? { since: toSeconds(anchor) - range.hours * 3600 } : {}),
  };
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

  const items = React.useMemo(
    () => feed.data?.pages.flatMap((p) => p.items) ?? [],
    [feed.data],
  );
  const byProduct = React.useMemo(
    () => new Map((products.data ?? []).map((p) => [p.slug, p])),
    [products.data],
  );
  const actors = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of items) if (i.actor.sub) seen.set(i.actor.sub, actorName(i));
    if (params.actor && params.actor !== "system" && !seen.has(params.actor))
      seen.set(params.actor, params.who || params.actor);
    return [
      { value: "system", label: "Polaris Key (runtime)" },
      ...[...seen.entries()].map(([value, label]) => ({ value, label })),
    ];
  }, [items, params.actor, params.who]);

  const range = params.range || DEFAULT_RANGE;
  const filtered =
    Boolean(params.actor || params.action || params.kind || params.product) ||
    range !== DEFAULT_RANGE;
  const view = params.view === "timeline" ? "timeline" : "table";
  const clear = (): void => {
    setAnchor(Date.now());
    setParams({
      actor: null,
      who: null,
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
        "actor",
        "action",
        "product",
        "target_kind",
        "target_id",
        "summary",
      ],
      items.map((i) => [
        formatIso(fromSeconds(i.at)),
        i.actor.email || i.actor.sub || "polaris-key",
        i.action,
        i.product ?? PLATFORM,
        i.target?.kind ?? "",
        i.target?.id ?? "",
        i.summary,
      ]),
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
              Export CSV
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
          className="flex flex-wrap items-center gap-2 border-b border-border bg-(--pk-admin-band) px-4 py-3"
        >
          <Select
            aria-label="Actor"
            options={actors}
            value={params.actor || null}
            allowEmpty
            emptyLabel="Anyone"
            onChange={(v) => setParams({ actor: v, who: null })}
            className="w-auto min-w-36"
          />
          <Select
            aria-label="Action"
            options={ACTION_GROUPS}
            value={params.action || null}
            allowEmpty
            emptyLabel="Any action"
            onChange={(v) => setParams({ action: v })}
            className="w-auto min-w-36"
          />
          <Select
            aria-label="Target kind"
            options={TARGET_KINDS}
            value={params.kind || null}
            allowEmpty
            emptyLabel="Any target"
            onChange={(v) => setParams({ kind: v })}
            className="w-auto min-w-36"
          />
          <Select
            aria-label="Date range"
            options={RANGES.map(({ value, label }) => ({ value, label }))}
            value={range}
            onChange={(v) => {
              setAnchor(Date.now());
              setParams({ range: v === DEFAULT_RANGE ? null : v });
            }}
            className="w-auto min-w-36"
          />
          <Select
            aria-label="Product"
            options={[
              { value: PLATFORM, label: "Platform" },
              ...(products.data ?? []).map((p: ProductDetail) => ({
                value: p.slug,
                label: p.name,
              })),
            ]}
            value={params.product || null}
            allowEmpty
            emptyLabel="Product"
            onChange={(v) => setParams({ product: v })}
            className="w-auto min-w-36"
          />
          <div className="ms-auto flex items-center gap-2">
            {filtered ? (
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
                        <Link
                          to={eventHref(i.id)}
                          className="inline-flex min-h-6 items-center text-xs text-accent-fg underline-offset-4 hover:underline"
                        >
                          Details
                          <span className="sr-only">: {whatOf(i)}</span>
                        </Link>
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
                  onClick={() => void feed.fetchNextPage()}
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
        onClose={() => navigate(listHref())}
      />
    </CollectionTemplate>
  );
}
