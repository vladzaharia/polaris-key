/**
 * Distribution → Rollouts (ADMIN.md §6.4, T2): every rollout, live, with its controls. Fixes
 * DOV-1 to DOV-4: no hard-coded caveat, linked releases with who changed them and when, an inline
 * error with Retry, and no developer internals (the descriptor hooks card is gone; the
 * Release → Distribution → Update chain is shown on Core → Services).
 *
 * Halted rows sort first. Facets: state and outlet, in the URL.
 */

import * as React from "react";
import { Plus } from "lucide-react";
import type { Rollout, RolloutVerb } from "../../../api.js";
import { confirmFor, type ActionId } from "../../../lib/actions.js";
import { formatBasisPoints, fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Meter } from "../../../ui/charts/Meter.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { EntityLink, entityHref } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { navigate, Link } from "../../router.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { useReleaseStore, useRollouts } from "./data.js";
import {
  actorLabel,
  ROLLOUT_STATE_ORDER,
  rolloutSummary,
  sourceLabel,
  VERB_LABEL,
} from "./format.js";
import {
  allowedVerbs,
  canSetPercentage,
  RolloutVerbDialog,
  SetPercentageDialog,
  StartRolloutDialog,
} from "./RolloutDialogs.js";
import { statusOf } from "../../../lib/status.js";

const rowId = (r: Rollout) => `${r.deliverableId}:${r.outletId}:${r.channel}`;

export function RolloutsPage({ slug }: { slug: string }): React.ReactElement {
  const rollouts = useRollouts(slug);
  const store = useReleaseStore(slug);
  const [state, setState] = useTableUrlState("rollouts", {
    facets: ["state", "outlet"],
  });
  const [verb, setVerb] = React.useState<{
    rollout: Rollout;
    verb: RolloutVerb;
    version?: string;
  } | null>(null);
  const [setting, setSetting] = React.useState<Rollout | null>(null);
  const [starting, setStarting] = React.useState(false);

  const versions = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of store.data?.releases ?? []) m.set(r.releaseId, r.version);
    return m;
  }, [store.data]);
  const versionOf = (id: string) => versions.get(id) ?? id;

  const rows = React.useMemo(
    () =>
      [...(rollouts.data?.rollouts ?? [])].sort(
        (a, b) =>
          (ROLLOUT_STATE_ORDER[a.state] ?? 9) -
            (ROLLOUT_STATE_ORDER[b.state] ?? 9) || b.updatedAt - a.updatedAt,
      ),
    [rollouts.data],
  );
  const outlets = [...new Set(rows.map((r) => r.outletId))].sort();
  const halted = rows.filter((r) => r.state === "halted").length;

  const columns: DataColumn<Rollout>[] = [
    {
      id: "release",
      header: "Release",
      accessorFn: (r) => versionOf(r.releaseId),
      meta: { priority: 1, primary: true },
      cell: ({ row }) => (
        <span className="flex flex-col">
          <EntityLink
            slug={slug}
            kind="release"
            id={row.original.releaseId}
            label={
              <span className="font-mono text-xs">
                {versionOf(row.original.releaseId)}
              </span>
            }
          />
          {row.original.deliverableId !== "app" ? (
            <span className="text-xs text-fg-muted">
              {row.original.deliverableId}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "outlet",
      header: "Outlet",
      accessorKey: "outletId",
      meta: { priority: 1 },
      cell: ({ row }) => (
        <Link
          to={entityHref(slug, {
            kind: "rollout",
            release: row.original.releaseId,
            outlet: row.original.outletId,
            deliverable:
              row.original.deliverableId === "app"
                ? undefined
                : row.original.deliverableId,
          })}
          className="text-accent-fg underline-offset-4 hover:underline"
          aria-label={`${row.original.outletId}: open the matrix cell`}
        >
          {row.original.outletId}
        </Link>
      ),
    },
    {
      id: "channel",
      header: "Channel",
      accessorKey: "channel",
      meta: { priority: 2 },
    },
    {
      id: "rolloutBp",
      header: "Rollout",
      accessorKey: "rolloutBp",
      meta: {
        priority: 2,
        label: "Rollout",
        csv: (r) => formatBasisPoints(r.rolloutBp),
      },
      cell: ({ row }) => (
        <Meter
          label={`Rollout of ${versionOf(row.original.releaseId)} on ${row.original.outletId} / ${row.original.channel}`}
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
      id: "state",
      header: "State",
      accessorKey: "state",
      meta: { priority: 1, csv: (r) => rolloutSummary(r) },
      cell: ({ row }) => (
        <StatusPill domain="rollout" state={row.original.state} size="sm" />
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
  ];

  const rowActions = (r: Rollout): RowActionItem[] => {
    const openCell: RowActionItem = {
      label: "Open in matrix",
      onSelect: () =>
        navigate(
          entityHref(slug, {
            kind: "rollout",
            release: r.releaseId,
            outlet: r.outletId,
            deliverable:
              r.deliverableId === "app" ? undefined : r.deliverableId,
          }),
        ),
    };
    // A store-owned rollout is read-only here: its store controls are in the matrix cell.
    if (r.mirrored) return [openCell];
    const verbs = allowedVerbs(r);
    const safe = verbs.filter(
      (v) => confirmFor(`rollout.${v}` as ActionId).level < 2,
    );
    const danger = verbs.filter(
      (v) => confirmFor(`rollout.${v}` as ActionId).level >= 2,
    );
    const items: RowActionItem[] = [
      openCell,
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
    <CollectionTemplate
      header={
        <PageHeader
          title="Rollouts"
          titleAside={
            rollouts.data && rows.length > 0 ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-sm tabular-nums text-fg-muted">
                  {rows.length}
                </span>
                {halted > 0 ? (
                  <StatusPill tone="danger" size="sm">
                    {halted} halted
                  </StatusPill>
                ) : null}
              </span>
            ) : undefined
          }
          description="A halt or pause reaches devices on their next feed check."
          primaryAction={
            <Button
              iconStart={<Plus aria-hidden />}
              onClick={() => setStarting(true)}
            >
              Start rollout…
            </Button>
          }
          refetching={rollouts.isFetching && !rollouts.isPending}
        />
      }
    >
      <DataTable<Rollout>
        id="rollouts"
        caption="Rollouts"
        data={rows}
        columns={columns}
        getRowId={rowId}
        rowLabel={(r) =>
          `${versionOf(r.releaseId)} on ${r.outletId} / ${r.channel}`
        }
        rowActions={rowActions}
        linkComponent={Link}
        state={state}
        onStateChange={setState}
        search={{
          placeholder: "Search rollouts",
          columns: ["release", "outlet", "channel"],
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
          {
            id: "outlet",
            label: "Outlet",
            options: outlets.map((o) => ({ value: o, label: o })),
          },
        ]}
        loading={rollouts.isPending}
        error={rollouts.isError && !rollouts.data ? rollouts.error : undefined}
        onRetry={() => void rollouts.refetch()}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            title="No rollouts yet"
            description="A rollout offers a release to a share of the devices on one outlet's channel, so a bad build reaches few before you halt it. Without one, each channel offers its release to everyone."
            primaryAction={
              <Button onClick={() => setStarting(true)}>Start rollout…</Button>
            }
            docs="/docs/services/distribution/rollouts/"
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
        initial={{ deliverable: "app" }}
        onClose={() => setStarting(false)}
      />
    </CollectionTemplate>
  );
}
