/**
 * Platform → Operations: the states and thresholds. `assessOperations` reduces one snapshot to a
 * state per section, an overall state and the attention list. Split out of `platformOperations.tsx`.
 */

import { channelLabel } from "@polaris-key/manifest";
import {} from "../../../../lib/docsLinks.js";
import * as React from "react";
import {} from "@tanstack/react-query";
import {
  type OperationsHeartbeat,
  type OperationsProbe,
  type OperationsQueue,
  type PlatformOperations,
} from "../../../../api.js";
import {
  formatCount,
  formatDateTime,
  formatNumber,
} from "../../../../lib/format.js";
import {} from "../../../../ui/charts/StatTile.js";
import {} from "../../../../lib/cn.js";
import {} from "../../../../ui/DescriptionList.js";
import {} from "../../../../ui/EmptyState.js";
import {} from "../../../../ui/ErrorState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import {} from "../../../../ui/Timestamp.js";
import {} from "../../../../ui/PageHeader.js";
import {} from "../../../data/queries.js";
import { type AttentionItem } from "../../../templates/Dashboard.js";

/** How often the page refetches while it is visible and auto-refresh is on. */
export const OPERATIONS_REFRESH_MS = 30_000;
/** The cron fires every 15 minutes: three missed ticks is stale, eight (two hours) is silent. */
export const MAIN_STALE_SECONDS = 45 * 60;
export const MAIN_SILENT_SECONDS = 2 * 60 * 60;
/** A consumer that has not reported for this long while messages wait is stale; an hour, stalled. */
export const CONSUMER_STALE_SECONDS = 10 * 60;
export const CONSUMER_STALLED_SECONDS = 60 * 60;

export const AUTO_REFRESH_KEY = "pk-admin-operations-auto-refresh";

export type Health = "healthy" | "degraded" | "failed";

export const HEALTH_PILL: Record<
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

export const worst = (a: Health, b: Health): Health =>
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

export const JOB_LABEL: Record<string, string> = {
  maintenance: "Nightly maintenance",
  connectorPoll: "Connector poll",
};
export const jobLabel = (job: string): string => JOB_LABEL[job] ?? job;

export const CRON_HELP: Record<string, string> = {
  "17 3 * * *": "Daily at 03:17 UTC",
  "*/15 * * * *": "Every 15 minutes",
};

export const SCRIPT_LABEL: Record<string, string> = {
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

export function probeHealth(p: OperationsProbe): Health | null {
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
            ? `${s.label}: nothing reported since ${formatDateTime(beat.at * 1000, { locale: "en-US", timeZone: "UTC" })}.`
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

export const CONNECTOR_LABEL: Record<string, string> = {
  asc: "App Store Connect",
  play: channelLabel("google-play"),
  "ms-store": channelLabel("microsoft-store"),
};
export const connectorLabel = (c: string): string => CONNECTOR_LABEL[c] ?? c;
