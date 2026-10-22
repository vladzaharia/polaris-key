/**
 * Platform → Operations: the probe, storage, connector and refusal panels. Split out of
 * `platformOperations.tsx`.
 */

import { docsUrl } from "../../../../lib/docsLinks.js";
import * as React from "react";
import { ms, Unavailable } from "./platformOperationsPanels.js";
import {
  type OperationsConnector,
  type OperationsProbe,
  type PlatformOperations,
} from "../../../../api.js";
import { formatBytes, formatCount } from "../../../../lib/format.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type DataColumn,
  type TableState,
} from "../../../../ui/data-table/index.js";
import { cn } from "../../../../lib/cn.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import {
  connectorLabel,
  formatMs,
  HealthPill,
} from "./platformOperationsAssess.js";
import { Panel } from "../../../templates/Dashboard.js";

export function ProbesPanel({ op }: { op: PlatformOperations }) {
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

export const KIND_LABEL: Record<string, string> = {
  bundle: "Bundles",
  delta: "Deltas",
  artifact: "Artifacts",
  pack: "Packs",
};

export function StoragePanel({ op }: { op: PlatformOperations }) {
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
              <caption className="pb-2 text-start text-sm font-semibold text-fg-strong">
                Committed bytes by kind
              </caption>
              <thead>
                <tr className="text-start text-xs text-fg-muted">
                  <th scope="col" className="pb-1 font-normal">
                    Kind
                  </th>
                  <th scope="col" className="pb-1 text-end font-normal">
                    Objects
                  </th>
                  <th scope="col" className="pb-1 text-end font-normal">
                    Bytes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r2.byKind.map((k) => (
                  <tr key={`${k.kind}:${k.gated}`}>
                    <th scope="row" className="py-1.5 text-start font-normal">
                      {KIND_LABEL[k.kind] ?? k.kind}
                      {k.gated ? (
                        <span className="text-fg-muted"> (gated)</span>
                      ) : null}
                    </th>
                    <td className="py-1.5 text-end tabular-nums">
                      {formatCount(k.objects)}
                    </td>
                    <td className="py-1.5 text-end tabular-nums">
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

export const CONNECTOR_COLUMNS: DataColumn<OperationsConnector>[] = [
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

export function ConnectorsPanel({
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
                docs={docsUrl("storeConnectionsPage")}
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

export function RefusalsPanel({ op }: { op: PlatformOperations }) {
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
