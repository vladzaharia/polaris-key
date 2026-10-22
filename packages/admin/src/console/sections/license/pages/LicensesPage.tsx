/**
 * License → Licenses (ADMIN.md §6.5.1, T2): facet tiles over the computed state (LIC-1), a
 * client-mode table (search over name, email and id; status, holder, batch, tier, channel and
 * sign-in facets; CSV; virtualized above 200 rows; LIC-7), bulk Disable / Enable / Export /
 * Delete, the "Clean up duplicates" helper (`LicenseDelete.tsx`), and the stepped Create license
 * dialog. Every filter is in the URL.
 *
 * LX-30 (S-24 §8.8): the Holder column says who holds each licence (name and email, "Waiting for
 * ada@…", or Floating, muted), the Holder facet filters on it (Anyone, In an account, Waiting,
 * Floating), and a product with batches gets a Batch column and facet whose labels open the batch.
 */

import * as React from "react";
import { Archive, KeySquare } from "lucide-react";
import { type LicenseSummary } from "../../../../api.js";
import { useProduct } from "../../../data/hooks.js";
import { r } from "../../../routes.js";
import { Link, navigate } from "../../../router.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { fromSeconds } from "../../../../lib/format.js";
import { SIGN_IN_LABELS } from "../../../../lib/labels.js";
import { cn } from "../../../../lib/cn.js";
import { toast } from "../../../../ui/toast.js";
import {
  DataTable,
  downloadCsv,
  tableCsv,
  type DataColumn,
  type Facet,
} from "../../../../ui/data-table/index.js";
import { useWriteGate } from "../../../access/useCan.js";
import { NewLicenseWizard } from "../wizard/NewLicenseWizard.js";
import {
  BulkEnableDialog,
  isForbidden,
  NO_BATCH,
  NO_TIER,
  BulkKeysButton,
  DevicesCell,
  LicenseCard,
  DurationCell,
  HOLDER_CHIP_ICONS,
  HolderPill,
  LicenseCell,
  LicensesFirstRun,
  NewLicenseButton,
  OriginCell,
  SKELETON,
  TierPill,
  originLabel,
  LicensesForbidden,
  serverFacetIds,
  useServerFilter,
} from "../components/LicenseListParts.js";
import { OverrideMigrationNotice } from "../components/OverrideMigrationNotice.js";
import {
  BulkDeleteDialog,
  CleanupDialog,
  deletable,
  deletionBlockedReason,
} from "./LicenseDelete.js";
import {
  HOLDER_STATES,
  HOLDER_STATE_LABELS,
  type HolderState,
  holderOf,
  holderState,
  useHolderCounts,
  useLicenseBatches,
} from "../components/holders.js";
import { EMPTY, loadDraft, saveDraft } from "../wizard/draft.js";
import {
  LICENSE_STATE_LABELS,
  LicenseStatus,
  licenseState,
  seatLimitOf,
  seatLimitText,
  useLicensePages,
  useTiers,
  type LicenseState,
} from "../components/shared.js";

const STATES: LicenseState[] = ["active", "expiring", "expired", "disabled"];
const FACETS = [
  "status",
  "holder",
  "batch",
  "tier",
  "channel",
  "signin",
  "origin",
] as const;

export function LicensesPage({ slug }: { slug: string }): React.ReactElement {
  const [state, setState] = useTableUrlState("licenses", { facets: FACETS });
  // A deep link (?batch= ?holder= ?tier=) is answered by the Worker, which filters before it
  // pages; every other narrowing runs over the loaded rows.
  const serverFilter = useServerFilter(state.filters);
  const {
    query: licensesQ,
    licenses,
    total: serverTotal,
    counts: serverCounts,
    loadAll,
  } = useLicensePages(slug, serverFilter);
  const [searchingAll, setSearchingAll] = React.useState(false);
  const tiersQ = useTiers(slug);
  const batchesQ = useLicenseBatches(slug);
  const product = useProduct(slug).data;
  const gate = useWriteGate("license", slug);
  const openNew = (): void =>
    void navigate(r.newLicense(slug), { replace: false });
  // "Create keys in bulk": the same wizard, on "Anyone with the key" (the draft resumes as it is).
  const openBulk = (): void => {
    saveDraft(slug, { ...loadDraft(slug), who: "anyone" });
    void navigate(r.newLicense(slug, "holder"), { replace: false });
  };
  const holderCountsQ = useHolderCounts(slug);
  const [cleanupOpen, setCleanupOpen] = React.useState(false);
  const [bulkDelete, setBulkDelete] = React.useState<LicenseSummary[] | null>(
    null,
  );
  const [bulk, setBulk] = React.useState<{
    enable: boolean;
    rows: LicenseSummary[];
  } | null>(null);

  const tiers = React.useMemo(() => tiersQ.data?.tiers ?? [], [tiersQ.data]);
  const batches = React.useMemo(
    () => batchesQ.data?.batches ?? [],
    [batchesQ.data],
  );
  const batchLabel = React.useCallback(
    (id: string) => batches.find((b) => b.id === id)?.label ?? id,
    [batches],
  );
  // A product with no batch keeps the table it had: no Batch column, no Batch facet.
  const hasBatches =
    batches.length > 0 || licenses.some((l) => Boolean(l.batchId));
  // "Now" moves with each fetch, so a state is stable while the operator reads the table.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = React.useMemo(() => Date.now(), [licensesQ.dataUpdatedAt]);

  const counts = React.useMemo(() => {
    if (serverCounts) return serverCounts;
    const c: Record<LicenseState, number> = {
      active: 0,
      expiring: 0,
      expired: 0,
      disabled: 0,
    };
    for (const l of licenses) c[licenseState(l, now)] += 1;
    return c;
  }, [licenses, now, serverCounts]);

  const tierLabel = React.useCallback(
    (id: string) => tiers.find((t) => t.id === id)?.label || id,
    [tiers],
  );

  const seatsOf = React.useCallback(
    (l: LicenseSummary) => seatLimitOf(l, tiers, product?.defaultDeviceLimit),
    [tiers, product?.defaultDeviceLimit],
  );

  const columns = React.useMemo<DataColumn<LicenseSummary>[]>(
    () => [
      {
        id: "holder",
        header: "License",
        accessorFn: (l) => l.name || l.email || l.id,
        meta: {
          label: "License",
          priority: 1,
          primary: true,
          skeleton: SKELETON.license,
          csv: (l) =>
            l.name ||
            (holderOf(l).kind === "floating" ? "Floating" : l.email || ""),
        },
        cell: ({ row }) => <LicenseCell license={row.original} />,
      },
      {
        id: "holderState",
        header: "Holder",
        accessorFn: (l) => HOLDER_STATE_LABELS[holderState(l)],
        meta: { priority: 1, skeleton: SKELETON.capsule },
        cell: ({ row }) => <HolderPill license={row.original} />,
      },
      {
        id: "email",
        header: "Email",
        accessorKey: "email",
        meta: { defaultHidden: true },
      },
      {
        id: "id",
        header: "Id",
        accessorKey: "id",
        meta: { defaultHidden: true, mono: true },
      },
      {
        id: "tier",
        header: "Tier",
        accessorFn: (l) => (l.tier ? tierLabel(l.tier) : ""),
        meta: {
          priority: 1,
          skeleton: SKELETON.capsule,
          csv: (l) => (l.tier ? tierLabel(l.tier) : ""),
        },
        cell: ({ row }) => (
          <TierPill
            label={row.original.tier ? tierLabel(row.original.tier) : null}
          />
        ),
      },
      {
        id: "expires",
        header: "Duration",
        // Never-expiring licenses sort after every dated one.
        accessorFn: (l) => l.expiresAt ?? Number.MAX_SAFE_INTEGER,
        meta: {
          priority: 1,
          skeleton: SKELETON.duration,
          csv: (l) =>
            l.expiresAt == null
              ? ""
              : new Date(fromSeconds(l.expiresAt)).toISOString(),
        },
        cell: ({ row }) => <DurationCell license={row.original} now={now} />,
      },
      {
        id: "seats",
        header: "Devices",
        accessorKey: "deviceCount",
        meta: { priority: 1, skeleton: SKELETON.devices },
        cell: ({ row }) => {
          const l = row.original;
          // LX-14a: the limit the Worker enforces and where it comes from.
          const seats = seatsOf(l);
          return (
            <DevicesCell
              count={l.deviceCount}
              limit={seats.limit}
              from={seatLimitText(seats)}
            />
          );
        },
      },
      {
        id: "origin",
        header: "Origin",
        accessorFn: (l) => originLabel(l),
        // The first column to go: hidden below 1440 px, so a row never scrolls sideways.
        meta: { priority: 3, skeleton: SKELETON.duration },
        cell: ({ row }) => (
          <OriginCell
            license={row.original}
            slug={slug}
            batchLabel={batchLabel}
          />
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (l) => licenseState(l, now),
        meta: {
          defaultHidden: true,
          csv: (l) => LICENSE_STATE_LABELS[licenseState(l, now)],
        },
      },
      {
        id: "keys",
        header: "Keys",
        accessorKey: "activeKeyCount",
        meta: { defaultHidden: true, numeric: true },
      },
      {
        id: "batch",
        header: "Batch",
        accessorFn: (l: LicenseSummary) =>
          l.batchId ? batchLabel(l.batchId) : "",
        meta: { defaultHidden: true },
      },
      {
        id: "channel",
        header: "Release tracks",
        accessorFn: (l) => l.channels.join(", "),
        meta: { defaultHidden: true },
        cell: ({ getValue }) => (getValue() as string) || "—",
      },
      {
        id: "signin",
        header: "Sign-in",
        accessorFn: (l) =>
          SIGN_IN_LABELS[l.identityProvider] ?? l.identityProvider,
        meta: { defaultHidden: true },
      },
    ],
    [now, tierLabel, seatsOf, batchLabel, slug],
  );

  const facets = React.useMemo<Facet<LicenseSummary>[]>(() => {
    const channels = [...new Set(licenses.flatMap((l) => l.channels))].sort();
    return [
      {
        id: "status",
        label: "Status",
        options: STATES.map((s) => ({
          value: s,
          label: LICENSE_STATE_LABELS[s],
        })),
        accessor: (l) => licenseState(l, now),
      },
      {
        id: "holder",
        label: "Holder",
        options: HOLDER_STATES.map((h) => ({
          value: h,
          label: HOLDER_STATE_LABELS[h],
        })),
        accessor: (l) => holderState(l),
        // Counted chips in the band: the Worker's totals, else the rows loaded so far.
        counted: {
          icons: HOLDER_CHIP_ICONS,
          counts: holderCountsQ.data,
          pending: holderCountsQ.isPending,
        },
      },
      ...(hasBatches
        ? [
            {
              id: "batch",
              label: "Batch",
              options: [
                ...batches.map((b) => ({ value: b.id, label: b.label })),
                { value: NO_BATCH, label: "Not in a batch" },
              ],
              accessor: (l: LicenseSummary) => l.batchId ?? NO_BATCH,
            },
          ]
        : []),
      {
        id: "tier",
        label: "Tier",
        options: [
          ...tiers.map((t) => ({ value: t.id, label: t.label || t.id })),
          { value: NO_TIER, label: "No tier" },
        ],
        accessor: (l) => l.tier ?? NO_TIER,
      },
      {
        id: "origin",
        label: "Origin",
        options: ["Automatic grant", "By hand", "Key batch"].map((o) => ({
          value: o,
          label: o,
        })),
        accessor: (l) => originLabel(l) || null,
      },
      {
        id: "channel",
        label: "Channel",
        options: channels.map((c) => ({ value: c, label: c })),
        accessor: (l) => l.channels,
      },
      {
        id: "signin",
        label: "Sign-in",
        options: [
          { value: "manual", label: SIGN_IN_LABELS.manual! },
          { value: "oidc", label: SIGN_IN_LABELS.oidc! },
        ],
        accessor: (l) => l.identityProvider,
      },
    ];
  }, [
    licenses,
    tiers,
    now,
    hasBatches,
    batches,
    holderCountsQ.data,
    holderCountsQ.isPending,
  ]);

  const statusFilter = state.filters.status ?? [];
  // Filtered to one batch: its page is one click away (S-24 §8.8, "Batch page (from the filter)").
  const batchFilter = state.filters.batch ?? [];
  const oneBatch =
    batchFilter.length === 1 && batchFilter[0] !== NO_BATCH
      ? batchFilter[0]!
      : null;
  const toggleState = (s: LicenseState): void => {
    const on = statusFilter.length === 1 && statusFilter[0] === s;
    setState({
      ...state,
      offset: 0,
      filters: { ...state.filters, status: on ? [] : [s] },
    });
  };

  const exportRows = (rows: LicenseSummary[]): void => {
    const ok = downloadCsv(
      `${slug}-licenses.csv`,
      tableCsv(
        rows,
        columns.filter((c) => c.id !== "seats"),
      ),
    );
    if (!ok) toast.error("This browser can't save files from the page.");
  };

  const stopWalk = React.useRef(false);
  const searchAll = async (): Promise<void> => {
    stopWalk.current = false;
    setSearchingAll(true);
    await loadAll(() => stopWalk.current);
    setSearchingAll(false);
  };

  const forbidden = !licensesQ.data && isForbidden(licensesQ.error);

  const firstRun =
    licensesQ.data !== undefined &&
    licenses.length === 0 &&
    !licensesQ.hasNextPage &&
    state.q === "" &&
    Object.values(state.filters).every((v) => v.length === 0);

  if (forbidden) return <LicensesForbidden slug={slug} />;

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Licenses"
          // First run keeps one primary: the empty state's.
          primaryAction={
            firstRun ? undefined : (
              // On a phone Create keys in bulk takes a full row above New license; wider, it is
              // the header's outline action beside Batches.
              <div className="flex flex-col gap-2">
                <span className="contents sm:hidden">
                  <BulkKeysButton slug={slug} onClick={openBulk} />
                </span>
                <NewLicenseButton slug={slug} onClick={openNew} />
              </div>
            )
          }
          secondaryActions={[
            ...(hasBatches && !firstRun
              ? [
                  {
                    label: "Batches",
                    icon: <Archive />,
                    onSelect: () => navigate(r.licenseBatches(slug)),
                  },
                ]
              : []),
            {
              label: "Create keys in bulk",
              icon: <KeySquare />,
              disabledReason: gate.disabledReason,
              hideOnPhone: !firstRun,
              onSelect: openBulk,
            },
            ...(firstRun
              ? []
              : [
                  {
                    label: "Clean up duplicates…",
                    disabledReason: gate.disabledReason,
                    onSelect: () => setCleanupOpen(true),
                  },
                ]),
          ]}
          refetching={licensesQ.isFetching && !licensesQ.isPending}
        />
      }
      summary={
        licensesQ.data &&
        (licenses.length > 0 || Object.values(counts).some((n) => n > 0)) ? (
          <>
            {STATES.map((s) => (
              <FacetTile
                key={s}
                label={LICENSE_STATE_LABELS[s]}
                count={counts[s]}
                pressed={statusFilter.length === 1 && statusFilter[0] === s}
                onClick={() => toggleState(s)}
              />
            ))}
          </>
        ) : undefined
      }
    >
      <OverrideMigrationNotice slug={slug} />
      {oneBatch ? (
        <p className="text-sm text-fg-muted" data-testid="batch-filter-link">
          Showing the licenses of batch{" "}
          <Link
            to={r.licenseBatch(slug, oneBatch)}
            className="py-1 font-medium text-accent-fg underline-offset-2 hover:underline"
          >
            {batchLabel(oneBatch)}
          </Link>
          .
        </p>
      ) : null}
      <DataTable<LicenseSummary>
        id="licenses"
        caption="Licenses"
        data={licenses}
        columns={columns}
        getRowId={(l) => l.id}
        rowLabel={(l) =>
          l.name ||
          (holderOf(l).kind === "floating" ? `Floating license ${l.id}` : l.id)
        }
        rowHref={(l) => r.license(slug, l.id)}
        linkComponent={Link}
        facets={facets}
        search={{
          placeholder: "Search licenses",
          columns: ["holder", "email", "id"],
        }}
        state={state}
        onStateChange={setState}
        selection={{
          mode: "multi",
          bulkActions: [
            {
              // Reversible, so an outline button; its confirm states the consequence.
              label: "Disable…",
              onSelect: (rows) => setBulk({ enable: false, rows }),
            },
            {
              label: "Enable…",
              onSelect: (rows) => setBulk({ enable: true, rows }),
            },
            { label: "Export", onSelect: (rows) => exportRows(rows) },
            {
              label: "Delete…",
              tone: "danger",
              onSelect: (rows) => setBulkDelete(rows),
              disabledReason: (rows) =>
                rows.some(deletable)
                  ? undefined
                  : rows.length === 1
                    ? deletionBlockedReason(rows[0]!.deletion)
                    : "None of the selected licenses can be deleted: disable them first, and a license with store purchases is never deleted.",
            },
          ],
        }}
        loading={licensesQ.isPending}
        // Rows already loaded stay on screen when a later page fails (the footer says so).
        error={licensesQ.data ? undefined : (licensesQ.error ?? undefined)}
        pagination={{
          mode: "cursor",
          local: true,
          total: serverTotal,
          hasMore: Boolean(licensesQ.hasNextPage),
          loadingMore: licensesQ.isFetchingNextPage && !searchingAll,
          loadError: licensesQ.isFetchNextPageError,
          onLoadMore: () => void licensesQ.fetchNextPage(),
          onSearchAll: () => void searchAll(),
          searchingAll,
          onStopSearchAll: () => {
            stopWalk.current = true;
          },
          serverFacets: serverFacetIds(serverFilter),
        }}
        onRetry={() => void licensesQ.refetch()}
        empty={<LicensesFirstRun slug={slug} onCreate={openNew} />}
        // Once every row is loaded the filtered-empty state names what was asked for.
        noResults={
          licensesQ.hasNextPage
            ? undefined
            : {
                title: "No licenses match",
                description: noMatchText(state, {
                  holder: (v) =>
                    v === "inAccount"
                      ? "in-account"
                      : HOLDER_STATE_LABELS[v as HolderState],
                  tier: (v) =>
                    v === NO_TIER
                      ? "no-tier"
                      : (tiers.find((t) => t.id === v)?.label ?? v),
                }),
              }
        }
        mobile="cards"
        mobileCard={(l, primary) => (
          <LicenseCard
            license={l}
            primary={primary}
            now={now}
            seats={seatsOf(l)}
            tierLabel={l.tier ? tierLabel(l.tier) : null}
          />
        )}
      />

      <NewLicenseWizard slug={slug} />

      <BulkDeleteDialog
        slug={slug}
        rows={bulkDelete}
        onOpenChange={(o) => !o && setBulkDelete(null)}
      />
      <CleanupDialog
        slug={slug}
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
      />

      <BulkEnableDialog slug={slug} bulk={bulk} onClose={() => setBulk(null)} />
    </CollectionTemplate>
  );
}

/** A summary tile that filters the table: a toggle button (`aria-pressed`). */
function FacetTile({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border bg-surface-raised px-4 py-3 text-start",
        "transition-colors hover:border-border-strong",
        "focus-visible:outline-2 focus-visible:outline-focus",
        pressed ? "border-accent ring-1 ring-accent" : "border-border",
      )}
    >
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="text-xl font-semibold tabular-nums text-fg-strong">
        {count.toLocaleString()}
      </span>
    </button>
  );
}

/** "No floating Studio license has a name, email or id containing “Q2KD-88”." */
function noMatchText(
  state: { q: string; filters: Record<string, string[]> },
  words: Record<"holder" | "tier", (value: string) => string>,
): string {
  // Holder words are common nouns ("floating"); a tier keeps its name ("Studio").
  const pick = (id: "holder" | "tier"): string =>
    (state.filters[id] ?? [])
      .map((v) => (id === "holder" ? words[id](v).toLowerCase() : words[id](v)))
      .join(" or ");
  const q = state.q.trim();
  const who = [pick("holder"), pick("tier")].filter(Boolean).join(" ");
  const what = `${who ? `${who} ` : ""}license`;
  const others = Object.entries(state.filters).some(
    ([id, v]) => v.length > 0 && id !== "holder" && id !== "tier",
  );
  if (q)
    return `No ${what} has a name, email or id containing “${q}”${others ? " under the other filters" : ""}.`;
  return `No ${what} matches${others ? " the other filters" : ""}.`;
}
