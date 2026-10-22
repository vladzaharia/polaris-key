/**
 * Platform → Status (admin.platform-status, ST-09): Deployment and Operations in one page. A
 * Check · Result · Next action table leads; health by area, queues, scheduled jobs, storage and
 * schema and deploys follow. The page refreshes itself and the operator can pause it; its one
 * freshness line is the older of its two reads.
 *
 * Nothing here is invented: every state comes from `GET /platform/deployment` and
 * `GET /platform/operations` (`assessOperations`, `deploymentAttention`), so a section the Worker
 * could not read says so instead of reading as healthy.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { EyeOff } from "lucide-react";
import { api, type PlatformDeploy } from "../../../../api.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { DashboardTemplate } from "../../../templates/Dashboard.js";
import { qk } from "../../../data/queries.js";
import { readPref, writePref } from "../../../storage.js";
import { r } from "../../../routes.js";
import {
  AUTO_REFRESH_KEY,
  OPERATIONS_REFRESH_MS,
  assessOperations,
} from "./platformOperationsAssess.js";
import { deploymentAttention, useMorePages } from "./platformDeployParts.js";
import {
  DeploysCard,
  HealthByArea,
  JobsCard,
  QueuesCard,
  StorageCard,
} from "./platformStatusParts.js";
import { ChecksTable, buildChecks } from "./platformStatusChecks.js";

export function PlatformStatus({
  after,
}: {
  /** Shown after the deploys (the platform activity, until it has its own page). */
  after?: React.ReactNode;
}): React.ReactElement {
  const [auto, setAuto] = React.useState<boolean>(() =>
    readPref(
      AUTO_REFRESH_KEY,
      (raw) => (typeof raw === "boolean" ? raw : undefined),
      true,
    ),
  );
  const poll = auto ? OPERATIONS_REFRESH_MS : false;
  const deployment = useQuery({
    queryKey: qk.platformDeployment(),
    queryFn: () => api.platformDeployment(),
    refetchInterval: poll,
  });
  const ops = useQuery({
    queryKey: qk.platformOperations(),
    queryFn: () => api.platformOperations(),
    // Pauses by itself while the tab is hidden (TanStack's default), and on the operator's switch.
    refetchInterval: poll,
    staleTime: 0,
  });
  const d = deployment.data;
  const op = ops.data;
  const deploys = useMorePages<PlatformDeploy>(
    (cursor) => api.platformDeployment(cursor).then((p) => p.deploys),
    d?.deploys,
  );
  const assessment = React.useMemo(
    () => (op ? assessOperations(op) : null),
    [op],
  );

  const refetchAll = () => {
    void deployment.refetch();
    void ops.refetch();
  };
  const onToggle = () => {
    setAuto(!auto);
    writePref(AUTO_REFRESH_KEY, !auto);
  };

  const stamps = [deployment.dataUpdatedAt, ops.dataUpdatedAt].filter(Boolean);
  const header = (
    <PageHeader
      title="Status"
      freshness={
        stamps.length > 0
          ? {
              updatedAt: Math.min(...stamps),
              verb: "Checked",
              onRefresh: refetchAll,
              refreshing: deployment.isFetching || ops.isFetching,
              pause: { paused: !auto, onToggle },
            }
          : undefined
      }
    />
  );

  if (deployment.isError && ops.isError && !d && !op) {
    return (
      <DashboardTemplate
        header={header}
        firstRun={<ErrorState error={deployment.error} onRetry={refetchAll} />}
      >
        {null}
      </DashboardTemplate>
    );
  }

  const checks = buildChecks({
    deployment: d,
    deploymentError: deployment.isError && !d,
    ops: op,
    opsError: ops.isError && !op,
    attention: [...(d ? deploymentAttention(d) : [])],
    opsAttention: assessment?.attention ?? [],
    stores: r.platformStores(),
    onRetry: refetchAll,
  });

  return (
    <DashboardTemplate header={header}>
      <ChecksTable
        checks={checks}
        loading={deployment.isPending || ops.isPending}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <HealthByArea
          assessment={assessment}
          error={ops.isError ? ops.error : null}
          onRetry={() => void ops.refetch()}
        />
        <JobsCard
          op={op}
          error={ops.isError ? ops.error : null}
          onRetry={() => void ops.refetch()}
        />
        <QueuesCard
          op={op}
          error={ops.isError ? ops.error : null}
          onRetry={() => void ops.refetch()}
        />
        <StorageCard
          op={op}
          deployment={d}
          error={deployment.isError && ops.isError ? ops.error : null}
          onRetry={refetchAll}
        />
      </div>
      <DeploysCard
        deployment={d}
        deploys={deploys}
        error={deployment.isError ? deployment.error : null}
        onRetry={() => void deployment.refetch()}
      />
      {after}
      <p className="flex items-center gap-2 text-xs text-fg-muted">
        <EyeOff aria-hidden className="size-3.5 shrink-0" />
        <span>Logs never show tokens, keys or emails.</span>
      </p>
    </DashboardTemplate>
  );
}
