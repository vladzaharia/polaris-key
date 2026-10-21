import * as React from "react";
import {
  Check,
  Download,
  LayoutGrid,
  Plus,
  Search,
  Table2,
} from "lucide-react";
import { cn } from "../../../../lib/cn.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { label, PROVIDER_LABELS } from "../../../../lib/labels.js";
import {
  DataTable,
  downloadCsv,
  SEARCH_DEBOUNCE_MS,
  tableCsv,
  type DataColumn,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { ActionMenu } from "../../../../ui/ActionMenu.js";
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
import { productPage, r } from "../../../routes.js";
import { readPref, writePref, PREF_KEYS } from "../../../storage.js";
import { useMediaQuery } from "../../../../ui/data-table/DataTable.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { useCanOpenHref, useLandingPage } from "../../../access/context.js";
import { canIn } from "../../../access/can.js";
import { askReason } from "../../../access/useCan.js";
import { useMe } from "../../../data/hooks.js";
import {
  filterHomeRows,
  HOME_FACETS,
  pillLabel,
  runningFeatures,
  worstTone,
  type HomeRow,
} from "../model/home.js";
import { ProductCard, WRAPPING_PILL } from "./ProductCard.js";

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

/** The two facets as toggle chips (the filter's "yes" side), in the toolbar's order. */
const CHIPS = [
  { id: "verified", label: "Integration verified" },
  { id: "attention", label: "Needs attention" },
] as const;

/** One toggle chip: off shows a plus, on a check; the state is `aria-pressed`. */
function FilterChip({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const Icon = on ? Check : Plus;
  return (
    <button
      type="button"
      aria-pressed={on}
      data-filter-chip=""
      onClick={onToggle}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm text-fg-strong pointer-coarse:min-h-11",
        "hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
        on
          ? "border-fg-strong bg-hover font-medium"
          : "border-border-strong bg-transparent",
      )}
    >
      <Icon aria-hidden className="size-3.5 text-fg-muted" />
      {label}
    </button>
  );
}

/** The search field: typing is debounced into the URL state, and Back restores it. */
function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const [local, setLocal] = React.useState(value);
  const pending = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = React.useRef(onChange);
  latest.current = onChange;
  React.useEffect(() => {
    if (pending.current === null) setLocal(value);
  }, [value]);
  React.useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  return (
    <label className="relative flex min-w-[min(12rem,100%)] flex-1 items-center max-sm:basis-full sm:max-w-sm">
      <span className="sr-only">Filter products</span>
      <Search
        aria-hidden
        className="pointer-events-none absolute start-2.5 size-4 text-fg-subtle"
      />
      <input
        type="search"
        value={local}
        placeholder="Filter products"
        onChange={(e) => {
          const v = e.target.value;
          setLocal(v);
          if (pending.current) clearTimeout(pending.current);
          pending.current = setTimeout(() => {
            pending.current = null;
            latest.current(v);
          }, SEARCH_DEBOUNCE_MS);
        }}
        className="h-8 w-full rounded-md border border-border-strong bg-surface-sunken ps-8 pe-2 text-sm text-fg pointer-coarse:h-11"
      />
    </label>
  );
}

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
        <StatusPill
          tone={worstTone(row.original.attention)}
          size="sm"
          className={WRAPPING_PILL}
        >
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
  const [chosenView, setView] = React.useState<View>(() =>
    readPref(PREF_KEYS.homeView, parseView, "cards"),
  );
  // On a phone the Table is the Cards in a frame: one list of rows, so no choice and no switch.
  const phone = useMediaQuery("(max-width: 639px)");
  const view: View = phone ? "cards" : chosenView;
  const [state, setState] = useTableUrlState("products", {
    facets: HOME_FACETS,
  });
  const canOpenHref = useCanOpenHref();
  const landing = useLandingPage();
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
  // ST-29: deleting is the Settings area's, as in the product's own danger zone. A row menu has
  // no hook per row, so the gate reads the session's permissions.
  const me = useMe().data;
  const deleteReason = (row: HomeRow): string | undefined =>
    !me || canIn(me, "settings", row.slug, "edit")
      ? undefined
      : askReason(
          "settings",
          undefined,
          canIn(me, "settings", row.slug, "view"),
        );
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
      disabledReason: deleteReason(row),
      onSelect: () => setDeleting(row),
    },
  ];

  const filters = many ? (
    <div
      role="search"
      aria-label="Product filters"
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
    >
      <SearchField
        value={state.q}
        onChange={(q) => setState({ ...state, q, offset: 0 })}
      />
      {CHIPS.filter((c) => c.id !== "attention" || attentionKnown).map((c) => {
        const on = (state.filters[c.id] ?? []).includes("yes");
        return (
          <FilterChip
            key={c.id}
            label={c.label}
            on={on}
            onToggle={() =>
              setState({
                ...state,
                offset: 0,
                filters: { ...state.filters, [c.id]: on ? [] : ["yes"] },
              })
            }
          />
        );
      })}
      {filtering && filtered.length > 0 ? (
        <Button
          variant="link"
          size="sm"
          className="min-h-6"
          onClick={() => setState({ ...state, q: "", filters: {}, offset: 0 })}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h2
            id={headingId}
            tabIndex={-1}
            data-products-heading=""
            className="text-lg font-semibold leading-6 text-fg-strong outline-hidden forced-colors:outline-none"
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
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            {phone ? null : (
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
            )}
            <ActionMenu
              label="More product actions"
              items={[
                {
                  label: "Export CSV",
                  icon: <Download />,
                  disabledReason:
                    filtered.length === 0
                      ? "No products to export."
                      : undefined,
                  onSelect: () =>
                    downloadCsv("products.csv", tableCsv(filtered, COLUMNS)),
                },
              ]}
            />
          </div>
        ) : null}
      </div>
      {many && view === "cards" ? filters : null}
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
          rowHref={(row) =>
            productPage(
              row.slug,
              landing(row.slug, row.product.services ?? null),
            )
          }
          linkComponent={Link}
          rowActions={rowActions}
          state={state}
          onStateChange={setState}
          loading={false}
          exportCsv={false}
          toolbarLead={filters}
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
