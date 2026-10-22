/**
 * Platform → Operations (notes/S-13 §9.1, chunk 4P-3, T1): the instance's own account of its
 * background work, from `GET /manage/api/platform/operations` (A-14). Cron runs and their steps,
 * the consumer heartbeats, the delta queue and its dead-letter queue, D1 and R2 size, the required
 * indexes and the store connectors, each reduced to Healthy, Degraded or Failed with the brand
 * status tokens. The page refreshes itself on an interval the operator can pause.
 *
 * Nothing here is invented: every state is derived by `assessOperations` from the snapshot, so a
 * section the Worker could not read reads as degraded rather than as healthy.
 */

import {} from "../../../../lib/docsLinks.js";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type PlatformOperations } from "../../../../api.js";
import { formatBytes, formatCount } from "../../../../lib/format.js";
import { readPref, writePref } from "../../../storage.js";
import { StatTile } from "../../../../ui/charts/StatTile.js";
import {} from "../../../../lib/cn.js";
import {} from "../../../../ui/DescriptionList.js";
import {} from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import {} from "../../../../ui/StatusPill.js";
import {} from "../../../../ui/Timestamp.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { qk } from "../../../data/queries.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  PanelRow,
} from "../../../templates/Dashboard.js";
import {
  AUTO_REFRESH_KEY,
  HEALTH_PILL,
  HealthPill,
  OPERATIONS_REFRESH_MS,
  assessOperations,
} from "./platformOperationsAssess.js";
import {
  CronPanel,
  HeartbeatsPanel,
  QueuesPanel,
} from "./platformOperationsPanels.js";
import {
  ConnectorsPanel,
  ProbesPanel,
  RefusalsPanel,
  StoragePanel,
} from "./platformOperationsStatePanels.js";

function Skeleton({ className }: { className: string }): React.ReactElement {
  return <div aria-hidden className={`pk-skeleton rounded-md ${className}`} />;
}

export function fetchPlatformOperations(): Promise<PlatformOperations> {
  return api.platformOperations();
}

/**
 * Platform → Operations. Each figure comes from the one snapshot, so one query owns loading and
 * error; a section the snapshot marks unreadable degrades on its own.
 */
export function Operations(): React.ReactElement {
  const [auto, setAuto] = React.useState<boolean>(() =>
    readPref(
      AUTO_REFRESH_KEY,
      (raw) => (typeof raw === "boolean" ? raw : undefined),
      true,
    ),
  );
  const ops = useQuery({
    queryKey: qk.platformOperations(),
    queryFn: fetchPlatformOperations,
    // Pauses by itself while the tab is hidden (TanStack's default), and on the operator's switch.
    refetchInterval: auto ? OPERATIONS_REFRESH_MS : false,
    staleTime: 0,
  });
  const op = ops.data;
  const assessment = React.useMemo(
    () => (op ? assessOperations(op) : null),
    [op],
  );

  const onAuto = (next: boolean) => {
    setAuto(next);
    writePref(AUTO_REFRESH_KEY, next);
  };

  const header = (
    <PageHeader
      title="Operations"
      titleAside={
        assessment ? (
          <HealthPill health={assessment.overall} size="md" />
        ) : undefined
      }
      freshness={
        ops.dataUpdatedAt
          ? {
              updatedAt: ops.dataUpdatedAt,
              onRefresh: () => void ops.refetch(),
              refreshing: ops.isFetching,
              auto: {
                checked: auto,
                onCheckedChange: onAuto,
                label: `Refresh every ${OPERATIONS_REFRESH_MS / 1000} s`,
              },
            }
          : undefined
      }
    />
  );

  if (ops.isError && !op) {
    return (
      <DashboardTemplate
        header={header}
        firstRun={
          <ErrorState error={ops.error} onRetry={() => void ops.refetch()} />
        }
      />
    );
  }

  const loading = ops.isPending;
  const q = op?.queues;
  const queuesKnown = q?.deltas.bound && q.deltas.ok !== false;
  const dlqKnown = q?.deadLetter.bound && q.deadLetter.ok !== false;

  return (
    <DashboardTemplate
      header={header}
      attention={
        assessment ? <AttentionList items={assessment.attention} /> : null
      }
      tiles={
        <>
          <StatTile
            label="Health"
            loading={loading}
            value={
              assessment ? HEALTH_PILL[assessment.overall].label : undefined
            }
            secondary={
              assessment
                ? assessment.attention.length === 0
                  ? "Every check passed"
                  : `${formatCount(assessment.attention.length)} to look at`
                : undefined
            }
          />
          <StatTile
            label="Queue backlog"
            loading={loading}
            value={
              q
                ? queuesKnown
                  ? formatCount(q.deltas.backlogCount ?? 0)
                  : "Unknown"
                : undefined
            }
            secondary={
              q
                ? dlqKnown
                  ? `${formatCount(q.deadLetter.backlogCount ?? 0)} in the dead-letter queue`
                  : "Dead-letter queue unknown"
                : undefined
            }
          />
          <StatTile
            label="D1 size"
            loading={loading}
            value={
              op
                ? op.storage.d1.sizeBytes !== null
                  ? formatBytes(op.storage.d1.sizeBytes)
                  : "Not reported"
                : undefined
            }
          />
          <StatTile
            label="R2 committed"
            loading={loading}
            value={
              op
                ? op.storage.r2
                  ? formatBytes(op.storage.r2.committedBytes)
                  : "Not reported"
                : undefined
            }
            secondary={
              op?.storage.r2
                ? `${formatCount(op.storage.r2.objects)} objects`
                : undefined
            }
          />
        </>
      }
      primary={
        op ? (
          <CronPanel jobs={op.jobs} />
        ) : (
          <Panel title="Cron jobs">
            <Skeleton className="h-48" />
          </Panel>
        )
      }
      // The side's panels stack beside the cron card; the rest pair up below.
      side={
        op ? (
          // One block: Queues keeps its own height instead of growing to the cron card's.
          <div className="space-y-6">
            <HeartbeatsPanel op={op} />
            <QueuesPanel op={op} />
          </div>
        ) : (
          <Panel title="Heartbeats">
            <Skeleton className="h-48" />
          </Panel>
        )
      }
    >
      {op ? (
        <>
          <PanelRow>
            <ProbesPanel op={op} />
            <StoragePanel op={op} />
          </PanelRow>
          <ConnectorsPanel connectors={op.connectors} />
          <RefusalsPanel op={op} />
        </>
      ) : (
        <Panel title="Storage and indexes">
          <Skeleton className="h-32" />
        </Panel>
      )}
    </DashboardTemplate>
  );
}
