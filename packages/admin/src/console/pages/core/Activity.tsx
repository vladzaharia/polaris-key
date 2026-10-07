/**
 * Core → Activity (T2 timeline; docs/design/ADMIN.md §6.8). The product's audit log, grouped by
 * day, with a table view.
 *
 * - Filters (actor, action area, target kind and id, date range) are server-side (A-2) and live
 *   in the URL, so a filtered view is a link (ACT-1). Search matches the loaded entries' text.
 * - Targets are `EntityLink`s; rows the runtime wrote show "Polaris Key" (ACT-2).
 * - Nothing non-interactive is focusable (ACT-4); loading and refresh announce through the live
 *   region, and Refresh shows its own spinner (ACT-5). Summaries are clamped and expandable, and
 *   the table view drops columns by priority on narrow screens (ACT-6).
 */

import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, List, Rows3 } from "lucide-react";
import {
  api,
  type ActivityFilters,
  type ActivityItem,
  type ActivityPage,
} from "../../../api.js";
import { formatIso, fromSeconds, toSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import {
  DataTable,
  downloadCsv,
  toCsv,
  type DataColumn,
} from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Input } from "../../../ui/Input.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { Select } from "../../../ui/Select.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { Timeline, TimelineItem } from "../../../ui/Timeline.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { toast } from "../../../ui/toast.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { queryClient } from "../../data/queryClient.js";
import { qk } from "../../data/queries.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { ACTION_GROUPS, TARGET_KINDS, verbFor } from "./activityVerbs.js";
import { useQueryParams } from "./urlState.js";

const PAGE_SIZE = 50;
const RETENTION_DAYS = 180;

const RANGES: { value: string; label: string; hours: number }[] = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
  { value: "90d", label: "Last 90 days", hours: 24 * 90 },
];

const KEYS = [
  "q",
  "actor",
  "action",
  "kind",
  "target",
  "range",
  "view",
] as const;

/** The filters a query sends, from the URL. `since` is fixed per range choice and refresh. */
function serverFilters(
  p: Record<(typeof KEYS)[number], string>,
  anchor: number,
): ActivityFilters {
  const range = RANGES.find((x) => x.value === p.range);
  return {
    ...(p.actor ? { actor: p.actor } : {}),
    ...(p.action ? { action: p.action } : {}),
    ...(p.kind ? { targetKind: p.kind } : {}),
    ...(p.target ? { targetId: p.target } : {}),
    ...(range ? { since: toSeconds(anchor) - range.hours * 3600 } : {}),
  };
}

/**
 * The activity feed for one filter set, paged by cursor. Overview's recent-activity panel reads
 * the unfiltered feed through this too, so both share one cache entry.
 */
export function useActivityFeed(slug: string, filters: ActivityFilters) {
  return useInfiniteQuery(
    {
      queryKey: [...qk.activity(slug), JSON.stringify(filters)],
      queryFn: ({ pageParam }) =>
        api.activity(slug, pageParam, PAGE_SIZE, filters),
      initialPageParam: null as ActivityPage["nextCursor"],
      getNextPageParam: (last: ActivityPage) => last.nextCursor ?? undefined,
    },
    queryClient,
  );
}

export function actorName(item: ActivityItem): string {
  if (!item.actor.sub) return "Polaris Key";
  return item.actor.name || item.actor.email || item.actor.sub;
}

export function ActivityPage({ slug }: { slug: string }): React.ReactElement {
  const [params, setParams] = useQueryParams(KEYS);
  // The date range is measured from when the operator chose it (or refreshed), so the query key
  // does not move every render.
  const [anchor, setAnchor] = React.useState(() => Date.now());
  const filters = React.useMemo(
    () => serverFilters(params, anchor),
    [params, anchor],
  );
  const feed = useActivityFeed(slug, filters);
  useLoadingAnnouncement("activity", feed.isPending || feed.isRefetching);

  const items = React.useMemo(
    () => feed.data?.pages.flatMap((p) => p.items) ?? [],
    [feed.data],
  );
  const q = params.q.trim().toLowerCase();
  const visible = q
    ? items.filter((i) =>
        [i.summary, i.action, actorName(i), i.target?.id ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : items;
  const filtered = Object.keys(filters).length > 0 || q !== "";
  const actors = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of items) {
      if (i.actor.sub) seen.set(i.actor.sub, actorName(i));
    }
    if (params.actor && params.actor !== "system" && !seen.has(params.actor))
      seen.set(params.actor, params.actor);
    return [
      { value: "system", label: "Polaris Key (runtime)" },
      ...[...seen.entries()].map(([value, label]) => ({ value, label })),
    ];
  }, [items, params.actor]);

  const view = params.view === "table" ? "table" : "timeline";
  const updatedAt = feed.dataUpdatedAt || Date.now();

  const exportLoaded = (): void => {
    const csv = toCsv(
      ["at", "actor", "action", "target_kind", "target_id", "summary"],
      visible.map((i) => [
        formatIso(fromSeconds(i.at)),
        i.actor.email || i.actor.sub || "polaris-key",
        i.action,
        i.target?.kind ?? "",
        i.target?.id ?? "",
        i.summary,
      ]),
    );
    if (!downloadCsv(`${slug}-activity.csv`, csv))
      toast.error("Couldn't save the file");
  };

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Activity"
          freshness={{
            updatedAt,
            refreshing: feed.isRefetching,
            onRefresh: () => {
              setAnchor(Date.now());
              void feed.refetch();
            },
          }}
          secondaryActions={[
            {
              label: "Export CSV",
              icon: <Download aria-hidden />,
              onSelect: exportLoaded,
              disabledReason: visible.length ? undefined : "Nothing is loaded.",
            },
          ]}
        />
      }
    >
      <div
        role="search"
        aria-label="Filter activity"
        className="flex flex-wrap items-end gap-3"
      >
        <FilterField label="Search" htmlFor="activity-q">
          <Input
            id="activity-q"
            type="search"
            placeholder="Search entries"
            value={params.q}
            onValueChange={(v) => setParams({ q: v })}
            clearable
          />
        </FilterField>
        <FilterField label="Actor">
          <Select
            aria-label="Actor"
            options={actors}
            value={params.actor || null}
            allowEmpty
            emptyLabel="Anyone"
            onChange={(v) => setParams({ actor: v })}
          />
        </FilterField>
        <FilterField label="Action">
          <Select
            aria-label="Action"
            options={ACTION_GROUPS}
            value={params.action || null}
            allowEmpty
            emptyLabel="Any action"
            onChange={(v) => setParams({ action: v })}
          />
        </FilterField>
        <FilterField label="Target">
          <Select
            aria-label="Target kind"
            options={TARGET_KINDS}
            value={params.kind || null}
            allowEmpty
            emptyLabel="Any target"
            onChange={(v) =>
              setParams({ kind: v, target: v ? params.target : null })
            }
          />
        </FilterField>
        {params.kind ? (
          <FilterField label="Target id" htmlFor="activity-target">
            <Input
              id="activity-target"
              mono
              value={params.target}
              placeholder="Exact id"
              onValueChange={(v) => setParams({ target: v.trim() })}
              clearable
            />
          </FilterField>
        ) : null}
        <FilterField label="When">
          <Select
            aria-label="Date range"
            options={RANGES.map(({ value, label }) => ({ value, label }))}
            value={params.range || null}
            allowEmpty
            emptyLabel="Any time"
            onChange={(v) => {
              setAnchor(Date.now());
              setParams({ range: v });
            }}
          />
        </FilterField>
        <div className="ml-auto flex items-center gap-2">
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setParams({
                  q: null,
                  actor: null,
                  action: null,
                  kind: null,
                  target: null,
                  range: null,
                })
              }
            >
              Clear filters
            </Button>
          ) : null}
          <SegmentedControl
            aria-label="View"
            value={view}
            onChange={(v) =>
              setParams({ view: v === "table" ? "table" : null })
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
        <PageSkeleton template="table" label="activity" />
      ) : feed.isError ? (
        <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
      ) : visible.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="no-results"
            title="No activity matches these filters"
            description={
              q
                ? "Search looks through the loaded entries; load older entries or change the filters."
                : "Nothing in this product's log matches. Widen the date range or clear a filter."
            }
            onClearFilters={() =>
              setParams({
                q: null,
                actor: null,
                action: null,
                kind: null,
                target: null,
                range: null,
              })
            }
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="No activity yet"
            description="Each change made in the console, and each security event the runtime records, appears here with who made it."
            docs="/docs/admin/activity/"
          />
        )
      ) : view === "timeline" ? (
        <Timeline<ActivityItem>
          label="Activity"
          headingLevel={2}
          items={visible}
          getKey={(i) => i.id}
          getTime={(i) => fromSeconds(i.at)}
          renderItem={(i) => (
            <TimelineItem
              actor={i.actor.sub ? { name: actorName(i) } : "system"}
              verb={verbFor(i.action)}
              target={<ActivityTarget slug={slug} item={i} />}
              at={fromSeconds(i.at)}
              summary={
                <span className="block space-y-1">
                  {i.summary ? (
                    <span className="block whitespace-pre-wrap">
                      {i.summary}
                    </span>
                  ) : null}
                  <span className="block font-mono text-xs text-fg-subtle">
                    {i.action}
                  </span>
                </span>
              }
            />
          )}
          loadMore={{
            onLoadMore: () => void feed.fetchNextPage(),
            hasMore: feed.hasNextPage,
            loading: feed.isFetchingNextPage,
          }}
        />
      ) : (
        <ActivityTable
          slug={slug}
          items={visible}
          hasMore={feed.hasNextPage}
          loadingMore={feed.isFetchingNextPage}
          onLoadMore={() => void feed.fetchNextPage()}
        />
      )}
      {!feed.isPending && !feed.isError ? (
        <p className="text-xs text-fg-muted" aria-live="off">
          {items.length} loaded · entries are kept for {RETENTION_DAYS} days
        </p>
      ) : null}
    </CollectionTemplate>
  );
}

function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="relative flex min-w-[10rem] flex-1 flex-col sm:max-w-[14rem]">
      {htmlFor ? (
        // The controls name themselves ("Anyone", "Any action"); the label is for AT only.
        <label htmlFor={htmlFor} className="sr-only">
          {label}
        </label>
      ) : null}
      {children}
    </div>
  );
}

/** The target as a link to the record it names, when the console has one. */
export function ActivityTarget({
  slug,
  item,
}: {
  slug: string;
  item: ActivityItem;
}): React.ReactElement | null {
  const t = item.target;
  // The product itself is the page's scope: naming it again says nothing.
  if (!t || !t.id || t.kind === "product") return null;
  switch (t.kind) {
    case "license":
      return <EntityLink slug={slug} kind="license" id={t.id} />;
    case "tier":
      return <EntityLink slug={slug} kind="tier" id={t.id} />;
    case "license_batch":
      // LX-28/LX-30: a batch's page; its label is in the summary.
      return (
        <Link
          to={r.licenseBatch(slug, t.id)}
          className="font-mono text-xs text-accent-fg underline-offset-4 hover:underline"
        >
          {t.id}
        </Link>
      );
    case "profile":
      return <EntityLink slug={slug} kind="profile" id={t.id} />;
    case "device":
      return <EntityLink slug={slug} kind="device" id={t.id} />;
    case "secret":
    case "ci_token":
    case "ci_publisher":
      return (
        <Link
          to={r.keys(slug)}
          className="font-mono text-xs text-accent-fg underline-offset-4 hover:underline"
        >
          {t.id}
        </Link>
      );
    case "key":
      // A signing key's id is its kid; a license key's is an opaque hash (activity.md).
      return t.id.startsWith(`${slug}-`) ? (
        <Link
          to={r.keys(slug)}
          className="font-mono text-xs text-accent-fg underline-offset-4 hover:underline"
        >
          {t.id}
        </Link>
      ) : (
        <span className="font-mono text-xs text-fg-muted">
          {t.id.slice(0, 10)}…
        </span>
      );
    default:
      return <span className="font-mono text-xs text-fg-muted">{t.id}</span>;
  }
}

function ActivityTable({
  slug,
  items,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  slug: string;
  items: ActivityItem[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}): React.ReactElement {
  const columns = React.useMemo<DataColumn<ActivityItem>[]>(
    () => [
      {
        id: "at",
        header: "When",
        accessorKey: "at",
        meta: {
          numeric: true,
          priority: 1,
          csv: (i) => formatIso(fromSeconds(i.at)),
        },
        cell: ({ row }) => <Timestamp at={fromSeconds(row.original.at)} />,
      },
      {
        id: "actor",
        header: "Actor",
        accessorFn: actorName,
        meta: { priority: 1 },
      },
      {
        id: "action",
        header: "Action",
        accessorFn: (i) => verbFor(i.action),
        meta: { priority: 1, csv: (i) => i.action },
      },
      {
        id: "target",
        header: "Target",
        accessorFn: (i) => i.target?.id ?? "",
        meta: { priority: 2 },
        cell: ({ row }) => <ActivityTarget slug={slug} item={row.original} />,
      },
      {
        id: "summary",
        header: "Summary",
        accessorKey: "summary",
        meta: { priority: 3 },
        cell: ({ row }) => (
          <span className="line-clamp-2 max-w-md">{row.original.summary}</span>
        ),
      },
    ],
    [slug],
  );
  return (
    <DataTable<ActivityItem>
      id="activity"
      caption="Activity"
      data={items}
      columns={columns}
      getRowId={(i) => i.id}
      pagination={{ mode: "cursor", onLoadMore, hasMore, loadingMore }}
      mobile="cards"
      exportCsv={false}
    />
  );
}
