import * as React from "react";
import { docsUrl } from "../../../../lib/docsLinks.js";
import {
  Check,
  EyeOff,
  History,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import { inAppLabel, inAppState, typeLabel } from "../../../../lib/labels.js";
import {
  KIND_TONE,
  UNCATEGORISED,
  categoryLabel,
  formatValue,
} from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import {
  DataTable,
  type DataColumn,
  type Facet,
} from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { useResyncFlow } from "../../../components/ResyncDialog.js";
import { RevertClaimDialog } from "../../../components/RevertClaimDialog.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useProduct } from "../../../data/hooks.js";
import {
  codecs,
  Link,
  navigate,
  useLocation,
  useSearchParam,
} from "../../../router.js";
import { r, withParam } from "../../../routes.js";
import {
  ENTRY_TYPE_LABELS,
  entryType,
  type EntryType,
} from "../components/entryType.js";
import { RetiredMark } from "../components/EntryMarks.js";
import { defaultText } from "../model/entryNotes.js";
import { invalidResync } from "../model/syncProblems.js";
import { EditCatalogButton } from "../components/CatalogViewOnly.js";
import { HistoryDrawer } from "../components/HistoryDrawer.js";
import { KeyDrawer } from "../components/KeyDrawer.js";
import { RecipePill } from "../components/RecipeState.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import {
  CATALOG_PATH,
  catalogSource,
  isNotFound,
  useCatalog,
} from "../data.js";

const KEY = codecs.string();
const VERSION = codecs.int(0);

/** The facet value of the In the app column: a setting's visibility, else `code`. */
const stateOf = (e: ConfigEntry): string => inAppState(e);

const STATE_ICON = { enforced: Lock, hidden: EyeOff, default: Pencil } as const;

/**
 * Config → Catalog (docs/design/ADMIN.md §6.6.1, T2): the active catalog as a dense table with
 * search and kind, category and management facets (CAT-7), its ownership in the header (CAT-3),
 * a key drawer with "Overridden by" (A-7b), and version history with a diff against the active
 * version (A-6, CAT-8). With no catalog yet, "Create catalog" opens the editor (CAT-1).
 */
export function CatalogPage({ slug }: { slug: string }): React.ReactElement {
  const catalog = useCatalog(slug);
  const { data: product } = useProduct(slug);
  const source = catalogSource(product);
  // ST-01b: a claimed catalog on a repo-linked product can be handed back to `.pkey/schema`.
  const revertable = source === "admin" && product?.releaseSource === "github";
  const [reverting, setReverting] = React.useState(false);
  const [state, setState] = useTableUrlState("catalog", {
    facets: ["kind", "category", "state"],
  });
  const [openKey, setOpenKey] = useSearchParam("key", KEY);
  const [history, setHistory] = useSearchParam("history", codecs.string());
  const { route } = useLocation();

  const entries = React.useMemo(
    () => catalog.data?.entries ?? [],
    [catalog.data],
  );
  const resync = useResyncFlow();
  const invalid = React.useMemo(
    () => invalidResync(product?.sync, entries),
    [product?.sync, entries],
  );
  const badKeys = React.useMemo(
    () => new Set(invalid?.problems.flatMap((p) => (p.key ? [p.key] : []))),
    [invalid],
  );

  const keyHref = React.useCallback(
    (key: string) => {
      const q = withParam(route.query, "key", KEY, key).toString();
      return `${r.catalog(slug)}${q ? `?${q}` : ""}`;
    },
    [route.query, slug],
  );

  const columns = React.useMemo<DataColumn<ConfigEntry>[]>(
    () => [
      {
        id: "key",
        header: "Key",
        accessorFn: (e) => `${e.key} ${e.label} ${e.description ?? ""}`,
        meta: {
          priority: 1,
          primary: true,
          label: "Key",
          csv: (e) => e.key,
          alwaysVisible: true,
        },
        cell: ({ row }) => (
          <span
            className="flex min-w-0 max-w-[22rem] flex-col"
            title={row.original.key}
          >
            <span className="flex items-center gap-1 truncate font-mono text-xs text-fg-strong">
              {row.original.key}
              <RetiredMark entry={row.original} />
              {badKeys.has(row.original.key) ? (
                <span className="text-danger">
                  <XCircle aria-hidden className="size-3.5 shrink-0" />
                  <span className="sr-only">
                    The last resync reported an error here
                  </span>
                </span>
              ) : null}
            </span>
            <span className="flex items-center gap-2 text-xs font-normal text-fg-muted">
              <span className="truncate">{row.original.label}</span>
              <RecipePill slug={slug} entry={row.original} />
            </span>
          </span>
        ),
      },
      {
        id: "kind",
        header: "Type",
        accessorFn: (e) => entryType(e),
        meta: { priority: 1, csv: (e) => typeLabel(e) },
        cell: ({ row }) => (
          <StatusPill tone={KIND_TONE[row.original.kind]} icon={null} size="sm">
            {typeLabel(row.original)}
          </StatusPill>
        ),
      },
      {
        id: "default",
        header: "Default",
        accessorFn: (e) => defaultText(e) ?? formatValue(e.default),
        meta: { priority: 2, mono: true },
        cell: ({ row }) =>
          defaultText(row.original) ? (
            <span className="text-fg-muted">{defaultText(row.original)}</span>
          ) : (
            <span className="block max-w-56 truncate font-mono text-xs">
              {formatValue(row.original.default)}
            </span>
          ),
      },
      {
        id: "state",
        header: "In the app",
        accessorFn: stateOf,
        meta: { priority: 1, csv: (e) => inAppLabel(e) },
        cell: ({ row }) => {
          const state = stateOf(row.original);
          if (state === "code")
            return (
              <span className="text-fg-muted" title={inAppLabel(row.original)}>
                <span aria-hidden>—</span>
                <span className="sr-only">{inAppLabel(row.original)}</span>
              </span>
            );
          const Icon = STATE_ICON[state as keyof typeof STATE_ICON];
          return (
            <span className="inline-flex items-center gap-1.5 text-fg">
              <Icon aria-hidden className="size-3.5 text-fg-muted" />
              {inAppLabel(row.original)}
            </span>
          );
        },
      },
      {
        id: "category",
        header: "Category",
        accessorFn: (e) => categoryLabel(e.category || UNCATEGORISED),
        meta: { priority: 2 },
      },
      {
        id: "userGrant",
        header: "Given to user",
        accessorFn: (e) => (e.userGrant ? "yes" : "no"),
        meta: { priority: 3, align: "center" },
        cell: ({ row }) =>
          row.original.userGrant ? (
            <>
              <Check aria-hidden className="mx-auto size-4 text-success" />
              <span className="sr-only">Yes</span>
            </>
          ) : (
            <span className="text-fg-muted">
              <span aria-hidden>—</span>
              <span className="sr-only">No</span>
            </span>
          ),
      },
    ],
    [badKeys],
  );

  const facets = React.useMemo<Facet<ConfigEntry>[]>(() => {
    const categories = [
      ...new Set(entries.map((e) => e.category || UNCATEGORISED)),
    ].sort();
    return [
      {
        id: "kind",
        label: "Type",
        options: (
          [
            "setting",
            "secret",
            "minted",
            ...(entries.some((e) => e.kind === "flag") ? ["flag"] : []),
          ] as EntryType[]
        ).map((k) => ({ value: k, label: ENTRY_TYPE_LABELS[k] })),
      },
      {
        id: "category",
        label: "Category",
        options: categories.map((c) => ({ value: c, label: c })),
      },
      {
        id: "state",
        label: "In the app",
        options: (["default", "enforced", "hidden", "code"] as const).map(
          (s) => ({
            value: s,
            label:
              s === "code"
                ? "Code only"
                : inAppLabel({ kind: "config", managementDefault: s }),
          }),
        ),
      },
    ];
  }, [entries]);

  const noCatalog = isNotFound(catalog.error);

  if (catalog.isPending && !catalog.data)
    return <PageSkeleton template="table" label="the catalog" />;

  const header = (
    <PageHeader
      title="Catalog"
      titleAside={
        catalog.data ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusPill tone="neutral" icon={false} size="sm">
              v{catalog.data.schemaVersion}
            </StatusPill>
            <span className="text-sm text-fg-muted">
              {entries.length} {entries.length === 1 ? "key" : "keys"}
            </span>
            <SourceBadge
              source={source}
              path={CATALOG_PATH}
              onRevert={revertable ? () => setReverting(true) : undefined}
            />
            {reverting ? (
              <RevertClaimDialog
                slug={slug}
                claim="config.catalog"
                onOpenChange={setReverting}
              />
            ) : null}
          </span>
        ) : null
      }
      refetching={catalog.isFetching && !catalog.isPending}
      primaryAction={catalog.data ? <EditCatalogButton slug={slug} /> : null}
      secondaryActions={
        catalog.data
          ? [
              {
                label: "Version history",
                icon: <History aria-hidden />,
                onSelect: () => setHistory("open"),
              },
            ]
          : []
      }
    />
  );

  if (catalog.error && !noCatalog) {
    return (
      <CollectionTemplate header={header}>
        <ErrorState
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
          context={{ thing: "Catalog" }}
        />
      </CollectionTemplate>
    );
  }

  if (noCatalog) {
    return (
      <CollectionTemplate header={header}>
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title="No catalog yet"
          description="A catalog declares the settings, secrets and minted tokens this product exposes. Create the first version here, or add .pkey/schema to the product's repository."
          docs={docsUrl("publishCatalog")}
          primaryAction={
            <Button
              iconStart={<Plus aria-hidden />}
              onClick={() => navigate(r.catalogEdit(slug))}
            >
              Create catalog
            </Button>
          }
        />
      </CollectionTemplate>
    );
  }

  const open = entries.find((e) => e.key === openKey) ?? null;

  return (
    <CollectionTemplate header={header}>
      {invalid && product ? (
        <Callout
          tone="danger"
          alert
          title={`Resync${invalid.commit ? ` from ${invalid.commit.slice(0, 7)}` : ""} failed: ${invalid.problems.length} ${invalid.problems.length === 1 ? "error" : "errors"} in ${CATALOG_PATH}`}
          action={
            <Button
              size="sm"
              variant="outline"
              iconStart={<RefreshCw aria-hidden />}
              onClick={() => resync.start({ slug, name: product.name })}
            >
              Resync
            </Button>
          }
        >
          <p>
            Devices still get v{catalog.data!.schemaVersion}. Fix them in the
            repository, then push or resync.
          </p>
          <ul className="mt-2 space-y-1">
            {invalid.problems.map((p, i) => (
              <li key={i}>
                {p.key ? (
                  <code className="font-mono text-xs">{p.key}</code>
                ) : p.index !== null ? (
                  <span>Entry {p.index + 1}</span>
                ) : null}
                {p.key || p.index !== null ? ": " : null}
                {p.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {resync.panel}
      {resync.dialog}
      <DataTable<ConfigEntry>
        id="catalog"
        caption="Catalog keys"
        mobile="cards"
        data={entries}
        columns={columns}
        getRowId={(e) => e.key}
        rowLabel={(e) => e.key}
        rowHref={(e) => keyHref(e.key)}
        linkComponent={Link}
        facets={facets}
        search={{
          placeholder: "Search key, label, description…",
          columns: ["key"],
        }}
        state={state}
        onStateChange={setState}
        empty={
          <EmptyState
            kind="first-run"
            title="This catalog has no keys"
            description="Edit the catalog to add the first setting, secret or minted token."
            primaryAction={<EditCatalogButton slug={slug} icon={false} />}
          />
        }
      />
      <KeyDrawer slug={slug} entry={open} onClose={() => setOpenKey("")} />
      <HistoryDrawer
        slug={slug}
        open={history === "open"}
        active={catalog.data!}
        onClose={() => setHistory("")}
      />
    </CollectionTemplate>
  );
}
