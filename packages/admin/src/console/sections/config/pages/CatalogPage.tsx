import * as React from "react";
import { Check, EyeOff, History, Lock, Pencil, Plus } from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import { inAppLabel, inAppState, typeLabel } from "../../../../lib/labels.js";
import {
  KIND_TONE,
  UNCATEGORISED,
  categoryLabel,
  formatValue,
  schemaSummary,
} from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import {
  DataTable,
  type DataColumn,
  type Facet,
} from "../../../../ui/data-table/index.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { DiffViewer } from "../../../../ui/DiffViewer.js";
import { Drawer, DrawerBody } from "../../../../ui/Drawer.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { EntityLink } from "../../../components/EntityLink.js";
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
import { defaultText, retiredNotes } from "../model/entryNotes.js";
import { EditCatalogButton } from "../components/CatalogViewOnly.js";
import { HistoryDrawer } from "../components/HistoryDrawer.js";
import { RecipeApproval, RecipePill } from "../components/RecipeState.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import {
  CATALOG_PATH,
  catalogSource,
  isNotFound,
  useCatalog,
  useCatalogUsage,
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
    [],
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

  if (catalog.isPending && !catalog.data) {
    return <PageSkeleton template="table" label="the catalog" />;
  }

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
          docs="/docs/services/config/catalog/"
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

// ── the key drawer ─────────────────────────────────────────────────────────────────────────────

function KeyDrawer({
  slug,
  entry,
  onClose,
}: {
  slug: string;
  entry: ConfigEntry | null;
  onClose: () => void;
}): React.ReactElement {
  const usage = useCatalogUsage(slug, entry ? [entry.key] : []);
  const used = entry ? usage.data?.keys[entry.key] : undefined;
  const ui = entry?.ui;
  return (
    <Drawer
      open={entry !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="lg"
      title={entry?.label ?? "Key"}
      description={
        entry ? <code className="font-mono text-xs">{entry.key}</code> : null
      }
    >
      {entry ? (
        <DrawerBody>
          <div className="space-y-6">
            {entry.description ? (
              <p className="text-sm text-fg">{entry.description}</p>
            ) : null}
            <RecipeApproval slug={slug} entry={entry} />
            <DescriptionList
              columns={2}
              items={[
                {
                  term: "Type",
                  detail: typeLabel(entry),
                },
                {
                  term: "Category",
                  detail: categoryLabel(entry.category || UNCATEGORISED),
                },
                { term: "Schema", detail: schemaSummary(entry.schema) },
                {
                  term: "Default",
                  detail:
                    defaultText(entry) ??
                    `${formatValue(entry.default)}${ui?.unit && entry.default !== undefined ? ` ${ui.unit}` : ""}`,
                },
                // Only the fields that apply to this kind of key.
                ...(entry.kind !== "flag"
                  ? [{ term: "In the app", detail: inAppLabel(entry) }]
                  : []),
                ...(entry.kind === "flag"
                  ? [
                      {
                        term: "Given to user",
                        detail: entry.userGrant
                          ? (entry.grantLabel ?? "Yes")
                          : "No",
                      },
                    ]
                  : []),
                ...(entry.accessor
                  ? [{ term: "Accessor", detail: entry.accessor }]
                  : []),
                ...(retiredNotes(entry).length
                  ? [
                      {
                        term: "Retired",
                        detail: (
                          <ul className="space-y-1 text-warning">
                            {retiredNotes(entry).map((n) => (
                              <li key={n}>{n}</li>
                            ))}
                          </ul>
                        ),
                      },
                    ]
                  : []),
                ...(entry.dependsOn
                  ? [
                      {
                        term: "Shown when",
                        detail: `${entry.dependsOn.key} = ${formatValue(entry.dependsOn.equals)}`,
                      },
                    ]
                  : []),
                ...(entry.appliesTo
                  ? [
                      {
                        term: "Applies to",
                        detail: ([] as string[])
                          .concat(entry.appliesTo as string | string[])
                          .join(", "),
                      },
                    ]
                  : []),
                ...(ui?.widget ? [{ term: "Widget", detail: ui.widget }] : []),
                ...(ui?.help ? [{ term: "Help", detail: ui.help }] : []),
                ...(ui?.advanced
                  ? [{ term: "Shown under", detail: "More settings" }]
                  : []),
              ]}
            />
            <CodeBlock
              code={JSON.stringify(entry.schema, null, 2)}
              language="json"
              filename="Schema"
            />
            <section className="space-y-2" aria-labelledby="overridden-by">
              <h3
                id="overridden-by"
                className="text-sm font-medium text-fg-strong"
              >
                Overridden by
              </h3>
              {usage.isPending ? (
                <p className="text-sm text-fg-muted">Loading…</p>
              ) : usage.error ? (
                <ErrorState
                  compact
                  error={usage.error}
                  onRetry={() => void usage.refetch()}
                />
              ) : used &&
                (used.profiles.length ||
                  used.tiers.length ||
                  used.licenses.length ||
                  used.accounts?.length) ? (
                <DescriptionList
                  items={[
                    {
                      term: "Profiles",
                      detail: used.profiles.length ? (
                        <LinkList>
                          {used.profiles.map((p) => (
                            <EntityLink
                              key={p.id}
                              slug={slug}
                              kind="profile"
                              id={p.id}
                              label={p.name || p.id}
                            />
                          ))}
                        </LinkList>
                      ) : (
                        "None"
                      ),
                    },
                    {
                      term: "Tiers (through their profile)",
                      detail: used.tiers.length ? (
                        <LinkList>
                          {used.tiers.map((t) => (
                            <EntityLink
                              key={t.id}
                              slug={slug}
                              kind="tier"
                              id={t.id}
                              label={`${t.label || t.id} (via ${t.profile})`}
                            />
                          ))}
                        </LinkList>
                      ) : (
                        "None"
                      ),
                    },
                    {
                      term: "Licenses",
                      detail: used.licenses.length ? (
                        <LinkList>
                          {used.licenses.map((l) => (
                            <EntityLink
                              key={l.id}
                              slug={slug}
                              kind="license"
                              id={l.id}
                              label={l.name || l.email || l.id}
                            />
                          ))}
                        </LinkList>
                      ) : (
                        "None"
                      ),
                    },
                    {
                      // U-03: account overrides, by the product's pairwise subject.
                      term: "Accounts (account overrides)",
                      detail: used.accounts?.length ? (
                        <LinkList>
                          {used.accounts.map((a) => (
                            <EntityLink
                              key={a.subject}
                              slug={slug}
                              kind="user"
                              id={a.subject}
                            />
                          ))}
                        </LinkList>
                      ) : (
                        "None"
                      ),
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-fg-muted">
                  No profile, license or account sets this key; clients use the
                  default.
                </p>
              )}
            </section>
          </div>
        </DrawerBody>
      ) : null}
    </Drawer>
  );
}

function LinkList({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {React.Children.map(children, (c) => (
        <li>{c}</li>
      ))}
    </ul>
  );
}
