import * as React from "react";
import { AlertTriangle, Info } from "lucide-react";
import type { DeliverableDto } from "../../../api.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { BINDING_LABELS, label } from "../../../lib/labels.js";
import { fromSeconds } from "../../../lib/format.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { Popover } from "../../../ui/Popover.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { Version } from "../../../ui/Version.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Link } from "../../router.js";
import { productPage, r } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { useDeliverables } from "./data.js";

/**
 * Release → Deliverables (ADMIN.md §6.3.4, T2): the app and every pack. The app row links to
 * Releases (DLV-1); a pack links to its record. Low-value columns start hidden (DLV-2); the gate
 * links to where it is set (DLV-3); a pack no app release pins says what to do (DLV-4). Content
 * keys moved to their own page (DLV-5).
 */

const FACETS = ["kind", "binding"] as const;

/** The delivery gate, linked to Distribution → Access with this deliverable selected. */
export function GateCell({
  slug,
  d,
  gateKnown,
}: {
  slug: string;
  d: DeliverableDto;
  gateKnown: boolean;
}): React.ReactElement {
  if (!gateKnown) return <span className="text-fg-muted">—</span>;
  const signed = d.kind === "app" ? null : (d.latest?.entitlement ?? null);
  const differs = d.kind !== "app" && d.latest !== null && signed !== d.gate;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Link
        to={productPage(slug, "access", { query: { deliverable: d.id } })}
        className="text-accent-fg underline-offset-4 hover:underline"
      >
        {d.gate ? (
          <span className="font-mono text-xs">{d.gate}</span>
        ) : (
          "Ungated"
        )}
      </Link>
      {differs ? (
        <StatusPill tone="warning">
          Latest signed {signed ? signed : "no gate"}
        </StatusPill>
      ) : null}
    </span>
  );
}

/** How many app releases pin a pack, or the warning (with its next step) that none does. */
export function PinnedCell({ d }: { d: DeliverableDto }): React.ReactElement {
  if (d.pinnedByAppReleases === null)
    return <span className="text-fg-muted">—</span>;
  if (d.pinnedByAppReleases === 0) {
    if (d.binding === "pinned" || d.binding === null)
      return (
        <span className="inline-flex items-center gap-1">
          <StatusPill tone="warning">Not pinned</StatusPill>
          <Popover
            label={`Why ${d.id} ships nothing yet`}
            trigger={
              <button
                type="button"
                className="inline-flex text-fg-muted hover:text-fg-strong"
              >
                <Info aria-hidden className="size-3.5" />
                <span className="sr-only">What to do about {d.id}</span>
              </button>
            }
          >
            <p className="max-w-64 text-xs text-fg">
              A pinned pack reaches devices only through an app release that
              pins one of its releases. Pin it from an app release's manifest,
              or switch the binding to{" "}
              <span className="font-mono">compatible</span>.
            </p>
          </Popover>
        </span>
      );
    return <span className="text-fg-muted">None (resolved sets)</span>;
  }
  return (
    <span>
      {d.pinnedByAppReleases}{" "}
      {d.pinnedByAppReleases === 1 ? "app release" : "app releases"}
    </span>
  );
}

export function DeliverablesPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const query = useDeliverables(slug);
  const [state, setState] = useTableUrlState("deliverables", {
    facets: FACETS,
  });
  useLoadingAnnouncement("deliverables", query.isPending);
  const rows = query.data?.deliverables ?? [];
  const gateKnown = query.data?.gateKnown ?? true;

  const text = (v: string | null, mono = false): React.ReactNode =>
    v === null ? (
      <span className="text-fg-muted">—</span>
    ) : (
      <span className={mono ? "font-mono text-xs" : undefined}>{v}</span>
    );

  const columns: DataColumn<DeliverableDto>[] = [
    {
      id: "id",
      header: "Deliverable",
      accessorKey: "id",
      meta: {
        priority: 1,
        primary: true,
        label: "Deliverable",
        alwaysVisible: true,
      },
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.kind === "app" ? "App" : row.original.id}
        </span>
      ),
    },
    {
      id: "state",
      header: () => <span className="sr-only">Declaration</span>,
      enableSorting: false,
      meta: { priority: 1, label: "Declaration" },
      cell: ({ row }) =>
        row.original.declared ? null : (
          <StatusPill tone="warning" icon={AlertTriangle}>
            Declaration unreadable
          </StatusPill>
        ),
    },
    {
      id: "kind",
      header: "Kind",
      accessorKey: "kind",
      meta: { priority: 2, label: "Kind" },
      cell: ({ row }) => (row.original.kind === "app" ? "App" : "Pack"),
    },
    {
      id: "binding",
      header: "Binding",
      accessorFn: (d) => d.binding ?? "",
      meta: { priority: 2, label: "Binding" },
      cell: ({ row }) =>
        row.original.binding ? (
          label(BINDING_LABELS, row.original.binding)
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      id: "latest",
      header: "Latest",
      accessorFn: (d) => d.latest?.publishedAt ?? 0,
      meta: {
        priority: 1,
        label: "Latest",
        csv: (d) => d.latest?.version ?? "",
      },
      cell: ({ row }) => {
        const l = row.original.latest;
        if (!l) return <span className="text-fg-muted">None yet</span>;
        return (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Version value={l.version} yanked={l.yanked} />
            {l.publishedAt ? (
              <span className="text-xs text-fg-muted">
                <Timestamp at={fromSeconds(l.publishedAt)} />
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "gate",
      header: "Gate",
      accessorFn: (d) => d.gate ?? "",
      meta: { priority: 2, label: "Gate" },
      cell: ({ row }) => (
        <GateCell slug={slug} d={row.original} gateKnown={gateKnown} />
      ),
    },
    {
      id: "pins",
      header: "Pinned by",
      accessorFn: (d) => d.pinnedByAppReleases ?? -1,
      meta: { priority: 2, label: "Pinned by" },
      cell: ({ row }) => <PinnedCell d={row.original} />,
    },
    {
      id: "type",
      header: "Type",
      accessorFn: (d) => d.type ?? "",
      meta: { priority: 3, label: "Type" },
      cell: ({ row }) => text(row.original.type, true),
    },
    {
      id: "required",
      header: "Required",
      accessorFn: (d) =>
        d.required === null ? "" : d.required ? "required" : "optional",
      meta: { priority: 3, label: "Required" },
      cell: ({ row }) =>
        row.original.required === null
          ? text(null)
          : row.original.required
            ? "Required"
            : "Optional",
    },
    {
      id: "baseline",
      header: "Baseline",
      accessorFn: (d) => d.baseline ?? "",
      meta: { priority: 3, label: "Baseline" },
      cell: ({ row }) => text(row.original.baseline),
    },
    {
      id: "delivery",
      header: "Delivery",
      accessorFn: (d) => d.delivery ?? "",
      meta: { priority: 3, label: "Delivery" },
      cell: ({ row }) => text(row.original.delivery),
    },
  ];

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Deliverables"
          titleAside={
            query.data ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {rows.length}
              </span>
            ) : null
          }
          description="The app and every pack the release manifest declares. A pinned pack ships only when an app release pins one of its releases."
          refetching={query.isFetching && !query.isPending}
        />
      }
    >
      <DataTable<DeliverableDto>
        id="deliverables"
        caption="Deliverables"
        data={rows}
        columns={columns}
        getRowId={(d) => d.id}
        rowLabel={(d) => (d.kind === "app" ? "App" : d.id)}
        rowHref={(d) =>
          d.kind === "app" ? r.releases(slug) : r.deliverable(slug, d.id)
        }
        linkComponent={Link}
        state={state}
        onStateChange={setState}
        search={{ placeholder: "Search deliverables", columns: ["id", "type"] }}
        facets={[
          {
            id: "kind",
            label: "Kind",
            options: [
              { value: "app", label: "App" },
              { value: "pack", label: "Pack" },
            ],
          },
          {
            id: "binding",
            label: "Binding",
            options: [
              { value: "pinned", label: "Pinned" },
              { value: "compatible", label: "Compatible" },
              { value: "standalone", label: "Standalone" },
            ],
          },
        ]}
        pagination={{ mode: "client" }}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            title="No deliverables yet"
            description="Declare the app, and any packs, in the product's .pkey/release, then resync."
            docs={docsUrl("packDeliverables")}
          />
        }
      />
      {!gateKnown ? (
        <p className="text-xs text-fg-muted">
          Distribution is off for this product, so delivery gates are not shown.
        </p>
      ) : null}
    </CollectionTemplate>
  );
}
