/**
 * The Platform section's pages (notes/S-13 §9.1): instance-wide, product-less. One lazy chunk.
 * Deployment is built here; Settings, Operations, Store connections, Connections (I-31), Package
 * feeds and Override migration live in `pages/` and `../feeds/`.
 */

import { docsUrl } from "../../../lib/docsLinks.js";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type PlatformDeploy,
  type PlatformDeployment,
} from "../../../api.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type TableState,
} from "../../../ui/data-table/index.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Hash } from "../../../ui/Hash.js";
import { IdChip } from "../../../ui/IdChip.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { ActivityPanel, MigrationsPanel } from "./pages/platformDbActivity.js";
import {
  DEPLOY_COLUMNS,
  buildLabel,
  deploymentAttention,
  useMorePages,
} from "./pages/platformDeployParts.js";
import { PlatformSettingsPage } from "./pages/platformSettings.js";
import { qk } from "../../data/queries.js";
import { StoreConnections } from "./pages/platformStores.js";
import { ConnectionsRoute } from "./pages/platformConnections.js";
import type { GlobalPageId } from "../../nav.js";
import type { Route } from "../../routes.js";
import { FeedsArea } from "../feeds/pages/FeedsArea.js";
import { PLATFORM_SCOPE } from "../feeds/model/model.js";
import { Operations } from "./pages/platformOperations.js";
import { OverrideMigrationPage } from "./pages/platformOverrideMigration.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
} from "../../templates/Dashboard.js";

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
  if (page === "platform-connections")
    return <ConnectionsRoute id={route?.id} />;
  if (page === "platform-override-migration") return <OverrideMigrationPage />;
  return null;
}

/**
 * Platform → Deployment (notes/S-13 §9.1, T1 plus tables): the build this instance runs, the
 * deploy history the workflow records, D1 migrations applied against the build's newest, the
 * required indexes and the bindings (presence only), and the platform activity log.
 */
export function Deployment(): React.ReactElement {
  const deployment = useQuery({
    queryKey: qk.platformDeployment(),
    queryFn: fetchPlatformDeployment,
  });
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
                  className="flex items-center justify-between gap-2 text-sm [&>span:first-child]:min-w-0 [&>span:first-child]:break-all"
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
              docs={docsUrl("deployPage")}
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
