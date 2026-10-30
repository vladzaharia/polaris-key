/**
 * The rollouts table with its row actions and dialogs (verb, set percentage, start), shared by
 * Distribution → Rollouts and a channel's Releases tab (A-22.2). The caller owns the read, the
 * header and where a row opens; this owns what a rollout row can do.
 */

import * as React from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  Rollout,
  RolloutsResponse,
  RolloutVerb,
} from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { confirmFor, type ActionId } from "../../../../lib/actions.js";
import { formatBasisPoints, fromSeconds } from "../../../../lib/format.js";
import { statusOf } from "../../../../lib/status.js";
import { Button } from "../../../../ui/Button.js";
import { Meter } from "../../../../ui/charts/Meter.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { useWriteGate } from "../../../access/useCan.js";
import { entityHref } from "../../../components/EntityLink.js";
import { Link, navigate } from "../../../router.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { useReleaseStore } from "../../release/data.js";
import {
  actorLabel,
  ROLLOUT_STATE_ORDER,
  rolloutSummary,
  sourceLabel,
  VERB_LABEL,
} from "../model/format.js";
import {
  allowedVerbs,
  canSetPercentage,
  RolloutVerbDialog,
  SetPercentageDialog,
  StartRolloutDialog,
} from "./RolloutDialogs.js";

const rowId = (r: Rollout) => `${r.deliverableId}:${r.outletId}:${r.channel}`;

/** The rollout states that need someone: the only ones drawn as pills. */
const ISSUE_STATES = new Set(["halted", "paused"]);

export function RolloutList({
  slug,
  rollouts,
  keep,
  tableId,
  hrefFor,
  starting,
  onStartingChange,
  startInitial,
  emptyDescription,
  loading = false,
  onlyOutlets,
  emptyAction,
  quietStart,
}: {
  slug: string;
  rollouts: UseQueryResult<RolloutsResponse>;
  /** Show only the rollouts this accepts (a channel's own outlets). */
  keep?: (r: Rollout) => boolean;
  /** The table's id in the URL, so two tables never share state. */
  tableId: string;
  /** Where a row opens: its cell drawer. */
  hrefFor: (r: Rollout) => string;
  starting: boolean;
  onStartingChange: (open: boolean) => void;
  startInitial: { deliverable: string; outlet?: string };
  emptyDescription?: string;
  /** Something the caller waits on (a channel's outlets) besides the rollouts. */
  loading?: boolean;
  /** One channel's page: its outlets only, and no outlet column or facet. */
  onlyOutlets?: ReadonlySet<string>;
  /** The empty state's one action, when it is not "Start rollout…" (null for none). */
  emptyAction?: React.ReactNode;
  /** The empty state's Start rollout is an outline button, not the page's primary. */
  quietStart?: boolean;
}): React.ReactElement {
  const gate = useWriteGate("ship", slug);
  const store = useReleaseStore(slug);
  const [state, setState] = useTableUrlState(tableId, {
    facets: onlyOutlets ? ["state"] : ["state", "outlet"],
  });
  const [verb, setVerb] = React.useState<{
    rollout: Rollout;
    verb: RolloutVerb;
    version?: string;
  } | null>(null);
  const [setting, setSetting] = React.useState<Rollout | null>(null);

  const versions = React.useMemo(
    () =>
      new Map(
        (store.data?.releases ?? []).map((x) => [x.releaseId, x.version]),
      ),
    [store.data],
  );
  const versionOf = (id: string) => versions.get(id) ?? id;

  const rows = React.useMemo(
    () =>
      [...(rollouts.data?.rollouts ?? [])]
        .filter((r) => !keep || keep(r))
        .sort(
          (a, b) =>
            (ROLLOUT_STATE_ORDER[a.state] ?? 9) -
              (ROLLOUT_STATE_ORDER[b.state] ?? 9) || b.updatedAt - a.updatedAt,
        ),
    [rollouts.data, keep],
  );
  const where = (r: Rollout) =>
    onlyOutlets ? r.channel : `${r.outletId} / ${r.channel}`;
  const outlets = [...new Set(rows.map((r) => r.outletId))].sort();

  const allColumns: DataColumn<Rollout>[] = [
    {
      id: "release",
      header: "Release",
      accessorFn: (r) => versionOf(r.releaseId),
      meta: { priority: 1, primary: true },
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span className="font-mono text-xs whitespace-nowrap">
            {versionOf(row.original.releaseId)}
          </span>
          {onlyOutlets && row.original.deliverableId !== "app" ? (
            <span className="text-xs text-fg-muted">
              {row.original.deliverableId}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "outlet",
      header: "Channel",
      accessorKey: "outletId",
      meta: { priority: 1 },
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span>{row.original.outletId}</span>
          {row.original.deliverableId !== "app" ? (
            <span className="text-xs text-fg-muted">
              {row.original.deliverableId}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "channel",
      header: "Release track",
      accessorKey: "channel",
      meta: { priority: 1 },
    },
    {
      id: "rolloutBp",
      header: "Rollout",
      accessorKey: "rolloutBp",
      meta: {
        priority: 1,
        label: "Rollout",
        csv: (r) => formatBasisPoints(r.rolloutBp),
      },
      cell: ({ row }) => (
        <Meter
          label={`Rollout of ${versionOf(row.original.releaseId)} on ${where(row.original)}`}
          hideLabel
          value={
            row.original.state === "complete" ? 10_000 : row.original.rolloutBp
          }
          max={10_000}
          format="bp"
          tone={
            row.original.state === "halted"
              ? "danger"
              : row.original.state === "paused"
                ? "warning"
                : "accent"
          }
          className="min-w-32"
        />
      ),
    },
    {
      id: "source",
      header: "Source",
      accessorFn: (r) =>
        r.mirrored
          ? `${sourceLabel(r.source)} (store-owned)`
          : sourceLabel(r.source),
      meta: { priority: 3 },
    },
    {
      id: "updatedAt",
      header: "Updated",
      accessorKey: "updatedAt",
      meta: {
        numeric: true,
        priority: 2,
        csv: (r) => new Date(fromSeconds(r.updatedAt)).toISOString(),
      },
      cell: ({ row }) => (
        <span className="flex flex-col">
          <Timestamp at={fromSeconds(row.original.updatedAt)} />
          <span className="text-xs text-fg-muted">
            by {actorLabel(row.original.updatedBy)}
          </span>
        </span>
      ),
    },
    {
      // Pills mean attention (EXPERIENCE.md §11): halted and paused are pills, end-aligned in
      // the last column; a healthy rollout's state is plain text the phone card leaves out.
      id: "state",
      header: "State",
      accessorKey: "state",
      meta: {
        priority: 1,
        align: "end",
        csv: (r) => rolloutSummary(r),
        quiet: (r) => !ISSUE_STATES.has(r.state),
      },
      cell: ({ row }) =>
        ISSUE_STATES.has(row.original.state) ? (
          <StatusPill domain="rollout" state={row.original.state} size="sm" />
        ) : (
          <span className="text-fg-muted">
            {statusOf("rollout", row.original.state).label}
          </span>
        ),
    },
  ];

  // A channel page is one channel: its outlet is neither a column nor a facet.
  const columns = onlyOutlets
    ? allColumns.filter((c) => c.id !== "outlet")
    : allColumns;

  const rowActions = (r: Rollout): RowActionItem[] => {
    const openCell: RowActionItem = {
      label: "Open rollout",
      onSelect: () => navigate(hrefFor(r)),
    };
    const openRelease: RowActionItem = {
      label: "Open release",
      onSelect: () =>
        navigate(entityHref(slug, { kind: "release", id: r.releaseId })),
    };
    // A store-owned rollout is read-only here: its store controls are in its drawer.
    if (r.mirrored || !gate.allowed) return [openCell, openRelease];
    const verbs = allowedVerbs(r);
    const safe = verbs.filter(
      (v) => confirmFor(`rollout.${v}` as ActionId).level < 2,
    );
    const danger = verbs.filter(
      (v) => confirmFor(`rollout.${v}` as ActionId).level >= 2,
    );
    const items: RowActionItem[] = [
      openCell,
      openRelease,
      ...safe.map((v) => ({
        label: `${VERB_LABEL[v]}…`,
        onSelect: () =>
          setVerb({ rollout: r, verb: v, version: versionOf(r.releaseId) }),
      })),
    ];
    if (canSetPercentage(r))
      items.push({ label: "Set percentage…", onSelect: () => setSetting(r) });
    if (danger.length) {
      items.push({ type: "separator" });
      for (const v of danger)
        items.push({
          label: `${VERB_LABEL[v]}…`,
          tone: "danger",
          onSelect: () =>
            setVerb({ rollout: r, verb: v, version: versionOf(r.releaseId) }),
        });
    }
    return items;
  };

  return (
    <>
      <DataTable<Rollout>
        id={tableId}
        caption="Rollouts"
        data={rows}
        columns={columns}
        getRowId={rowId}
        rowLabel={(r) => `${versionOf(r.releaseId)} on ${where(r)}`}
        rowHref={hrefFor}
        rowActions={rowActions}
        linkComponent={Link}
        state={state}
        onStateChange={setState}
        search={{
          placeholder: "Search rollouts",
          columns: onlyOutlets
            ? ["release", "channel"]
            : ["release", "outlet", "channel"],
        }}
        facets={[
          {
            id: "state",
            label: "State",
            options: ["halted", "paused", "active", "complete"].map((s) => ({
              value: s,
              label: statusOf("rollout", s).label,
            })),
          },
          ...(onlyOutlets
            ? []
            : [
                {
                  id: "outlet",
                  label: "Channel",
                  options: outlets.map((o) => ({ value: o, label: o })),
                },
              ]),
        ]}
        loading={rollouts.isPending || loading}
        error={rollouts.isError && !rollouts.data ? rollouts.error : undefined}
        onRetry={() => void rollouts.refetch()}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            title="No rollouts yet"
            description={
              emptyDescription ??
              "A rollout offers a release to a share of the devices on one channel's release track, so a bad build reaches few before you halt it. Without one, each channel offers its release to everyone."
            }
            primaryAction={
              emptyAction !== undefined ? (
                emptyAction
              ) : (
                <Button
                  variant={quietStart ? "outline" : undefined}
                  disabledReason={gate.disabledReason}
                  onClick={() => onStartingChange(true)}
                >
                  Start rollout…
                </Button>
              )
            }
            docs={docsUrl("rollouts")}
          />
        }
      />
      <RolloutVerbDialog
        slug={slug}
        target={verb}
        onClose={() => setVerb(null)}
      />
      {setting ? (
        <SetPercentageDialog
          slug={slug}
          rollout={setting}
          version={versionOf(setting.releaseId)}
          onClose={() => setSetting(null)}
        />
      ) : null}
      <StartRolloutDialog
        slug={slug}
        open={starting}
        initial={startInitial}
        onlyOutlets={onlyOutlets}
        onClose={() => onStartingChange(false)}
      />
    </>
  );
}
