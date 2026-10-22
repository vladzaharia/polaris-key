/**
 * Platform → Status: the Checks table (Check · Result · Next action). Three checks always have a
 * row (the Worker deployment, the storage bindings, recent automation); each problem the two reads
 * found takes its group's first row, and any further problem its own row under it. A healthy
 * check's next action reads "None". A read that failed says so in the check's row.
 */

import * as React from "react";
import { CircleCheck, TriangleAlert, OctagonAlert } from "lucide-react";
import type {
  PlatformDeployment,
  PlatformOperations,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { Panel, type AttentionItem } from "../../../templates/Dashboard.js";
import { Link } from "../../../router.js";
import { fromSeconds } from "../../../../lib/format.js";
import { buildLabel } from "./platformDeployParts.js";

type Group = "deploy" | "bindings" | "automation";
type Tone = "success" | "warning" | "danger";

interface Problem {
  id: string;
  group: Group;
  tone: Tone;
  /** What the problem is about (the row's title when it is not the group's first). */
  object: string;
  result: string;
  next: React.ReactNode;
}

export interface Check {
  id: string;
  title: React.ReactNode;
  sub: React.ReactNode;
  tone: Tone;
  result: React.ReactNode;
  next: React.ReactNode;
}

const GROUP_SUB: Record<Group, string> = {
  deploy: "Build, migrations, smoke check",
  bindings: "D1, R2, KV, queues",
  automation: "Cron, queues, heartbeats",
};

/** The group an operations attention id belongs to. */
function groupOf(id: string): Group {
  return id.startsWith("probe-") ||
    id === "r2-totals" ||
    id.startsWith("indexes")
    ? "bindings"
    : "automation";
}

const stripDot = (s: string) => s.replace(/\.$/, "");

function nextFor(
  id: string,
  stores: string,
  runUrl: string | undefined,
): React.ReactNode {
  if (id === "smoke")
    return runUrl ? (
      <a
        href={runUrl}
        target="_blank"
        rel="noreferrer"
        className="text-accent-fg underline-offset-4 hover:underline"
      >
        View the deploy run
        <span className="sr-only"> (opens GitHub Actions)</span>
      </a>
    ) : (
      "Check the deploy run"
    );
  if (id === "migrations") return "Apply the pending migrations";
  if (id === "bindings") return "Bind them in the Worker config, then redeploy";
  if (id.startsWith("indexes")) return "Apply the migrations that add them";
  if (id.startsWith("probe-")) return "Check it in Cloudflare";
  if (id === "r2-totals") return "Refresh; if it stays, check R2";
  if (id.startsWith("connector"))
    return (
      <Link
        to={stores}
        className="text-accent-fg underline-offset-4 hover:underline"
      >
        Open Store connections
      </Link>
    );
  if (id.startsWith("job") || id.startsWith("heartbeat"))
    return "See Scheduled jobs below";
  return "Check the queue in Cloudflare";
}

export function buildChecks({
  deployment: d,
  deploymentError,
  ops,
  opsError,
  attention,
  opsAttention,
  stores,
  onRetry,
}: {
  deployment: PlatformDeployment | undefined;
  deploymentError: boolean;
  ops: PlatformOperations | undefined;
  opsError: boolean;
  attention: AttentionItem[];
  opsAttention: AttentionItem[];
  stores: string;
  onRetry: () => void;
}): Check[] {
  const retry = (
    <Button variant="outline" size="sm" onClick={onRetry}>
      Try again
    </Button>
  );
  const problems: Problem[] = [];
  const runUrl = d?.deploys.items[0]?.runUrl ?? undefined;
  for (const a of attention)
    problems.push({
      id: a.id,
      group: a.id === "smoke" || a.id === "migrations" ? "deploy" : "bindings",
      tone: a.tone === "danger" ? "danger" : "warning",
      object: String(a.object),
      result: stripDot(
        a.id === "smoke"
          ? "Smoke check failed after the deploy"
          : a.id === "migrations"
            ? `Migration ${d?.migrations.latest} not applied`
            : a.reason,
      ),
      next: nextFor(a.id, stores, runUrl),
    });
  for (const a of opsAttention) {
    // The deployment read already says it (migrations, indexes).
    if (d && a.id.startsWith("indexes")) continue;
    problems.push({
      id: a.id,
      group: groupOf(a.id),
      tone: a.tone === "danger" ? "danger" : "warning",
      object: String(a.object),
      result: stripDot(a.reason),
      next: nextFor(a.id, stores, undefined),
    });
  }

  const present = d ? Object.values(d.bindings).filter(Boolean).length : 0;
  const total = d ? Object.keys(d.bindings).length : 0;
  const live = d?.deploys.items[0]?.at
    ? fromSeconds(d.deploys.items[0].at)
    : d?.current.cloudflare?.uploadedAt
      ? Date.parse(d.current.cloudflare.uploadedAt)
      : NaN;

  const base: Record<
    Group,
    {
      title: string;
      sub: React.ReactNode;
      loaded: boolean;
      failed: boolean;
      ok: React.ReactNode;
    }
  > = {
    deploy: {
      title: "Worker deployment",
      sub: d ? (
        <>
          {buildLabel(d.current)}
          {d.current.gitSha ? (
            <>
              {" "}
              ·{" "}
              <span className="font-mono">{d.current.gitSha.slice(0, 7)}</span>
            </>
          ) : null}
        </>
      ) : (
        GROUP_SUB.deploy
      ),
      loaded: d !== undefined,
      failed: deploymentError,
      ok: Number.isNaN(live) ? (
        "Running"
      ) : (
        <>
          Live since <Timestamp at={live} format="absolute" />
        </>
      ),
    },
    bindings: {
      title: "Storage bindings",
      sub: GROUP_SUB.bindings,
      loaded: d !== undefined,
      failed: deploymentError,
      ok: `All ${total} present`,
    },
    automation: {
      title: "Recent automation",
      sub: GROUP_SUB.automation,
      loaded: ops !== undefined,
      failed: opsError,
      ok: "No failures",
    },
  };
  void present;

  const rows: Check[] = [];
  for (const group of ["deploy", "bindings", "automation"] as const) {
    const b = base[group];
    if (b.failed) {
      rows.push({
        id: group,
        title: b.title,
        sub: b.sub,
        tone: "warning",
        result: "Could not be read",
        next: retry,
      });
      continue;
    }
    if (!b.loaded) continue;
    const mine = problems.filter((p) => p.group === group);
    if (mine.length === 0) {
      rows.push({
        id: group,
        title: b.title,
        sub: b.sub,
        tone: "success",
        result: b.ok,
        next: <span className="text-fg-muted">None</span>,
      });
      continue;
    }
    mine.forEach((p, i) =>
      rows.push({
        id: `${group}:${p.id}`,
        title: i === 0 ? b.title : p.object,
        sub: i === 0 ? b.sub : b.title,
        tone: p.tone,
        result: p.result,
        next: p.next,
      }),
    );
  }
  return rows;
}

const TONE_ICON = {
  success: CircleCheck,
  warning: TriangleAlert,
  danger: OctagonAlert,
} as const;
const TONE_TEXT = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

export function ChecksTable({
  checks,
  loading,
}: {
  checks: Check[];
  loading: boolean;
}): React.ReactElement {
  const label = "mt-0 text-xs text-fg-muted sm:hidden";
  return (
    <Panel title="Checks">
      {loading && checks.length === 0 ? (
        <div aria-hidden className="pk-skeleton-group space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="pk-skeleton h-10 rounded-md" />
          ))}
        </div>
      ) : (
        <table className="w-full text-sm sm:table-fixed max-sm:block">
          <caption className="sr-only">
            Checks: what was checked, the result and the next action
          </caption>
          <thead className="max-sm:sr-only">
            <tr className="border-b border-border text-start text-xs text-fg-muted">
              <th
                scope="col"
                className="w-[28%] pb-2 pe-3 text-start font-normal"
              >
                Check
              </th>
              <th
                scope="col"
                className="w-[40%] pb-2 pe-3 text-start font-normal"
              >
                Result
              </th>
              <th scope="col" className="pb-2 text-start font-normal">
                Next action
              </th>
            </tr>
          </thead>
          <tbody className="max-sm:block max-sm:divide-y max-sm:divide-border">
            {checks.map((c) => {
              const Icon = TONE_ICON[c.tone];
              return (
                <tr
                  key={c.id}
                  className="border-b border-border last:border-b-0 max-sm:grid max-sm:gap-1.5 max-sm:border-b-0 max-sm:py-3"
                >
                  <td className="min-w-0 py-3 pe-3 align-top max-sm:p-0">
                    <div className="break-words font-medium text-fg-strong">
                      {c.title}
                    </div>
                    <div className="break-words text-xs text-fg-muted">
                      {c.sub}
                    </div>
                  </td>
                  <td className="min-w-0 py-3 pe-3 align-top max-sm:p-0">
                    <span className={label}>Result </span>
                    <span
                      className={`inline-flex items-start gap-1.5 ${TONE_TEXT[c.tone]}`}
                    >
                      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span className="break-words">{c.result}</span>
                    </span>
                  </td>
                  <td className="min-w-0 py-3 align-top max-sm:p-0">
                    <span className={label}>Next </span>
                    <span className="break-words text-fg">{c.next}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
