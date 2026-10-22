/**
 * Platform → Deployment helpers: the build label, the attention rules, the deploy-history table
 * columns and the keyset "load more" hook. Split out of `../index.tsx`.
 */

import * as React from "react";
import { ExternalLink } from "lucide-react";
import type {
  PlatformCursor,
  PlatformDeploy,
  PlatformDeployment,
} from "../../../../api.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { ENVIRONMENT_LABELS, label } from "../../../../lib/labels.js";
import type { DataColumn } from "../../../../ui/data-table/index.js";
import { Hash } from "../../../../ui/Hash.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import type { AttentionItem } from "../../../templates/Dashboard.js";

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

export const DEPLOY_COLUMNS: DataColumn<PlatformDeploy>[] = [
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
export function useMorePages<T>(
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
