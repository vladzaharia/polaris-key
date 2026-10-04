import * as React from "react";
import { AlertTriangle, Boxes, ChevronRight } from "lucide-react";
import type { DeliverableDto } from "../../api.js";
import { api } from "../../api.js";
import { useResource } from "../../context.js";
import { r } from "../../console/routes.js";
import { navigate } from "../../console/router.js";
import { docsUrl } from "../../lib/docsLinks.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  type ColumnDef,
} from "../../components/ui/index.js";
import { absoluteTime, relativeTime } from "../format.js";
import { ContentKeys } from "./ContentKeys.js";
import { qk } from "../../console/data/queries.js";

/**
 * The Release section's Deliverables tab (P4-09): the app and every pack the product declares,
 * side by side, because packs appear wherever the app does (CONTENT §14). Per deliverable: its
 * kind, pack type, binding, whether it is required, its embedded baseline, its delivery, its
 * delivery gate and its latest release; for a pack, how many app releases pin it.
 *
 * Read-only in v1: everything is `GET …/release/deliverables`, rendered as the server returns it.
 * Types, bindings and deliveries are the strings the declarations hold — the console names no
 * pack and no pack type (AGENTS rule 5).
 *
 * Two flags carry the operator's real questions. "Not pinned by any app release": a `pinned`
 * pack's release reaches a device only through an app release that pins it, so such a pack
 * delivers nothing yet (compatible and standalone packs ship through the resolved sets instead). "Gate differs": the gate is the pack's own access row,
 * operator-owned; the latest release's signed `entitlement` is the gate CI saw at publish, and a
 * device follows that until the next publish (plans/P4-01.md §8.2 risk 14).
 */
export function Deliverables({ slug }: { slug: string }): React.ReactElement {
  const list = useResource(qk.deliverables(slug), () => api.deliverables(slug));
  const rows = list.data?.deliverables ?? [];
  const gateKnown = list.data?.gateKnown ?? true;
  const open = (d: DeliverableDto): void => {
    navigate(r.deliverable(slug, d.id));
  };

  const columns: ColumnDef<DeliverableDto>[] = [
    {
      id: "id",
      header: "Deliverable",
      accessor: (d) => d.id,
      sortable: true,
      cell: (d) =>
        // The app has no detail page here, and a package's record is its feed's (F-11).
        d.kind !== "pack" ? (
          <span className="font-mono text-xs">{d.id}</span>
        ) : (
          <button
            type="button"
            onClick={() => open(d)}
            className="inline-flex items-center gap-1 font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Open pack ${d.id}`}
          >
            {d.id}
            <ChevronRight className="size-3.5" aria-hidden />
            {!d.declared ? (
              <Badge variant="warning">declaration unreadable</Badge>
            ) : null}
          </button>
        ),
    },
    {
      id: "kind",
      header: "Kind",
      accessor: (d) => d.kind,
      sortable: true,
      cell: (d) => (
        <Badge
          variant={
            d.kind === "app"
              ? "primary"
              : d.kind === "package"
                ? "default"
                : "outline"
          }
        >
          {d.kind}
        </Badge>
      ),
    },
    {
      id: "type",
      header: "Type",
      cell: (d) => <Text value={d.type} mono />,
    },
    {
      id: "binding",
      header: "Binding",
      cell: (d) => <Text value={d.binding} />,
    },
    {
      id: "required",
      header: "Required",
      cell: (d) =>
        d.required === null ? (
          <Dash />
        ) : d.required ? (
          <Badge variant="warning">required</Badge>
        ) : (
          <span className="text-muted-foreground">optional</span>
        ),
    },
    {
      id: "baseline",
      header: "Baseline",
      cell: (d) => <Text value={d.baseline} />,
    },
    {
      id: "delivery",
      header: "Delivery",
      cell: (d) => <Text value={d.delivery} />,
    },
    {
      id: "gate",
      header: "Entitlement",
      cell: (d) => <GateCell d={d} gateKnown={gateKnown} />,
    },
    {
      id: "latest",
      header: "Latest release",
      accessor: (d) => d.latest?.publishedAt ?? 0,
      sortable: true,
      cell: (d) =>
        d.latest ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs">{d.latest.version}</span>
            {d.latest.yanked ? (
              <Badge variant="destructive">yanked</Badge>
            ) : null}
            {d.latest.publishedAt ? (
              <span
                className="text-xs text-muted-foreground"
                title={absoluteTime(d.latest.publishedAt)}
              >
                {relativeTime(d.latest.publishedAt)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">none yet</span>
        ),
    },
    {
      id: "pins",
      header: "Pinned by",
      cell: (d) => <PinnedCell d={d} />,
    },
  ];

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Deliverables</h2>
        <p className="text-sm text-muted-foreground">
          The app and its packs for <span className="font-mono">{slug}</span>.
        </p>
      </header>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Boxes className="size-4 text-muted-foreground" aria-hidden />
            <CardTitle>Deliverables</CardTitle>
          </div>
          <CardDescription>
            Every deliverable the release manifest declares. A pinned pack ships
            only when an app release pins one of its releases; open a pack to
            see which app releases pin which of its releases.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("packDeliverables")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {list.error && !list.data ? (
            <EmptyState
              icon={<AlertTriangle aria-hidden />}
              title="Couldn’t load the deliverables"
              description={list.error}
              action={
                <Button variant="outline" onClick={list.reload}>
                  Try again
                </Button>
              }
              className="rounded-none border-0"
            />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(d) => d.id}
              loading={list.loading && !list.data}
              empty={
                <EmptyState
                  icon={<Boxes aria-hidden />}
                  title="No deliverables yet"
                  description="Declare the app (and any packs) in the product’s .pkey/release, then resync."
                  className="rounded-none border-0"
                />
              }
            />
          )}
          {!gateKnown ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Distribution is off for this product, so the delivery gates are
              not shown.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <ContentKeys slug={slug} />
    </section>
  );
}

/** The gate, and the latest release's signed entitlement beside it when the two differ. */
export function GateCell({
  d,
  gateKnown,
}: {
  d: DeliverableDto;
  gateKnown: boolean;
}): React.ReactElement {
  const gate = gateKnown ? d.gate : null;
  const signed = d.kind === "app" ? null : (d.latest?.entitlement ?? null);
  const differs = gateKnown && d.kind !== "app" && d.latest && signed !== gate;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {!gateKnown ? (
        <Dash />
      ) : gate ? (
        <Badge variant="outline" title="The delivery gate">
          <span className="font-mono">{gate}</span>
        </Badge>
      ) : (
        <span className="text-muted-foreground">ungated</span>
      )}
      {differs ? (
        <Badge
          variant="warning"
          title="Devices follow the latest release's signed entitlement until the next publish."
        >
          latest release signed {signed ? `“${signed}”` : "no gate"}
        </Badge>
      ) : null}
      {d.assertedEntitlement && d.assertedEntitlement !== gate ? (
        <span
          className="text-xs text-muted-foreground"
          title="The licence flag the manifest asserts; the gate is set in Distribution."
        >
          manifest asserts {d.assertedEntitlement}
        </span>
      ) : null}
    </span>
  );
}

/**
 * How many app releases pin the pack, or the flag that none does. The flag is for a `pinned` pack
 * only (or one whose declaration does not read back): a compatible or standalone pack reaches
 * devices through the resolved pack sets (P4-12), so zero pins is normal for it.
 */
export function PinnedCell({ d }: { d: DeliverableDto }): React.ReactElement {
  if (d.pinnedByAppReleases === null) return <Dash />;
  if (d.pinnedByAppReleases === 0)
    return d.binding === "pinned" || d.binding === null ? (
      <Badge variant="warning">Not pinned by any app release</Badge>
    ) : (
      <span className="text-muted-foreground">none (resolved sets)</span>
    );
  return (
    <span>
      {d.pinnedByAppReleases === 1
        ? "1 app release"
        : `${d.pinnedByAppReleases} app releases`}
    </span>
  );
}

function Text({
  value,
  mono,
}: {
  value: string | null;
  mono?: boolean;
}): React.ReactElement {
  if (value === null) return <Dash />;
  return (
    <span className={mono ? "font-mono text-xs" : undefined}>{value}</span>
  );
}

function Dash(): React.ReactElement {
  return <span className="text-muted-foreground">—</span>;
}
