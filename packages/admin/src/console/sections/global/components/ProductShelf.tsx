import * as React from "react";
import { Download, LayoutGrid, Table2 } from "lucide-react";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { label, PROVIDER_LABELS } from "../../../../lib/labels.js";
import {
  DataTable,
  downloadCsv,
  FilterBar,
  tableCsv,
  type DataColumn,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { DeleteProductDialog } from "../../../components/DeleteProductDialog.js";
import { useResyncFlow } from "../../../components/ResyncDialog.js";
import { navigate, Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { readPref, writePref, PREF_KEYS } from "../../../storage.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { useCanOpenHref } from "../../../access/context.js";
import {
  filterHomeRows,
  HOME_FACETS,
  pillLabel,
  runningFeatures,
  worstTone,
  type HomeRow,
} from "../model/home.js";
import { ProductCard } from "./ProductCard.js";

type View = "cards" | "table";

const parseView = (raw: unknown): View | undefined =>
  raw === "cards" || raw === "table" ? raw : undefined;

const VIEW_OPTIONS = [
  {
    value: "cards" as const,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <LayoutGrid aria-hidden className="size-3.5" />
        Cards
      </span>
    ),
  },
  {
    value: "table" as const,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Table2 aria-hidden className="size-3.5" />
        Table
      </span>
    ),
  },
];

const FACET_LABELS = [
  {
    id: "verified",
    label: "Integration",
    options: [
      { value: "yes", label: "Verified" },
      { value: "no", label: "Not verified" },
    ],
  },
  {
    id: "attention",
    label: "Attention",
    options: [
      { value: "yes", label: "Needs attention" },
      { value: "no", label: "Healthy" },
    ],
  },
] as const;

/** An epoch-seconds instant, or a dash when the row has none. */
function When({ seconds }: { seconds: number | undefined }): React.ReactNode {
  return Number.isFinite(seconds) ? (
    <Timestamp at={fromSeconds(seconds!)} />
  ) : (
    "—"
  );
}

const COLUMNS: DataColumn<HomeRow>[] = [
  {
    id: "name",
    header: "Product",
    accessorKey: "name",
    meta: { priority: 1, primary: true, alwaysVisible: true },
    cell: ({ row }) => (
      <span className="flex min-w-0 items-center gap-2">
        <ProductLogo
          name={row.original.name}
          presentation={row.original.product.presentation}
          size={24}
        />
        <span className="min-w-0">
          <span className="block break-words">{row.original.name}</span>
          <span
            aria-hidden
            className="block break-all font-mono text-xs text-fg-muted"
          >
            {row.original.slug}
          </span>
        </span>
      </span>
    ),
  },
  {
    id: "slug",
    header: "Slug",
    accessorKey: "slug",
    meta: {
      defaultHidden: true,
      priority: 3,
      mono: true,
    },
  },
  {
    id: "features",
    header: "Features",
    accessorFn: (row) => runningFeatures(row.product).length,
    enableSorting: false,
    meta: {
      priority: 2,
      csv: (row) =>
        runningFeatures(row.product)
          .map((f) => f.label)
          .join(" "),
    },
    cell: ({ row }) => {
      const features = runningFeatures(row.original.product);
      return (
        <span className="inline-flex items-center gap-1.5">
          {features.map((f) => (
            <ServiceGlyph key={f.id} id={f.accent} />
          ))}
          <span
            className={features.length ? "sr-only" : "text-xs text-fg-muted"}
          >
            {features.length
              ? features.map((f) => f.label).join(", ")
              : "No features"}
          </span>
        </span>
      );
    },
  },
  {
    id: "source",
    header: "Source",
    accessorKey: "source",
    meta: { defaultHidden: true, priority: 3 },
    cell: ({ row }) => label(PROVIDER_LABELS, row.original.source),
  },
  {
    id: "modified",
    header: "Changed",
    accessorFn: (row) => row.product.modifiedAt,
    meta: { defaultHidden: true, numeric: true, priority: 2 },
    cell: ({ row }) => <When seconds={row.original.product.modifiedAt} />,
  },
  {
    id: "created",
    header: "Created",
    accessorFn: (row) => row.product.createdAt,
    meta: { defaultHidden: true, numeric: true, priority: 3 },
    cell: ({ row }) => <When seconds={row.original.product.createdAt} />,
  },
  // Last, flush right: a product that needs something shows the one pill; a healthy one nothing.
  {
    id: "attention",
    header: "Attention",
    accessorFn: (row) => row.attention.length,
    meta: {
      priority: 1,
      align: "end",
      csv: (row) => (row.attention.length ? "needs attention" : "healthy"),
      quiet: (row) => row.attention.length === 0,
    },
    cell: ({ row }) =>
      row.original.attention.length > 0 ? (
        <StatusPill tone={worstTone(row.original.attention)} size="sm">
          {pillLabel(row.original.attention)}
        </StatusPill>
      ) : (
        <span className="sr-only">Healthy</span>
      ),
  },
];

/**
 * Home's products (ST-44): the whole registry as cards (default) or a table, one filter bar
 * (search, Integration verified, Needs attention) over both, the choice kept per viewer. The
 * filters live in the URL, so a filtered Home is a link.
 */
export function ProductShelf({
  rows,
  loading,
  attentionKnown,
}: {
  rows: HomeRow[];
  loading: boolean;
  /** The attention read answered: until it has, the Attention facet is not offered. */
  attentionKnown: boolean;
}): React.ReactElement {
  const [view, setView] = React.useState<View>(() =>
    readPref(PREF_KEYS.homeView, parseView, "cards"),
  );
  const [state, setState] = useTableUrlState("products", {
    facets: HOME_FACETS,
  });
  const canOpenHref = useCanOpenHref();
  const filtered = React.useMemo(
    () =>
      filterHomeRows(
        rows,
        state.q,
        // Until attention is known a stale `attention=` filter would hide every product.
        attentionKnown ? state.filters : { ...state.filters, attention: [] },
      ),
    [rows, state.q, state.filters, attentionKnown],
  );
  const filtering =
    state.q.trim() !== "" || Object.keys(state.filters).length > 0;
  const headingId = React.useId();
  const sectionRef = React.useRef<HTMLElement>(null);
  // One product needs no filters or second view: the toolbar appears from the second.
  const many = rows.length > 1;
  // The console's one resync flow (UX-78) and the one delete dialog, as the retired Products page
  // held them: a table row's menu is where a product is resynced or deleted.
  const resync = useResyncFlow();
  const [deleting, setDeleting] = React.useState<HomeRow | null>(null);
  const rowActions = (row: HomeRow): RowActionItem[] => [
    ...[
      { label: "Open overview", href: r.overview(row.slug) },
      { label: "Open settings", href: r.settings(row.slug) },
      { label: "Open keys & secrets", href: r.keys(row.slug) },
    ]
      .filter((a) => canOpenHref(a.href))
      .map((a) => ({ label: a.label, onSelect: () => navigate(a.href) })),
    ...(row.source === "github"
      ? [
          {
            label: "Resync from repo…",
            onSelect: () => resync.start({ slug: row.slug, name: row.name }),
          },
        ]
      : []),
    { type: "separator" as const },
    {
      label: "Delete product…",
      tone: "danger" as const,
      onSelect: () => setDeleting(row),
    },
  ];

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h2
            id={headingId}
            className="text-lg font-semibold leading-6 text-fg-strong"
          >
            Products
          </h2>
          {!loading ? (
            <span className="text-sm tabular-nums text-fg-muted">
              {formatCount(rows.length)}
              <span className="sr-only">
                {rows.length === 1 ? " product" : " products"}
              </span>
            </span>
          ) : null}
        </div>
        {many ? (
          <SegmentedControl
            size="sm"
            aria-label="View"
            options={VIEW_OPTIONS}
            value={view}
            onChange={(v) => {
              setView(v);
              writePref(PREF_KEYS.homeView, v);
            }}
          />
        ) : null}
      </div>
      {many ? (
        <FilterBar
          stackSearch
          search={{
            value: state.q,
            onChange: (q) => setState({ ...state, q, offset: 0 }),
            placeholder: "Filter products",
          }}
          facets={FACET_LABELS.filter(
            (f) => f.id !== "attention" || attentionKnown,
          ).map((f) => ({
            id: f.id,
            label: f.label,
            options: [...f.options],
            selected: state.filters[f.id] ?? [],
            onChange: (next) =>
              setState({
                ...state,
                offset: 0,
                filters: { ...state.filters, [f.id]: next },
              }),
          }))}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadCsv("products.csv", tableCsv(filtered, COLUMNS))
              }
            >
              <Download aria-hidden />
              Export CSV
            </Button>
          }
          onClearAll={
            filtering
              ? () => setState({ ...state, q: "", filters: {}, offset: 0 })
              : undefined
          }
        />
      ) : null}
      {loading ? (
        <ul
          aria-label="Products"
          aria-busy
          className="pk-skeleton-group grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))]"
        >
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="pk-skeleton h-44 rounded-lg border border-border max-sm:h-12"
            />
          ))}
        </ul>
      ) : filtered.length === 0 ? (
        <EmptyState
          kind="no-results"
          title="No products match"
          onClearFilters={() => {
            setState({ ...state, q: "", filters: {}, offset: 0 });
            // The cleared field is where the operator goes on: focus it.
            sectionRef.current
              ?.querySelector<HTMLInputElement>('input[type="search"], input')
              ?.focus();
          }}
        />
      ) : view === "cards" ? (
        <ul
          aria-label="Products"
          className="grid grid-cols-1 gap-3 sm:gap-4 sm:grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))]"
        >
          {filtered.map((row) => (
            <li key={row.slug} className="flex min-w-0">
              <ProductCard product={row.product} attention={row.attention} />
            </li>
          ))}
        </ul>
      ) : (
        <DataTable<HomeRow>
          id="products"
          caption="Products"
          data={filtered}
          columns={COLUMNS}
          getRowId={(row) => row.slug}
          rowLabel={(row) => row.name}
          rowHref={(row) => r.overview(row.slug)}
          linkComponent={Link}
          rowActions={rowActions}
          state={state}
          onStateChange={setState}
          loading={false}
          exportCsv={false}
          mobile="cards"
        />
      )}
      {resync.panel}
      {resync.dialog}
      <DeleteProductDialog
        product={deleting}
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </section>
  );
}
