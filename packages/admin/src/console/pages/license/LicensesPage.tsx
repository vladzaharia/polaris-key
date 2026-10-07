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
import { Plus } from "lucide-react";
import type { LicenseSummary } from "../../../api.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { r } from "../../routes.js";
import { Link, navigate } from "../../router.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { PageHeader } from "../../components/PageHeader.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { fromSeconds } from "../../../lib/format.js";
import { SIGN_IN_LABELS } from "../../../lib/labels.js";
import { cn } from "../../../lib/cn.js";
import { Button } from "../../../ui/Button.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { Meter } from "../../../ui/charts/Meter.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import {
  DataTable,
  downloadCsv,
  tableCsv,
  type DataColumn,
  type Facet,
} from "../../../ui/data-table/index.js";
import { CreateLicenseDialog } from "./CreateLicenseDialog.js";
import { OverrideMigrationNotice } from "./OverrideMigrationNotice.js";
import {
  BulkDeleteDialog,
  CleanupDialog,
  deletable,
  deletionBlockedReason,
} from "./LicenseDelete.js";
import {
  HOLDER_STATES,
  HOLDER_STATE_LABELS,
  HolderCell,
  holderOf,
  holderState,
  useLicenseBatches,
} from "./holders.js";
import {
  LICENSE_STATE_LABELS,
  LicenseStatus,
  licenseState,
  seatLimitOf,
  seatLimitText,
  useLicenses,
  useTiers,
  type LicenseState,
} from "./shared.js";

const STATES: LicenseState[] = ["active", "expiring", "expired", "disabled"];
const FACETS = [
  "status",
  "holder",
  "batch",
  "tier",
  "channel",
  "signin",
] as const;
const NO_TIER = "__none__";
const NO_BATCH = "__none__";

export function LicensesPage({ slug }: { slug: string }): React.ReactElement {
  const licensesQ = useLicenses(slug);
  const tiersQ = useTiers(slug);
  const batchesQ = useLicenseBatches(slug);
  const product = useProduct(slug).data;
  const [state, setState] = useTableUrlState("licenses", { facets: FACETS });
  const [createOpen, setCreateOpen] = React.useState(false);
  const [cleanupOpen, setCleanupOpen] = React.useState(false);
  const [bulkDelete, setBulkDelete] = React.useState<LicenseSummary[] | null>(
    null,
  );
  const [bulk, setBulk] = React.useState<{
    enable: boolean;
    rows: LicenseSummary[];
  } | null>(null);

  const licenses = React.useMemo(
    () => licensesQ.data?.licenses ?? [],
    [licensesQ.data],
  );
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
    const c: Record<LicenseState, number> = {
      active: 0,
      expiring: 0,
      expired: 0,
      disabled: 0,
    };
    for (const l of licenses) c[licenseState(l, now)] += 1;
    return c;
  }, [licenses, now]);

  const tierLabel = React.useCallback(
    (id: string | null) =>
      id ? tiers.find((t) => t.id === id)?.label || id : "—",
    [tiers],
  );

  const columns = React.useMemo<DataColumn<LicenseSummary>[]>(
    () => [
      {
        id: "holder",
        header: "Holder",
        accessorFn: (l) => l.name || l.email || l.id,
        meta: {
          priority: 1,
          primary: true,
          csv: (l) =>
            l.name ||
            (holderOf(l).kind === "floating" ? "Floating" : l.email || ""),
        },
        cell: ({ row }) => <HolderCell license={row.original} />,
      },
      {
        id: "holderState",
        header: "Holder state",
        accessorFn: (l) => HOLDER_STATE_LABELS[holderState(l)],
        meta: { defaultHidden: true },
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
        id: "status",
        header: "Status",
        accessorFn: (l) => licenseState(l, now),
        meta: {
          priority: 1,
          csv: (l) => LICENSE_STATE_LABELS[licenseState(l, now)],
        },
        cell: ({ row }) => <LicenseStatus license={row.original} now={now} />,
      },
      {
        id: "tier",
        header: "Tier",
        accessorFn: (l) => tierLabel(l.tier),
        meta: { priority: 2 },
        cell: ({ getValue }) => (
          <span
            className="block max-w-[14rem] truncate"
            title={getValue() as string}
          >
            {getValue() as string}
          </span>
        ),
      },
      {
        id: "expires",
        header: "Expires",
        // Never-expiring licenses sort after every dated one.
        accessorFn: (l) => l.expiresAt ?? Number.MAX_SAFE_INTEGER,
        meta: {
          numeric: true,
          priority: 1,
          csv: (l) =>
            l.expiresAt == null
              ? ""
              : new Date(fromSeconds(l.expiresAt)).toISOString(),
        },
        cell: ({ row }) =>
          row.original.expiresAt == null ? (
            <span className="text-fg-muted">No expiry</span>
          ) : (
            <Timestamp at={fromSeconds(row.original.expiresAt)} format="date" />
          ),
      },
      {
        id: "seats",
        header: "Seats",
        accessorKey: "deviceCount",
        meta: { priority: 2, numeric: true },
        cell: ({ row }) => {
          const l = row.original;
          // LX-14a: the limit the Worker enforces and where it comes from.
          const seats = seatLimitOf(l, tiers, product?.defaultDeviceLimit);
          const limit = seats.limit;
          return (
            <div className="ml-auto w-28" title={seatLimitText(seats)}>
              {limit === null ? (
                <span className="tabular-nums">{l.deviceCount}/—</span>
              ) : (
                <Meter
                  label="Seats"
                  hideLabel
                  value={l.deviceCount}
                  max={limit}
                  tone={l.deviceCount > limit ? "warning" : "accent"}
                />
              )}
              <span className="block truncate text-xs text-fg-muted">
                {seats.from}
              </span>
            </div>
          );
        },
      },
      {
        id: "keys",
        header: "Keys",
        accessorKey: "activeKeyCount",
        meta: { priority: 3, numeric: true },
      },
      ...(hasBatches
        ? [
            {
              id: "batch",
              header: "Batch",
              accessorFn: (l: LicenseSummary) =>
                l.batchId ? batchLabel(l.batchId) : "",
              meta: { priority: 3 },
              cell: ({ row }: { row: { original: LicenseSummary } }) =>
                row.original.batchId ? (
                  <Link
                    to={r.licenseBatch(slug, row.original.batchId)}
                    className="inline-block max-w-[12rem] truncate rounded-full border border-border px-2 py-0.5 text-xs text-fg hover:border-border-strong"
                    title={batchLabel(row.original.batchId)}
                  >
                    {batchLabel(row.original.batchId)}
                  </Link>
                ) : null,
            } satisfies DataColumn<LicenseSummary>,
          ]
        : []),
      {
        id: "channel",
        header: "Channels",
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
    [
      now,
      tierLabel,
      tiers,
      product?.defaultDeviceLimit,
      hasBatches,
      batchLabel,
      slug,
    ],
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
  }, [licenses, tiers, now, hasBatches, batches]);

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

  const runBulk = async (): Promise<void> => {
    if (!bulk) return;
    const failed: string[] = [];
    for (const l of bulk.rows) {
      try {
        await mutate("setLicenseEnabled", slug, l.id, bulk.enable);
      } catch {
        failed.push(l.name || l.id);
      }
    }
    const done = bulk.rows.length - failed.length;
    if (failed.length) {
      throw new Error(
        `${done} of ${bulk.rows.length} changed. Failed: ${failed.join(", ")}.`,
      );
    }
    toast.success(
      `${done} ${done === 1 ? "license" : "licenses"} ${bulk.enable ? "enabled" : "disabled"}`,
    );
  };

  const total = licenses.length;

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Licenses"
          titleAside={
            licensesQ.data ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {total.toLocaleString()}
              </span>
            ) : null
          }
          primaryAction={
            <Button iconStart={<Plus />} onClick={() => setCreateOpen(true)}>
              Create license
            </Button>
          }
          secondaryActions={[
            {
              label: "Clean up duplicates…",
              onSelect: () => setCleanupOpen(true),
            },
            ...(hasBatches
              ? [
                  {
                    label: "Batches",
                    onSelect: () => navigate(r.licenseBatches(slug)),
                  },
                ]
              : []),
          ]}
          refetching={licensesQ.isFetching && !licensesQ.isPending}
        />
      }
      summary={
        licensesQ.data && total > 0 ? (
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
            className="font-bold text-accent-fg underline-offset-2 hover:underline"
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
          placeholder: "Search name, email or id",
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
        error={licensesQ.error ?? undefined}
        onRetry={() => void licensesQ.refetch()}
        empty={
          <EmptyState
            kind="first-run"
            headingLevel={2}
            title="No licenses yet"
            description="Create the first license to mint a key and authorize devices."
            primaryAction={
              <Button iconStart={<Plus />} onClick={() => setCreateOpen(true)}>
                Create license
              </Button>
            }
            docs={docsUrl("createLicense")}
          />
        }
        mobile="cards"
      />

      <CreateLicenseDialog
        slug={slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

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

      <ConfirmDialog
        open={bulk !== null}
        onOpenChange={(o) => !o && setBulk(null)}
        intent="caution"
        title={
          bulk
            ? `${bulk.enable ? "Enable" : "Disable"} ${bulk.rows.length} ${bulk.rows.length === 1 ? "license" : "licenses"}?`
            : ""
        }
        consequences={
          bulk
            ? bulk.enable
              ? [
                  "Devices on these licenses regain access at their next check-in.",
                  "Keys and devices are unchanged.",
                ]
              : [
                  "Devices on these licenses stop authenticating right away: their cached tokens are purged.",
                  "Keys and devices are kept; enabling a license restores access.",
                ]
            : []
        }
        confirmLabel={
          bulk
            ? `${bulk.enable ? "Enable" : "Disable"} ${bulk.rows.length} ${bulk.rows.length === 1 ? "license" : "licenses"}`
            : ""
        }
        onConfirm={runBulk}
      />
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
        "flex flex-col items-start gap-1 rounded-lg border bg-surface-raised px-4 py-3 text-left",
        "transition-colors hover:border-border-strong",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
        pressed ? "border-accent ring-1 ring-accent" : "border-border",
      )}
    >
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="text-xl font-bold tabular-nums text-fg-strong">
        {count.toLocaleString()}
      </span>
    </button>
  );
}
