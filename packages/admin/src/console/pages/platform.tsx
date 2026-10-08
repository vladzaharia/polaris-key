/**
 * The Platform section's pages (notes/S-13 §9.1): instance-wide, product-less. One lazy chunk,
 * loaded when the operator opens the section. Deployment is built here (A-11's identity and deploy
 * history, A-12's platform activity), Settings in `platformSettings.tsx` (4P-1, on A-13),
 * Operations in `platformOperations.tsx` (4P-3, on A-14) and Store connections in
 * `platformStores.tsx` (A-16), Package feeds in `../areas/feeds/` (F-11, shared with the
 * product scope) and Override migration in `platformOverrideMigration.tsx` (U-03).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  api,
  type PlatformActivityItem,
  type PlatformCursor,
  type PlatformDeploy,
  type PlatformDeployment,
} from "../../api.js";
import { formatCount, fromSeconds } from "../../lib/format.js";
import { ENVIRONMENT_LABELS, label } from "../../lib/labels.js";
import { Button } from "../../ui/Button.js";
import { StatTile } from "../../ui/charts/StatTile.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type DataColumn,
  type TableState,
} from "../../ui/data-table/index.js";
import { DescriptionList } from "../../ui/DescriptionList.js";
import { EmptyState } from "../../ui/EmptyState.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { Hash } from "../../ui/Hash.js";
import { IdChip } from "../../ui/IdChip.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Timeline, TimelineItem } from "../../ui/Timeline.js";
import { Timestamp } from "../../ui/Timestamp.js";
import { PageHeader } from "../components/PageHeader.js";
import { PlatformSettingsPage } from "./platformSettings.js";
import { qk } from "../data/queries.js";
import { StoreConnections } from "./platformStores.js";
import { queryClient } from "../data/queryClient.js";
import type { GlobalPageId } from "../nav.js";
import type { Route } from "../routes.js";
import { FeedsArea } from "../areas/feeds/FeedsArea.js";
import { PLATFORM_SCOPE } from "../areas/feeds/model.js";
import { Operations } from "./platformOperations.js";
import { OverrideMigrationPage } from "./platformOverrideMigration.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  type AttentionItem,
} from "../templates/Dashboard.js";

export function fetchPlatformDeployment(): Promise<PlatformDeployment> {
  return api.platformDeployment();
}

export function fetchPlatformActivity() {
  return api.platformActivity();
}

/** The section's page for a route. A page that is not built redirects before here. */
export default function PlatformPages({
  page,
  route,
}: {
  page: GlobalPageId;
  route?: Extract<Route, { kind: "global" }>;
}): React.ReactElement | null {
  if (page === "platform-feeds")
    return (
      <FeedsArea
        scope={PLATFORM_SCOPE}
        eco={route?.id}
        tab={route?.tab}
        child={route?.child}
      />
    );
  if (page === "platform-deployment") return <Deployment />;
  if (page === "platform-settings") return <PlatformSettingsPage />;
  if (page === "platform-operations") return <Operations />;
  if (page === "platform-stores") return <StoreConnections />;
  if (page === "platform-override-migration") return <OverrideMigrationPage />;
  return null;
}

/** "v0.8.6", else the short commit, else "Development build". */
export function buildLabel(identity: {
  releaseTag: string | null;
  gitSha: string | null;
}): string {
  if (identity.releaseTag) return identity.releaseTag;
  if (identity.gitSha) return identity.gitSha.slice(0, 7);
  return "Development build";
}

/** What the Deployment page flags: migrations behind, missing indexes, absent bindings, a failed smoke check. */
export function deploymentAttention(d: PlatformDeployment): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (d.migrations.upToDate === false) {
    items.push({
      id: "migrations",
      tone: "danger",
      object: "D1 migrations",
      reason: `The database has not applied ${d.migrations.latest}, the newest migration this build ships. Routes that need it fail until it is applied.`,
    });
  }
  if (d.indexes.missing && d.indexes.missing.length > 0) {
    items.push({
      id: "indexes",
      tone: "warning",
      object: "Required indexes",
      reason: `${formatCount(d.indexes.missing.length)} missing: ${d.indexes.missing.join(", ")}.`,
    });
  }
  const absent = Object.entries(d.bindings)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (absent.length > 0) {
    items.push({
      id: "bindings",
      tone: "warning",
      object: "Bindings",
      reason: `Not bound: ${absent.join(", ")}.`,
    });
  }
  const last = d.deploys.items[0];
  if (last && last.smoke === "failure") {
    items.push({
      id: "smoke",
      tone: "danger",
      object: buildLabel({ releaseTag: last.tag, gitSha: last.gitSha }),
      reason:
        "The last deploy's smoke check failed after the Worker went live.",
      action: last.runUrl
        ? { label: "View run", href: last.runUrl }
        : undefined,
      at: last.at,
    });
  }
  return items;
}

const SMOKE: Record<
  string,
  { tone: "success" | "danger" | "neutral"; label: string }
> = {
  success: { tone: "success", label: "Passed" },
  failure: { tone: "danger", label: "Failed" },
  skipped: { tone: "neutral", label: "Skipped" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

const DEPLOY_COLUMNS: DataColumn<PlatformDeploy>[] = [
  {
    id: "tag",
    header: "Release",
    accessorFn: (d) => d.tag ?? "",
    meta: { priority: 1, primary: true, mono: true },
    cell: ({ row }) => row.original.tag ?? "Untagged",
  },
  {
    id: "at",
    header: "Deployed",
    accessorKey: "at",
    meta: { numeric: true, priority: 1 },
    cell: ({ row }) => <Timestamp at={fromSeconds(row.original.at)} />,
  },
  {
    id: "commit",
    header: "Commit",
    accessorFn: (d) => d.gitSha ?? "",
    enableSorting: false,
    meta: { priority: 2 },
    cell: ({ row }) =>
      row.original.gitSha ? (
        <Hash
          value={row.original.gitSha}
          label="commit"
          chars={7}
          className="whitespace-nowrap"
        />
      ) : (
        "—"
      ),
  },
  {
    id: "environment",
    header: "Environment",
    accessorFn: (d) => d.environment ?? "",
    meta: { priority: 2 },
    cell: ({ row }) => label(ENVIRONMENT_LABELS, row.original.environment),
  },
  {
    id: "smoke",
    header: "Smoke check",
    accessorFn: (d) => d.smoke ?? "",
    meta: { priority: 1 },
    cell: ({ row }) => {
      const s = SMOKE[row.original.smoke ?? ""];
      return s ? (
        <StatusPill tone={s.tone} size="sm">
          {s.label}
        </StatusPill>
      ) : (
        <span className="text-fg-muted">Not recorded</span>
      );
    },
  },
  {
    id: "scripts",
    header: "Scripts",
    accessorFn: (d) => d.scripts.join(", "),
    enableSorting: false,
    meta: { priority: 3, mono: true },
  },
  {
    id: "migration",
    header: "Newest migration",
    accessorFn: (d) => d.latestMigration ?? "",
    meta: { priority: 3, mono: true },
  },
  {
    id: "run",
    header: "Run",
    enableSorting: false,
    meta: { priority: 2, label: "Run", csv: (d) => d.runUrl ?? "" },
    cell: ({ row }) =>
      row.original.runUrl ? (
        <a
          href={row.original.runUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 whitespace-nowrap text-accent-fg underline-offset-4 hover:underline"
        >
          View run
          <ExternalLink aria-hidden className="size-3.5" />
          <span className="sr-only">(opens GitHub Actions)</span>
        </a>
      ) : (
        "—"
      ),
  },
];

/** One more page of a keyset list, appended under the first (which the query owns). */
function useMorePages<T>(
  fetchPage: (cursor: PlatformCursor) => Promise<{
    items: T[];
    nextCursor: PlatformCursor | null;
  }>,
  first: { items: T[]; nextCursor: PlatformCursor | null } | undefined,
): {
  items: T[];
  hasMore: boolean;
  loading: boolean;
  error: unknown;
  loadMore: () => void;
} {
  const [extra, setExtra] = React.useState<{
    items: T[];
    nextCursor: PlatformCursor | null;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  // A refetch of the first page starts the list over.
  React.useEffect(() => {
    setExtra(null);
    setError(null);
  }, [first]);
  const cursor = extra ? extra.nextCursor : (first?.nextCursor ?? null);
  const loadMore = () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    fetchPage(cursor)
      .then((page) =>
        setExtra((prev) => ({
          items: [...(prev?.items ?? []), ...page.items],
          nextCursor: page.nextCursor,
        })),
      )
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  };
  return {
    items: [...(first?.items ?? []), ...(extra?.items ?? [])],
    hasMore: cursor !== null,
    loading,
    error,
    loadMore,
  };
}

/**
 * Platform → Deployment (notes/S-13 §9.1, T1 plus tables): the build this instance runs, the
 * deploy history the workflow records, D1 migrations applied against the build's newest, the
 * required indexes and the bindings (presence only), and the platform activity log.
 */
export function Deployment(): React.ReactElement {
  const deployment = useQuery(
    {
      queryKey: qk.platformDeployment(),
      queryFn: fetchPlatformDeployment,
    },
    queryClient,
  );
  const d = deployment.data;
  const deploys = useMorePages<PlatformDeploy>(
    (cursor) => api.platformDeployment(cursor).then((r) => r.deploys),
    d?.deploys,
  );
  const [tableState, setTableState] =
    React.useState<TableState>(EMPTY_TABLE_STATE);

  const header = (
    <PageHeader
      title="Deployment"
      freshness={
        deployment.dataUpdatedAt
          ? {
              updatedAt: deployment.dataUpdatedAt,
              onRefresh: () => void deployment.refetch(),
              refreshing: deployment.isFetching,
            }
          : undefined
      }
    />
  );

  if (deployment.isError && !d) {
    return (
      <DashboardTemplate
        header={header}
        firstRun={
          <ErrorState
            error={deployment.error}
            onRetry={() => void deployment.refetch()}
          />
        }
      >
        <ActivityPanel />
      </DashboardTemplate>
    );
  }

  const loading = deployment.isPending;
  const bindings = d ? Object.entries(d.bindings) : [];
  const present = bindings.filter(([, v]) => v).length;
  const migrationState =
    d?.migrations.upToDate === true
      ? "Up to date"
      : d?.migrations.upToDate === false
        ? "Behind"
        : "Unknown";

  return (
    <DashboardTemplate
      header={header}
      attention={d ? <AttentionList items={deploymentAttention(d)} /> : null}
      tiles={
        <>
          <StatTile
            label="Release"
            loading={loading}
            value={d ? buildLabel(d.current) : undefined}
          />
          <StatTile
            label="D1 migrations"
            loading={loading}
            value={migrationState}
            secondary={
              d?.migrations.upToDate === null
                ? "The migration table could not be read."
                : undefined
            }
          />
          <StatTile
            label="Bindings"
            loading={loading}
            value={d ? `${present} of ${bindings.length}` : undefined}
          />
        </>
      }
      primary={
        <Panel title="Current build">
          {d ? (
            <DescriptionList
              columns={2}
              items={[
                {
                  term: "Release tag",
                  detail: d.current.releaseTag ? (
                    <span className="font-mono">{d.current.releaseTag}</span>
                  ) : (
                    "Untagged (a hand deploy or wrangler dev)"
                  ),
                },
                {
                  term: "Commit",
                  detail: d.current.gitSha ? (
                    <Hash value={d.current.gitSha} label="commit" chars={7} />
                  ) : (
                    "Not recorded"
                  ),
                },
                {
                  term: "Cloudflare version",
                  detail: d.current.cloudflare ? (
                    <IdChip
                      value={d.current.cloudflare.id}
                      noun="Cloudflare version id"
                    />
                  ) : (
                    "Not reported (no version metadata binding)"
                  ),
                },
                {
                  term: "Uploaded",
                  detail:
                    d.current.cloudflare?.uploadedAt &&
                    !Number.isNaN(
                      Date.parse(d.current.cloudflare.uploadedAt),
                    ) ? (
                      <Timestamp
                        at={Date.parse(d.current.cloudflare.uploadedAt)}
                        format="detail"
                      />
                    ) : (
                      "Not reported"
                    ),
                },
                {
                  term: "Protocol version",
                  detail: (
                    <span className="font-mono">
                      {d.current.protocolVersion}
                    </span>
                  ),
                },
                {
                  term: "Discovery document",
                  detail: (
                    <span className="font-mono">
                      v{d.current.discoveryVersion}
                    </span>
                  ),
                },
              ]}
            />
          ) : (
            <div aria-hidden className="pk-skeleton-group space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4"
                >
                  <div className="pk-skeleton h-5 rounded-md" />
                  <div className="pk-skeleton h-5 w-2/3 rounded-md" />
                </div>
              ))}
            </div>
          )}
        </Panel>
      }
      side={
        <Panel title="Worker bindings">
          {d ? (
            <ul className="space-y-2">
              {bindings.map(([name, ok]) => (
                <li
                  key={name}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="font-mono text-xs text-fg">{name}</span>
                  <StatusPill tone={ok ? "success" : "warning"} size="sm">
                    {ok ? "Bound" : "Not bound"}
                  </StatusPill>
                </li>
              ))}
            </ul>
          ) : (
            <ul aria-hidden className="pk-skeleton-group space-y-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="pk-skeleton h-4 w-28 rounded-md" />
                  <span className="pk-skeleton h-5 w-16 rounded-full" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      }
    >
      <Panel title="Deploy history">
        <DataTable<PlatformDeploy>
          id="platform-deploys"
          caption="Deploy history"
          data={deploys.items}
          columns={DEPLOY_COLUMNS}
          getRowId={(row) => row.id}
          rowLabel={(row) =>
            buildLabel({ releaseTag: row.tag, gitSha: row.gitSha })
          }
          state={tableState}
          onStateChange={setTableState}
          loading={loading}
          pagination={{
            mode: "cursor",
            hasMore: deploys.hasMore,
            loadingMore: deploys.loading,
            onLoadMore: deploys.loadMore,
          }}
          empty={
            <EmptyState
              kind="first-run"
              variant="inline"
              title="No deploys recorded"
              description="The deploy workflow records each production deploy. A hand deploy or wrangler dev records none."
              docs="/docs/admin/deploy/"
            />
          }
          mobile="cards"
        />
        {deploys.error ? (
          <ErrorState
            compact
            error={deploys.error}
            onRetry={deploys.loadMore}
          />
        ) : null}
      </Panel>
      {/* Full width, one after the other: a short migrations card beside the long activity
          timeline left a column of empty card running down the page. */}
      <MigrationsPanel deployment={d} loading={loading} />
      <ActivityPanel />
    </DashboardTemplate>
  );
}

function MigrationsPanel({
  deployment: d,
  loading,
}: {
  deployment: PlatformDeployment | undefined;
  loading: boolean;
}): React.ReactElement {
  const [all, setAll] = React.useState(false);
  const applied = d?.migrations.applied ?? null;
  const newestFirst = applied ? [...applied].reverse() : [];
  const shown = all ? newestFirst : newestFirst.slice(0, 8);
  return (
    <Panel title="Database">
      {loading || !d ? (
        <div aria-hidden className="pk-skeleton-group space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4">
              <div className="pk-skeleton h-4 rounded-md" />
              <div className="pk-skeleton h-4 w-1/2 rounded-md" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <DescriptionList
            items={[
              {
                term: "Newest in this build",
                detail: (
                  <span className="break-all font-mono text-xs">
                    {d.migrations.latest}
                  </span>
                ),
              },
              {
                term: "Required indexes",
                detail:
                  d.indexes.missing === null
                    ? "Could not be checked"
                    : d.indexes.missing.length === 0
                      ? "All present"
                      : d.indexes.missing.join(", "),
              },
            ]}
          />
          {applied && applied.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-fg-strong">
                Applied ({formatCount(applied.length)})
              </h3>
              <ol className="space-y-1">
                {shown.map((m) => (
                  <li
                    key={m.name}
                    className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs"
                  >
                    <span className="break-all font-mono text-fg">
                      {m.name}
                    </span>
                    {m.appliedAt ? (
                      <span className="text-fg-muted">{m.appliedAt}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
              {newestFirst.length > 8 ? (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setAll((v) => !v)}
                >
                  {all ? "Show fewer" : `Show all ${newestFirst.length}`}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** The verb phrase of a platform action; an action without one reads as its code. */
const ACTION_VERBS: Record<string, string> = {
  "kek.reseal": "re-sealed values under KEK",
  "platform.setting.set": "changed platform setting",
  "platform.setting.revert": "reverted platform setting",
  "feed.bootstrap": "set up the platform's package feeds",
  "feed.policy.update": "changed the platform policy of feed",
  // LX-08: the deploy hook's licensing catch-up pass.
  "licensing.catch_up": "ran the licensing catch-up",
};

/**
 * Platform activity (A-12): `platform_audit`, the admin actions that belong to no product (a KEK
 * re-seal sweep, a platform settings write). Newest first, with Load more.
 */
export function ActivityPanel(): React.ReactElement {
  const activity = useQuery(
    { queryKey: qk.platformActivity(), queryFn: fetchPlatformActivity },
    queryClient,
  );
  const more = useMorePages<PlatformActivityItem>(
    (cursor) => api.platformActivity(cursor),
    activity.data,
  );
  return (
    <Panel title="Platform activity">
      {activity.isPending ? (
        <div aria-hidden className="pk-skeleton-group space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="pk-skeleton size-6 shrink-0 rounded-full" />
              <div className="pk-skeleton h-4 flex-1 rounded-md" />
              <div className="pk-skeleton h-3 w-16 rounded-md" />
            </div>
          ))}
        </div>
      ) : activity.isError && !activity.data ? (
        <ErrorState
          compact
          error={activity.error}
          onRetry={() => void activity.refetch()}
        />
      ) : more.items.length === 0 ? (
        <EmptyState
          kind="first-run"
          variant="inline"
          title="No platform activity yet"
          description="Actions on the instance as a whole, such as a KEK re-seal sweep, are recorded here with who ran them."
        />
      ) : (
        <>
          <Timeline<PlatformActivityItem>
            label="Platform activity"
            items={more.items}
            getKey={(a) => a.id}
            getTime={(a) => fromSeconds(a.at)}
            loadMore={{
              onLoadMore: more.loadMore,
              hasMore: more.hasMore,
              loading: more.loading,
            }}
            renderItem={(a) => (
              <TimelineItem
                actor={
                  a.actor.name || a.actor.email
                    ? { name: a.actor.name || a.actor.email }
                    : "system"
                }
                verb={ACTION_VERBS[a.action] ?? a.action}
                target={
                  a.target ? (
                    <span className="font-mono text-xs">{a.target.id}</span>
                  ) : undefined
                }
                at={fromSeconds(a.at)}
                summary={a.summary || undefined}
              />
            )}
          />
          {more.error ? (
            <ErrorState compact error={more.error} onRetry={more.loadMore} />
          ) : null}
        </>
      )}
    </Panel>
  );
}
