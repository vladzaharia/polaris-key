import * as React from "react";
import { Plus } from "lucide-react";
import type { ProductDetail } from "../../../api.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatCount, fromSeconds } from "../../../lib/format.js";
import { label, PROVIDER_LABELS } from "../../../lib/labels.js";
import { releaseSourceOf } from "../../../lib/products.js";
import { Button } from "../../../ui/Button.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import {
  DataTable,
  type DataColumn,
  type Facet,
  type RowActionItem,
} from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ServiceGlyph } from "../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { DeleteProductDialog } from "../../components/DeleteProductDialog.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProducts } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { Link, navigate } from "../../router.js";
import { r } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { attentionFor } from "./attention.js";
import { runningServices, runsSentence } from "./Home.js";

/** A registry row with what the table derives from it. */
interface ProductRow {
  product: ProductDetail;
  slug: string;
  name: string;
  source: "github" | "manual";
  /** `complete` or `attention`: the setup facet. */
  setup: "complete" | "attention";
  attention: number;
}

const FACETS = ["setup", "source"] as const;

const SOURCE_FACET: Facet<ProductRow> = {
  id: "source",
  label: "Source",
  options: [
    { value: "github", label: "GitHub" },
    { value: "manual", label: "Manual" },
  ],
  accessor: (row) => row.source,
};

const SETUP_FACET: Facet<ProductRow> = {
  id: "setup",
  label: "Setup",
  options: [
    { value: "complete", label: "Setup complete" },
    { value: "attention", label: "Needs attention" },
  ],
  accessor: (row) => row.setup,
};

function toRow(p: ProductDetail): ProductRow {
  const attention = attentionFor(p).length;
  return {
    product: p,
    slug: p.slug,
    name: p.name || p.slug,
    source: releaseSourceOf(p),
    setup: attention > 0 ? "attention" : "complete",
    attention,
  };
}

/** An epoch-seconds instant, or a dash when the row has none. */
function When({ seconds }: { seconds: number | undefined }): React.ReactNode {
  return Number.isFinite(seconds) ? (
    <Timestamp at={fromSeconds(seconds!)} />
  ) : (
    "—"
  );
}

const COLUMNS: DataColumn<ProductRow>[] = [
  {
    id: "name",
    header: "Product",
    accessorKey: "name",
    meta: { priority: 1, primary: true, alwaysVisible: true },
  },
  {
    id: "slug",
    header: "Slug",
    accessorKey: "slug",
    meta: { priority: 1, mono: true },
  },
  {
    id: "services",
    header: "Services",
    accessorFn: (row) => runningServices(row.product).length,
    enableSorting: false,
    meta: {
      priority: 2,
      csv: (row) => runningServices(row.product).join(" "),
    },
    cell: ({ row }) => {
      const services = runningServices(row.original.product);
      return (
        <span className="inline-flex items-center gap-1.5">
          {services.map((s) => (
            <ServiceGlyph key={s} id={s} />
          ))}
          <span
            className={services.length ? "sr-only" : "text-xs text-fg-muted"}
          >
            {runsSentence(services)}
          </span>
        </span>
      );
    },
  },
  {
    id: "setup",
    header: "Setup",
    accessorKey: "attention",
    meta: { priority: 1, csv: (row) => row.setup },
    cell: ({ row }) =>
      row.original.attention > 0 ? (
        <StatusPill tone="warning" size="sm">
          {row.original.attention === 1
            ? "1 needs attention"
            : `${row.original.attention} need attention`}
        </StatusPill>
      ) : (
        <StatusPill tone="success" size="sm">
          Setup complete
        </StatusPill>
      ),
  },
  {
    id: "source",
    header: "Source",
    accessorKey: "source",
    meta: { priority: 2 },
    cell: ({ row }) => label(PROVIDER_LABELS, row.original.source),
  },
  {
    id: "modified",
    header: "Changed",
    accessorFn: (row) => row.product.modifiedAt,
    meta: { priority: 2 },
    cell: ({ row }) => <When seconds={row.original.product.modifiedAt} />,
  },
  {
    id: "created",
    header: "Created",
    accessorFn: (row) => row.product.createdAt,
    meta: { priority: 3 },
    cell: ({ row }) => <When seconds={row.original.product.createdAt} />,
  },
];

/**
 * Products (ADMIN.md §2.3, T2): the platform registry. Fixes PRD-1 to PRD-5 and PRD-10 to PRD-12:
 *
 * - The product name is a real link to its Overview, and a click anywhere on the row follows it
 *   (owner, 2026-10-03): never `licenses`, a service that may be off (PRD-1), and no
 *   `role=button` row wrapping the action menu (PRD-2).
 * - One verb, "Delete product", with the slug typed and sent as `confirmSlug` (PRD-3, PRD-4).
 * - No second copy of per-product forms (PRD-5): Edit, Set secret and Prepare signing key are
 *   links to the product's own Settings and Keys & secrets, where the one validated form lives.
 * - Services and setup are columns, the table's search, facets and sort are in the URL, and
 *   phones get cards (PRD-11). Errors read through `errorCopy`, in the table and in the confirm
 *   dialogs (PRD-12); a pending confirm cannot be dismissed or submitted twice (PRD-10).
 *
 * One fetcher per query key: the list reads through `useProducts` (`fetchProducts`), the same
 * entry the shell's product switcher reads (`test/queryKeyShapes.test.ts`).
 */
export function Products(): React.ReactElement {
  const products = useProducts();
  const [state, setState] = useTableUrlState("products", { facets: FACETS });
  const [resyncing, setResyncing] = React.useState<ProductRow | null>(null);
  const [deleting, setDeleting] = React.useState<ProductRow | null>(null);

  const rows = React.useMemo(
    () => (products.data ?? []).map(toRow),
    [products.data],
  );
  const resync = confirmFor("repo.resync");

  const rowActions = (row: ProductRow): RowActionItem[] => [
    { label: "Open overview", onSelect: () => navigate(r.overview(row.slug)) },
    { label: "Open settings", onSelect: () => navigate(r.settings(row.slug)) },
    {
      label: "Open keys & secrets",
      onSelect: () => navigate(r.keys(row.slug)),
    },
    ...(row.source === "github"
      ? [{ label: "Resync from repo…", onSelect: () => setResyncing(row) }]
      : []),
    { type: "separator" },
    {
      label: "Delete product…",
      tone: "danger",
      onSelect: () => setDeleting(row),
    },
  ];

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Products"
          titleAside={
            products.data ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {formatCount(products.data.length)}
              </span>
            ) : null
          }
          refetching={products.isFetching && !products.isPending}
          primaryAction={
            <Button asChild>
              <Link to={r.productNew()}>
                <Plus aria-hidden />
                New product
              </Link>
            </Button>
          }
        />
      }
    >
      <DataTable<ProductRow>
        id="products"
        caption="Products"
        data={rows}
        columns={COLUMNS}
        getRowId={(row) => row.slug}
        rowLabel={(row) => row.name}
        rowHref={(row) => r.overview(row.slug)}
        linkComponent={Link}
        rowActions={rowActions}
        facets={[SETUP_FACET, SOURCE_FACET]}
        search={{
          placeholder: "Search name or slug",
          columns: ["name", "slug"],
        }}
        state={state}
        onStateChange={setState}
        loading={products.isPending}
        error={products.isError && !products.data ? products.error : undefined}
        onRetry={() => void products.refetch()}
        empty={
          <EmptyState
            kind="first-run"
            title="No products yet"
            description="A product is one app or game: its licenses, config, releases and delivery. Link a repository with a .pkey/ directory, or start manually."
            primaryAction={
              <Button asChild>
                <Link to={r.productNew({ via: "github" })}>
                  Link a repository
                </Link>
              </Button>
            }
            secondaryAction={
              <Button variant="outline" asChild>
                <Link to={r.productNew({ via: "manual" })}>Start manually</Link>
              </Button>
            }
            docs="/docs/admin/products/"
          />
        }
        mobile="cards"
      />

      <ConfirmDialog
        open={resyncing !== null}
        onOpenChange={(o) => !o && setResyncing(null)}
        intent={resync.intent === "none" ? "caution" : resync.intent}
        title={`Resync ${resyncing?.name ?? ""} from its repository?`}
        description="Reads .pkey/ from the linked repository's default branch and re-applies it."
        consequences={[
          "Product metadata, catalog, tiers, profiles and sign-in settings follow the manifest.",
          "Services and enrollment policies you changed in the console keep your values.",
          "The release store re-syncs in the same step.",
        ]}
        confirmLabel="Resync from repo"
        describeError={(e) => errorCopy(e, { thing: "Product" })}
        onConfirm={async () => {
          if (!resyncing) return;
          await mutate("resyncProduct", resyncing.slug);
          toast.success("Resynced from repo", {
            description: `${resyncing.name} matches its repository's default branch.`,
          });
        }}
      />

      <DeleteProductDialog
        product={deleting}
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </CollectionTemplate>
  );
}
