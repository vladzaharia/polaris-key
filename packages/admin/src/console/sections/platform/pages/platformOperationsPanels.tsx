/**
 * Platform → Operations: the cron, heartbeat and queue panels. Split out of `platformOperations.tsx`.
 */

import {} from "../../../../lib/docsLinks.js";
import * as React from "react";
import {
  type OperationsJobRun,
  type OperationsQueue,
  type OperationsStepRun,
  type PlatformOperations,
} from "../../../../api.js";
import {
  formatBytes,
  formatCount,
  fromSeconds,
} from "../../../../lib/format.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type DataColumn,
  type TableState,
} from "../../../../ui/data-table/index.js";
import {} from "../../../../lib/cn.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import {
  CRON_HELP,
  SCRIPT_LABEL,
  formatMs,
  heartbeatState,
  jobLabel,
  queueHealth,
  HealthPill,
} from "./platformOperationsAssess.js";
import { Panel } from "../../../templates/Dashboard.js";

export function Unavailable({ what }: { what: string }): React.ReactElement {
  return (
    <p className="flex items-center gap-2 text-sm text-fg">
      <HealthPill health="degraded">Unavailable</HealthPill>
      {what} could not be read.
    </p>
  );
}

export const ms = (seconds: number) => fromSeconds(seconds);

export const STEP_COLUMNS: DataColumn<OperationsStepRun>[] = [
  {
    id: "step",
    header: "Step",
    accessorKey: "step",
    meta: { priority: 1, primary: true, mono: true },
  },
  {
    id: "startedAt",
    header: "Last run",
    accessorKey: "startedAt",
    meta: { numeric: true, priority: 2 },
    cell: ({ row }) => <Timestamp at={row.original.startedAt} />,
  },
  {
    id: "duration",
    header: "Duration",
    accessorFn: (r) => r.durationMs ?? -1,
    meta: {
      numeric: true,
      priority: 2,
      csv: (r) => String(r.durationMs ?? ""),
    },
    cell: ({ row }) => formatMs(row.original.durationMs),
  },
  {
    id: "outcome",
    header: "Outcome",
    accessorKey: "outcome",
    meta: { priority: 1 },
    cell: ({ row }) => (
      <HealthPill health={row.original.outcome === "ok" ? "healthy" : "failed"}>
        {row.original.outcome === "ok" ? "Succeeded" : "Failed"}
      </HealthPill>
    ),
  },
  {
    id: "error",
    header: "Error summary",
    accessorFn: (r) => r.error ?? "",
    enableSorting: false,
    meta: { priority: 3 },
    cell: ({ row }) =>
      row.original.error ? (
        <span className="break-words text-fg">{row.original.error}</span>
      ) : (
        <span className="text-fg-muted">—</span>
      ),
  },
];

export type RecentRun = NonNullable<
  PlatformOperations["jobs"]
>["recent"][number];

export const RECENT_COLUMNS: DataColumn<RecentRun>[] = [
  {
    id: "job",
    header: "Job",
    accessorFn: (r) => jobLabel(r.job),
    meta: { priority: 1, primary: true },
  },
  {
    id: "startedAt",
    header: "Started",
    accessorKey: "startedAt",
    meta: { numeric: true, priority: 1 },
    cell: ({ row }) => <Timestamp at={row.original.startedAt} />,
  },
  {
    id: "duration",
    header: "Duration",
    accessorFn: (r) => r.durationMs ?? -1,
    meta: {
      numeric: true,
      priority: 2,
      csv: (r) => String(r.durationMs ?? ""),
    },
    cell: ({ row }) => formatMs(row.original.durationMs),
  },
  {
    id: "steps",
    header: "Steps",
    accessorKey: "steps",
    meta: { priority: 3, align: "end" },
    cell: ({ row }) => formatCount(row.original.steps),
  },
  {
    id: "outcome",
    header: "Outcome",
    accessorKey: "outcome",
    meta: { priority: 1 },
    cell: ({ row }) => (
      <HealthPill health={row.original.outcome === "ok" ? "healthy" : "failed"}>
        {row.original.outcome === "ok" ? "Succeeded" : "Failed"}
      </HealthPill>
    ),
  },
];

export function JobBlock({
  job,
  run,
}: {
  job: string;
  run: OperationsJobRun | null;
}): React.ReactElement {
  const [state, setState] = React.useState<TableState>(EMPTY_TABLE_STATE);
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={id} className="text-sm font-semibold text-fg-strong">
          {jobLabel(job)}
        </h3>
        {run ? (
          <HealthPill health={run.outcome === "ok" ? "healthy" : "failed"}>
            {run.outcome === "ok" ? "Last run succeeded" : "Last run failed"}
          </HealthPill>
        ) : null}
        {run?.cron ? (
          <span className="text-xs text-fg-muted">
            {CRON_HELP[run.cron] ?? run.cron}
          </span>
        ) : null}
      </div>
      {run ? (
        <>
          <p className="text-sm text-fg-muted">
            Ran <Timestamp at={run.startedAt} format="relative" /> and took{" "}
            {formatMs(run.durationMs)}.
          </p>
          <DataTable<OperationsStepRun>
            id={`ops-steps-${job}`}
            caption={`${jobLabel(job)}: steps of the latest run`}
            data={run.steps}
            columns={STEP_COLUMNS}
            getRowId={(row) => row.step}
            rowLabel={(row) => row.step}
            state={state}
            onStateChange={setState}
            empty={
              <EmptyState
                kind="first-run"
                variant="inline"
                title="No steps recorded"
                description="The run recorded a summary and no individual steps."
              />
            }
            mobile="cards"
          />
        </>
      ) : (
        <p className="text-sm text-fg-muted">No run recorded yet.</p>
      )}
    </section>
  );
}

export function CronPanel({ jobs }: { jobs: PlatformOperations["jobs"] }) {
  const [recentState, setRecentState] =
    React.useState<TableState>(EMPTY_TABLE_STATE);
  return (
    <Panel title="Cron jobs">
      {jobs === null ? (
        <Unavailable what="The run history" />
      ) : (
        <div className="space-y-6">
          <JobBlock job="maintenance" run={jobs.latest.maintenance} />
          <JobBlock job="connectorPoll" run={jobs.latest.connectorPoll} />
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-fg-strong">
              Recent runs
            </h3>
            <DataTable<RecentRun>
              id="ops-recent-runs"
              caption="Recent cron runs"
              data={jobs.recent}
              columns={RECENT_COLUMNS}
              getRowId={(row) => row.runId}
              rowLabel={(row) => `${jobLabel(row.job)} run`}
              state={recentState}
              onStateChange={setRecentState}
              empty={
                <EmptyState
                  kind="first-run"
                  variant="inline"
                  title="No runs recorded"
                  description="Each cron tick's steps are kept for 30 days."
                />
              }
              mobile="cards"
            />
          </section>
          {jobs.failures.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-fg-strong">
                Recent failed steps
              </h3>
              <ul className="divide-y divide-border rounded-md border border-border">
                {jobs.failures.map((f) => (
                  <li
                    key={`${f.runId}:${f.step}`}
                    className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-baseline sm:gap-3"
                  >
                    <span className="shrink-0 font-mono text-xs text-fg-strong">
                      {f.step}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-fg">
                      {f.error ?? "No message recorded"}
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">
                      {jobLabel(f.job)},{" "}
                      <Timestamp at={f.startedAt} format="relative" />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

export function HeartbeatsPanel({ op }: { op: PlatformOperations }) {
  const backlog = op.queues.deltas.bound ? op.queues.deltas.backlogCount : null;
  return (
    <Panel title="Heartbeats">
      {op.heartbeats === null ? (
        <Unavailable what="The heartbeat rows" />
      ) : (
        <ul className="space-y-4">
          {["main", "deltas"].map((script) => {
            const beat = op.heartbeats!.find((h) => h.script === script);
            const state = heartbeatState(
              beat,
              script,
              op.generatedAt,
              script === "deltas"
                ? (backlog ?? beat?.backlogCount ?? null)
                : null,
            );
            return (
              <li key={script} className="space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium text-fg-strong">
                    {SCRIPT_LABEL[script]}
                  </span>
                  <span className="shrink-0">
                    <HealthPill health={state.health}>{state.label}</HealthPill>
                  </span>
                </div>
                {beat ? (
                  <DescriptionList
                    items={[
                      {
                        term: "Last reported",
                        detail: <Timestamp at={ms(beat.at)} format="detail" />,
                      },
                      {
                        term: "Last outcome",
                        detail: (
                          <span className="break-words font-mono text-xs">
                            {beat.outcome ?? "—"}
                          </span>
                        ),
                      },
                      {
                        term: "Version",
                        detail: (
                          <span className="font-mono text-xs">
                            {beat.versionTag ?? "Untagged"}
                          </span>
                        ),
                      },
                    ]}
                  />
                ) : (
                  <p className="text-sm text-fg-muted">
                    {script === "deltas"
                      ? "The consumer has not processed a batch yet."
                      : "The cron has not ticked yet."}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function QueueBlock({
  title,
  q,
  dead,
}: {
  title: string;
  q: OperationsQueue;
  dead: boolean;
}): React.ReactElement {
  const h = queueHealth(q, dead);
  return (
    <li className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 text-sm font-medium text-fg-strong">
          {title}
        </span>
        {h ? (
          <HealthPill health={h}>
            {h === "healthy"
              ? q.backlogCount
                ? "Draining"
                : "Empty"
              : q.ok === false
                ? "Unreadable"
                : "Messages waiting"}
          </HealthPill>
        ) : (
          <StatusPill tone="neutral" size="sm">
            Not bound
          </StatusPill>
        )}
      </div>
      {q.bound ? (
        q.ok === false ? (
          <p className="text-sm text-fg-muted">
            {q.error ?? "Its backlog could not be read."}
          </p>
        ) : (
          <p className="text-sm tabular-nums text-fg">
            {formatCount(q.backlogCount ?? 0)}{" "}
            {(q.backlogCount ?? 0) === 1 ? "message" : "messages"} ·{" "}
            {formatBytes(q.backlogBytes ?? 0)} ·{" "}
            {q.oldestMessageAt !== null ? (
              <>
                oldest{" "}
                <Timestamp at={ms(q.oldestMessageAt)} format="relative" />
              </>
            ) : (
              <span className="text-fg-muted">none waiting</span>
            )}
          </p>
        )
      ) : null}
    </li>
  );
}

export function QueuesPanel({ op }: { op: PlatformOperations }) {
  const c = op.queues.consumer;
  return (
    <Panel title="Queues">
      <ul className="space-y-4">
        <QueueBlock title="Delta queue" q={op.queues.deltas} dead={false} />
        <QueueBlock title="Dead-letter queue" q={op.queues.deadLetter} dead />
      </ul>
      <p className="mt-4 text-xs text-fg-muted">
        The consumer takes {formatCount(c.maxBatchSize)} message per batch with
        up to {formatCount(c.maxRetries)} retries, then moves it to the
        dead-letter queue.
      </p>
    </Panel>
  );
}
