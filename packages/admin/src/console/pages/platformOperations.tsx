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

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type OperationsConnector,
  type OperationsHeartbeat,
  type OperationsJobRun,
  type OperationsProbe,
  type OperationsQueue,
  type OperationsStepRun,
  type PlatformOperations,
} from "../../api.js";
import {
  formatBytes,
  formatCount,
  formatNumber,
  fromSeconds,
} from "../../lib/format.js";
import { readPref, writePref } from "../storage.js";
import { StatTile } from "../../ui/charts/StatTile.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type DataColumn,
  type TableState,
} from "../../ui/data-table/index.js";
import { cn } from "../../lib/cn.js";
import { DescriptionList } from "../../ui/DescriptionList.js";
import { EmptyState } from "../../ui/EmptyState.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Timestamp } from "../../ui/Timestamp.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { qk } from "../data/queries.js";
import { queryClient } from "../data/queryClient.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  PanelRow,
  type AttentionItem,
} from "../templates/Dashboard.js";

/** How often the page refetches while it is visible and auto-refresh is on. */
export const OPERATIONS_REFRESH_MS = 30_000;
/** The cron fires every 15 minutes: three missed ticks is stale, eight (two hours) is silent. */
export const MAIN_STALE_SECONDS = 45 * 60;
export const MAIN_SILENT_SECONDS = 2 * 60 * 60;
/** A consumer that has not reported for this long while messages wait is stale; an hour, stalled. */
export const CONSUMER_STALE_SECONDS = 10 * 60;
export const CONSUMER_STALLED_SECONDS = 60 * 60;

const AUTO_REFRESH_KEY = "pk-admin-operations-auto-refresh";

export type Health = "healthy" | "degraded" | "failed";

const HEALTH_PILL: Record<
  Health,
  { tone: "success" | "warning" | "danger"; label: string }
> = {
  healthy: { tone: "success", label: "Healthy" },
  degraded: { tone: "warning", label: "Degraded" },
  failed: { tone: "danger", label: "Failed" },
};

export function HealthPill({
  health,
  children,
  size = "sm",
}: {
  health: Health;
  children?: React.ReactNode;
  size?: "sm" | "md";
}): React.ReactElement {
  const p = HEALTH_PILL[health];
  return (
    <StatusPill tone={p.tone} size={size}>
      {children ?? p.label}
    </StatusPill>
  );
}

const worst = (a: Health, b: Health): Health =>
  a === "failed" || b === "failed"
    ? "failed"
    : a === "degraded" || b === "degraded"
      ? "degraded"
      : "healthy";

/** "850 ms", "2.4 s", "3 min 5 s". */
export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${formatCount(Math.round(ms))} ms`;
  if (ms < 60_000) return `${formatNumber(ms / 1000, 1)} s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${min} min` : `${min} min ${s} s`;
}

const JOB_LABEL: Record<string, string> = {
  maintenance: "Nightly maintenance",
  connectorPoll: "Connector poll",
};
const jobLabel = (job: string): string => JOB_LABEL[job] ?? job;

const CRON_HELP: Record<string, string> = {
  "17 3 * * *": "Daily at 03:17 UTC",
  "*/15 * * * *": "Every 15 minutes",
};

const SCRIPT_LABEL: Record<string, string> = {
  main: "Main Worker (cron)",
  deltas: "Lazy-delta consumer",
};

export interface HeartbeatState {
  health: Health;
  label: string;
}

/** Is a script's heartbeat fresh? `backlog` is the messages waiting for the consumer, when known. */
export function heartbeatState(
  beat: OperationsHeartbeat | undefined,
  script: string,
  now: number,
  backlog: number | null,
): HeartbeatState {
  if (script === "deltas") {
    const waiting = (backlog ?? 0) > 0;
    if (!waiting) {
      return beat
        ? { health: "healthy", label: "Idle" }
        : { health: "healthy", label: "Idle, nothing processed yet" };
    }
    const age = beat ? now - beat.at : Infinity;
    if (age > CONSUMER_STALLED_SECONDS)
      return { health: "failed", label: "Stalled" };
    if (age > CONSUMER_STALE_SECONDS)
      return { health: "degraded", label: "Stale" };
    return { health: "healthy", label: "Processing" };
  }
  if (!beat) return { health: "degraded", label: "No tick recorded" };
  const age = now - beat.at;
  if (age > MAIN_SILENT_SECONDS) return { health: "failed", label: "Silent" };
  if (age > MAIN_STALE_SECONDS) return { health: "degraded", label: "Stale" };
  return { health: "healthy", label: "Ticking" };
}

function probeHealth(p: OperationsProbe): Health | null {
  if (!p.bound) return null;
  return p.ok === false ? "failed" : "healthy";
}

export function queueHealth(q: OperationsQueue, dead: boolean): Health | null {
  if (!q.bound) return null;
  if (q.ok === false) return "degraded";
  if (dead && (q.backlogCount ?? 0) > 0) return "degraded";
  return "healthy";
}

export interface OperationsAssessment {
  overall: Health;
  attention: AttentionItem[];
  sections: {
    probes: Health;
    cron: Health;
    consumers: Health;
    queues: Health;
    storage: Health;
    connectors: Health;
  };
}

/** Reduce a snapshot to one state per section, one overall state, and the attention list. */
export function assessOperations(op: PlatformOperations): OperationsAssessment {
  const items: AttentionItem[] = [];
  const sections: OperationsAssessment["sections"] = {
    probes: "healthy",
    cron: "healthy",
    consumers: "healthy",
    queues: "healthy",
    storage: "healthy",
    connectors: "healthy",
  };
  const flag = (
    key: keyof OperationsAssessment["sections"],
    health: "degraded" | "failed",
    item: Omit<AttentionItem, "tone">,
  ) => {
    sections[key] = worst(sections[key], health);
    items.push({ ...item, tone: health === "failed" ? "danger" : "warning" });
  };

  for (const [id, name] of [
    ["d1", "D1 database"],
    ["kv", "KV namespace"],
    ["r2", "R2 bucket"],
  ] as const) {
    const p = op.probes[id];
    if (probeHealth(p) === "failed")
      flag("probes", "failed", {
        id: `probe-${id}`,
        object: name,
        reason: `Did not answer its probe${p.error ? `: ${p.error}` : "."}`,
      });
  }

  if (op.jobs === null) {
    flag("cron", "degraded", {
      id: "jobs-unreadable",
      object: "Cron runs",
      reason: "The run history could not be read.",
    });
  } else {
    for (const run of [
      op.jobs.latest.maintenance,
      op.jobs.latest.connectorPoll,
    ]) {
      if (run && run.outcome === "failed") {
        const failed = run.steps.filter((s) => s.outcome === "failed");
        flag("cron", "degraded", {
          id: `job-${run.job}`,
          object: jobLabel(run.job),
          reason: `The latest run had ${formatCount(failed.length)} failed step${failed.length === 1 ? "" : "s"}${failed[0] ? `, first ${failed[0].step}` : ""}.`,
          at: Math.floor(run.startedAt / 1000),
        });
      }
    }
  }

  if (op.heartbeats === null) {
    flag("consumers", "degraded", {
      id: "heartbeats-unreadable",
      object: "Heartbeats",
      reason: "The heartbeat rows could not be read.",
    });
  } else {
    const backlog = op.queues.deltas.bound
      ? op.queues.deltas.backlogCount
      : null;
    for (const script of ["main", "deltas"]) {
      const beat = op.heartbeats.find((h) => h.script === script);
      const s = heartbeatState(
        beat,
        script,
        op.generatedAt,
        script === "deltas" ? (backlog ?? beat?.backlogCount ?? null) : null,
      );
      if (s.health !== "healthy")
        flag("consumers", s.health, {
          id: `heartbeat-${script}`,
          object: SCRIPT_LABEL[script] ?? script,
          reason: beat
            ? `${s.label}: nothing reported since ${new Date(beat.at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.`
            : `${s.label}.`,
          at: beat?.at,
        });
    }
  }

  for (const [q, name, dead] of [
    [op.queues.deltas, "Delta queue", false],
    [op.queues.deadLetter, "Dead-letter queue", true],
  ] as const) {
    const h = queueHealth(q, dead);
    if (h === "degraded")
      flag("queues", "degraded", {
        id: dead ? "dlq" : "queue",
        object: name,
        reason:
          q.ok === false
            ? `Its backlog could not be read${q.error ? `: ${q.error}` : "."}`
            : `${formatCount(q.backlogCount ?? 0)} message${q.backlogCount === 1 ? "" : "s"} failed every retry and wait for a decision.`,
      });
  }

  if (op.indexes.missing === null) {
    flag("storage", "degraded", {
      id: "indexes-unreadable",
      object: "Required indexes",
      reason: "The index check could not run.",
    });
  } else if (op.indexes.missing.length > 0) {
    flag("storage", "degraded", {
      id: "indexes",
      object: "Required indexes",
      reason: `${formatCount(op.indexes.missing.length)} missing: ${op.indexes.missing.join(", ")}.`,
    });
  }
  if (op.storage.r2 === null)
    flag("storage", "degraded", {
      id: "r2-totals",
      object: "R2 committed bytes",
      reason: "The blob totals could not be read.",
    });

  if (op.connectors === null) {
    flag("connectors", "degraded", {
      id: "connectors-unreadable",
      object: "Store connectors",
      reason: "The connector status could not be read.",
    });
  } else {
    const fail = op.connectors.lastPollFailure;
    if (fail)
      flag("connectors", "degraded", {
        id: "connector-poll",
        object: "Connector poll",
        reason: `Step ${fail.step} failed${fail.error ? `: ${fail.error}` : "."}`,
        at: Math.floor(fail.at / 1000),
      });
    for (const c of op.connectors.items)
      if (c.failedEvents24h > 0)
        flag("connectors", "degraded", {
          id: `connector-events-${c.connector}`,
          object: connectorLabel(c.connector),
          reason: `${formatCount(c.failedEvents24h)} webhook deliver${c.failedEvents24h === 1 ? "y" : "ies"} failed in the last day.`,
        });
  }

  const overall = Object.values(sections).reduce<Health>(worst, "healthy");
  return { overall, attention: items, sections };
}

const CONNECTOR_LABEL: Record<string, string> = {
  asc: "App Store Connect",
  play: "Google Play",
  "ms-store": "Microsoft Store",
};
const connectorLabel = (c: string): string => CONNECTOR_LABEL[c] ?? c;

function Skeleton({ className }: { className: string }): React.ReactElement {
  return <div aria-hidden className={`pk-skeleton rounded-md ${className}`} />;
}

function Unavailable({ what }: { what: string }): React.ReactElement {
  return (
    <p className="flex items-center gap-2 text-sm text-fg">
      <HealthPill health="degraded">Unavailable</HealthPill>
      {what} could not be read.
    </p>
  );
}

const ms = (seconds: number) => fromSeconds(seconds);

const STEP_COLUMNS: DataColumn<OperationsStepRun>[] = [
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

type RecentRun = NonNullable<PlatformOperations["jobs"]>["recent"][number];

const RECENT_COLUMNS: DataColumn<RecentRun>[] = [
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

function JobBlock({
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
        <h3 id={id} className="text-sm font-bold text-fg-strong">
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

function CronPanel({ jobs }: { jobs: PlatformOperations["jobs"] }) {
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
            <h3 className="text-sm font-bold text-fg-strong">Recent runs</h3>
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
              <h3 className="text-sm font-bold text-fg-strong">
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

function HeartbeatsPanel({ op }: { op: PlatformOperations }) {
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
                  <span className="min-w-0 text-sm font-bold text-fg-strong">
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

function QueueBlock({
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
        <span className="min-w-0 text-sm font-bold text-fg-strong">
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

function QueuesPanel({ op }: { op: PlatformOperations }) {
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

function ProbesPanel({ op }: { op: PlatformOperations }) {
  const rows: [string, OperationsProbe | { bound: boolean }][] = [
    ["D1 database", op.probes.d1],
    ["KV namespace", op.probes.kv],
    ["R2 bucket", op.probes.r2],
    ["Update-health binding", op.probes.updateHealth],
    ["Email binding", op.probes.email],
  ];
  return (
    <Panel title="Bindings">
      <ul className="space-y-2">
        {rows.map(([name, p]) => {
          const probe = p as OperationsProbe;
          const probed = "ok" in probe;
          return (
            <li
              key={name}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="text-fg">{name}</span>
              <span className="flex items-center gap-2">
                {probed && probe.ok !== null && probe.latencyMs !== null ? (
                  <span className="text-xs tabular-nums text-fg-muted">
                    {formatMs(probe.latencyMs)}
                  </span>
                ) : null}
                {!p.bound ? (
                  <StatusPill tone="neutral" size="sm">
                    Not bound
                  </StatusPill>
                ) : probed && probe.ok === false ? (
                  <HealthPill health="failed">No answer</HealthPill>
                ) : probed ? (
                  <HealthPill health="healthy">Answering</HealthPill>
                ) : (
                  <StatusPill tone="success" size="sm">
                    Bound
                  </StatusPill>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

const KIND_LABEL: Record<string, string> = {
  bundle: "Bundles",
  delta: "Deltas",
  artifact: "Artifacts",
  pack: "Packs",
};

function StoragePanel({ op }: { op: PlatformOperations }) {
  const r2 = op.storage.r2;
  const missing = op.indexes.missing;
  return (
    <Panel
      title={r2 && r2.byKind.length > 0 ? "Storage and indexes" : "Indexes"}
    >
      <div
        className={cn(
          "grid grid-cols-1 gap-6",
          r2 && r2.byKind.length > 0 && "lg:grid-cols-2",
        )}
      >
        <div className="min-w-0 space-y-4">
          <DescriptionList
            items={[
              {
                term: "Required indexes",
                detail:
                  missing === null ? (
                    <HealthPill health="degraded">
                      Could not be checked
                    </HealthPill>
                  ) : missing.length === 0 ? (
                    <HealthPill health="healthy">All present</HealthPill>
                  ) : (
                    <HealthPill health="degraded">
                      {formatCount(missing.length)} missing
                    </HealthPill>
                  ),
              },
            ]}
          />
          {missing && missing.length > 0 ? (
            <ul className="space-y-1">
              {missing.map((name) => (
                <li key={name} className="break-all font-mono text-xs text-fg">
                  {name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {r2 && r2.byKind.length > 0 ? (
          <div className="min-w-0">
            <table className="w-full text-sm">
              <caption className="pb-2 text-left text-sm font-bold text-fg-strong">
                Committed bytes by kind
              </caption>
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th scope="col" className="pb-1 font-normal">
                    Kind
                  </th>
                  <th scope="col" className="pb-1 text-right font-normal">
                    Objects
                  </th>
                  <th scope="col" className="pb-1 text-right font-normal">
                    Bytes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r2.byKind.map((k) => (
                  <tr key={`${k.kind}:${k.gated}`}>
                    <th scope="row" className="py-1.5 text-left font-normal">
                      {KIND_LABEL[k.kind] ?? k.kind}
                      {k.gated ? (
                        <span className="text-fg-muted"> (gated)</span>
                      ) : null}
                    </th>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatCount(k.objects)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatBytes(k.bytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

const CONNECTOR_COLUMNS: DataColumn<OperationsConnector>[] = [
  {
    id: "connector",
    header: "Connector",
    accessorFn: (c) => connectorLabel(c.connector),
    meta: { priority: 1, primary: true },
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (c) =>
      c.failedEvents24h > 0
        ? "degraded"
        : c.productsConfigured === 0 && c.objectsTracked === 0
          ? "unused"
          : "healthy",
    meta: { priority: 1 },
    cell: ({ row }) => {
      const c = row.original;
      if (c.failedEvents24h > 0)
        return <HealthPill health="degraded">Failed deliveries</HealthPill>;
      if (c.productsConfigured === 0 && c.objectsTracked === 0)
        return (
          <StatusPill tone="neutral" size="sm">
            Not configured
          </StatusPill>
        );
      return <HealthPill health="healthy" />;
    },
  },
  {
    id: "products",
    header: "Products",
    accessorKey: "productsConfigured",
    meta: { priority: 2, align: "end" },
    cell: ({ row }) => formatCount(row.original.productsConfigured),
  },
  {
    id: "objects",
    header: "Objects tracked",
    accessorKey: "objectsTracked",
    meta: { priority: 3, align: "end" },
    cell: ({ row }) => formatCount(row.original.objectsTracked),
  },
  {
    id: "polled",
    header: "Last poll",
    accessorFn: (c) => c.lastPolledAt ?? 0,
    meta: { numeric: true, priority: 2 },
    cell: ({ row }) =>
      row.original.lastPolledAt !== null ? (
        <Timestamp at={ms(row.original.lastPolledAt)} />
      ) : (
        <span className="text-fg-muted">Never</span>
      ),
  },
  {
    id: "event",
    header: "Last webhook",
    accessorFn: (c) => c.lastEventAt ?? 0,
    meta: { numeric: true, priority: 3, defaultHidden: true },
    cell: ({ row }) =>
      row.original.lastEventAt !== null ? (
        <Timestamp at={ms(row.original.lastEventAt)} />
      ) : (
        <span className="text-fg-muted">Never</span>
      ),
  },
  {
    id: "failed",
    header: "Failed deliveries (24 h)",
    accessorKey: "failedEvents24h",
    meta: { priority: 3, align: "end" },
    cell: ({ row }) => formatCount(row.original.failedEvents24h),
  },
];

function ConnectorsPanel({
  connectors,
}: {
  connectors: PlatformOperations["connectors"];
}) {
  const [state, setState] = React.useState<TableState>(EMPTY_TABLE_STATE);
  return (
    <Panel title="Store connectors">
      {connectors === null ? (
        <Unavailable what="The connector status" />
      ) : (
        <div className="space-y-3">
          <DataTable<OperationsConnector>
            id="ops-connectors"
            caption="Store connectors"
            data={connectors.items}
            columns={CONNECTOR_COLUMNS}
            getRowId={(row) => row.connector}
            rowLabel={(row) => connectorLabel(row.connector)}
            state={state}
            onStateChange={setState}
            empty={
              <EmptyState
                kind="first-run"
                variant="inline"
                title="No connectors in use"
                description="A connector appears here once a product configures it in Distribution."
                docs="/docs/admin/store-connections/"
              />
            }
            mobile="cards"
          />
          {connectors.lastPollFailure ? (
            <p className="text-sm text-fg">
              Newest failed poll step:{" "}
              <span className="font-mono text-xs">
                {connectors.lastPollFailure.step}
              </span>
              ,{" "}
              <Timestamp at={connectors.lastPollFailure.at} format="relative" />
              {connectors.lastPollFailure.error
                ? `: ${connectors.lastPollFailure.error}`
                : "."}
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function RefusalsPanel({ op }: { op: PlatformOperations }) {
  const refusals = op.recentErrors.lazyDeltaRefusals;
  return (
    <Panel
      title="Delta refusals"
      description={refusals?.length ? "Last 7 days, by reason." : undefined}
    >
      {refusals === null ? (
        <Unavailable what="The refusal counts" />
      ) : refusals.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No pair was refused in the last 7 days.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {refusals.map((r) => (
            <li
              key={r.reason}
              className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-sm"
            >
              <span className="min-w-0 break-words text-fg">{r.reason}</span>
              <span className="text-xs text-fg-muted">
                <span className="tabular-nums text-fg">
                  {formatCount(r.count)}
                </span>
                , latest <Timestamp at={ms(r.lastAt)} format="relative" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
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
  const ops = useQuery(
    {
      queryKey: qk.platformOperations(),
      queryFn: fetchPlatformOperations,
      // Pauses by itself while the tab is hidden (TanStack's default), and on the operator's switch.
      refetchInterval: auto ? OPERATIONS_REFRESH_MS : false,
      staleTime: 0,
    },
    queryClient,
  );
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
      // The side's panels stack to about the cron card's height; the rest pair up below, so no
      // card is stretched far past its own content.
      side={
        op ? (
          <>
            <HeartbeatsPanel op={op} />
            <QueuesPanel op={op} />
          </>
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
