/**
 * License → Tiers (ADMIN.md §6.5.3, T2): label, id, profile (a link, TIR-9), term (TIR-6),
 * device limit, channels, versions and **Used by** (licenses on the tier, from the licenses
 * query; TIR-2). Rows open the tier record (TIR-5). Delete is disabled with its reason while the
 * tier is used and L2 when it is not. Create is a one-pane drawer (TIR-8).
 */

import * as React from "react";
import { Plus } from "lucide-react";
import type { TierSummary } from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { r } from "../../routes.js";
import { Link, navigate } from "../../router.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { confirmFor } from "../../../lib/actions.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { Form, useAdminForm } from "../../../ui/form.js";
import { toast } from "../../../ui/toast.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import {
  EMPTY_TIER,
  TierFields,
  tierCreateBody,
  validateTier,
  type TierValues,
} from "./TierForm.js";
import { useLicenses, useProfiles, useTiers } from "./shared.js";

/** Licenses per tier id, or `null` while the licenses are unknown. */
export function useTierUsage(slug: string): Map<string, number> | null {
  const q = useLicenses(slug);
  return React.useMemo(() => {
    if (!q.data) return null;
    const m = new Map<string, number>();
    for (const l of q.data.licenses ?? [])
      if (l.tier) m.set(l.tier, (m.get(l.tier) ?? 0) + 1);
    return m;
  }, [q.data]);
}

export const usedByText = (n: number) =>
  `Used by ${n} ${n === 1 ? "license" : "licenses"}`;

/** The tier's term in words: "365-day term". */
export const termText = (days: number | null) =>
  days == null ? "No term" : `${days}-day term`;

export function TiersPage({ slug }: { slug: string }): React.ReactElement {
  const tiersQ = useTiers(slug);
  const profiles = useProfiles(slug).data?.profiles ?? [];
  const usage = useTierUsage(slug);
  const [state, setState] = useTableUrlState("tiers");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<TierSummary | null>(null);
  const tiers = React.useMemo(() => tiersQ.data?.tiers ?? [], [tiersQ.data]);

  const profileName = React.useCallback(
    (id: string) => profiles.find((p) => p.id === id)?.name || id,
    [profiles],
  );

  const columns = React.useMemo<DataColumn<TierSummary>[]>(
    () => [
      {
        id: "label",
        header: "Tier",
        accessorFn: (t) => t.label || t.id,
        meta: { priority: 1, primary: true },
        cell: ({ getValue }) => (
          <span
            className="block max-w-[11rem] truncate"
            title={getValue() as string}
          >
            {getValue() as string}
          </span>
        ),
      },
      {
        id: "id",
        header: "Id",
        accessorKey: "id",
        meta: { priority: 2, mono: true },
        cell: ({ getValue }) => (
          <span
            className="block max-w-[7rem] truncate"
            title={getValue() as string}
          >
            {getValue() as string}
          </span>
        ),
      },
      {
        id: "profile",
        header: "Profile",
        accessorFn: (t) => (t.profile ? profileName(t.profile) : ""),
        meta: { priority: 2 },
        cell: ({ row }) =>
          row.original.profile ? (
            <EntityLink
              slug={slug}
              kind="profile"
              id={row.original.profile}
              label={profileName(row.original.profile)}
              className="block max-w-[11rem] truncate"
              title={profileName(row.original.profile)}
            />
          ) : (
            <span className="text-fg-muted">None</span>
          ),
      },
      {
        id: "term",
        header: "Expiry",
        accessorFn: (t) => t.policyExpiryDays ?? Number.MAX_SAFE_INTEGER,
        meta: { priority: 2, csv: (t) => termText(t.policyExpiryDays) },
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {termText(row.original.policyExpiryDays)}
          </span>
        ),
      },
      {
        id: "devices",
        header: "Device limit",
        accessorFn: (t) => t.policyDeviceLimit ?? 0,
        meta: {
          priority: 1,
          numeric: true,
          csv: (t) => String(t.policyDeviceLimit ?? ""),
        },
        cell: ({ row }) =>
          row.original.policyDeviceLimit ?? (
            <span className="whitespace-nowrap text-fg-muted">
              Product default
            </span>
          ),
      },
      {
        id: "channels",
        header: "Channels",
        accessorFn: (t) => t.channels.join(", "),
        meta: { priority: 3 },
        cell: ({ getValue }) =>
          (getValue() as string) ? (
            <span
              className="block max-w-[9rem] truncate"
              title={getValue() as string}
            >
              {getValue() as string}
            </span>
          ) : (
            <span className="text-fg-muted">—</span>
          ),
      },
      {
        id: "versions",
        header: "Versions",
        accessorFn: (t) =>
          t.minVersion || t.maxVersion
            ? `${t.minVersion ? `≥ ${t.minVersion}` : ""}${t.minVersion && t.maxVersion ? " · " : ""}${t.maxVersion ? `≤ ${t.maxVersion}` : ""}`
            : "",
        meta: { priority: 3 },
        cell: ({ getValue }) =>
          (getValue() as string) ? (
            <span className="whitespace-nowrap tabular-nums">
              {getValue() as string}
            </span>
          ) : (
            <span className="text-fg-muted">Any</span>
          ),
      },
      {
        id: "usedBy",
        header: "Used by",
        accessorFn: (t) => usage?.get(t.id) ?? 0,
        meta: { priority: 1, numeric: true },
        cell: ({ row }) => {
          if (!usage) return <span className="text-fg-muted">—</span>;
          const n = usage.get(row.original.id) ?? 0;
          return n === 0 ? (
            <span className="text-fg-muted">0</span>
          ) : (
            <Link
              to={r.licenses(slug, { tier: row.original.id })}
              className="text-accent-fg underline-offset-4 hover:underline"
            >
              {n}
            </Link>
          );
        },
      },
    ],
    [slug, profileName, usage],
  );

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Tiers"
          titleAside={
            tiersQ.data ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {tiers.length}
              </span>
            ) : null
          }
          primaryAction={
            <Button iconStart={<Plus />} onClick={() => setCreateOpen(true)}>
              New tier
            </Button>
          }
          refetching={tiersQ.isFetching && !tiersQ.isPending}
        />
      }
    >
      <DataTable<TierSummary>
        id="tiers"
        caption="Tiers"
        data={tiers}
        columns={columns}
        getRowId={(t) => t.id}
        rowLabel={(t) => t.label || t.id}
        rowHref={(t) => r.tier(slug, t.id)}
        linkComponent={Link}
        search={{
          placeholder: "Search tiers",
          columns: ["label", "id", "profile"],
        }}
        state={state}
        onStateChange={setState}
        rowActions={(t) => {
          const used = usage?.get(t.id) ?? 0;
          return [
            { label: "Open", onSelect: () => navigate(r.tier(slug, t.id)) },
            { type: "separator" },
            {
              label: "Delete…",
              tone: "danger",
              disabledReason: used > 0 ? usedByText(used) : undefined,
              onSelect: () => setDeleting(t),
            },
          ];
        }}
        loading={tiersQ.isPending}
        error={tiersQ.error ?? undefined}
        onRetry={() => void tiersQ.refetch()}
        empty={
          <EmptyState
            kind="first-run"
            headingLevel={2}
            title="No tiers yet"
            description="A tier bundles a profile and policy defaults that licenses can be put on."
            primaryAction={
              <Button iconStart={<Plus />} onClick={() => setCreateOpen(true)}>
                New tier
              </Button>
            }
            docs={docsUrl("tierEditor")}
          />
        }
        mobile="cards"
      />

      <CreateTierDrawer
        slug={slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingIds={tiers.map((t) => t.id)}
      />
      <DeleteTierDialog
        slug={slug}
        tier={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </CollectionTemplate>
  );
}

export function DeleteTierDialog({
  slug,
  tier,
  onOpenChange,
  onDeleted,
}: {
  slug: string;
  tier: TierSummary | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}): React.ReactElement {
  return (
    <ConfirmDialog
      open={tier !== null}
      onOpenChange={onOpenChange}
      intent={confirmFor("tier.delete").intent as "danger"}
      title={`Delete tier “${tier?.label || tier?.id || ""}”?`}
      consequences={[
        "The tier is removed. No license is on it, so no device is affected.",
        "A tier the manifest declares comes back at the next resync.",
      ]}
      confirmLabel="Delete tier"
      describeError={(e) =>
        (e as { status?: number })?.status === 409
          ? {
              title: "Licenses are on this tier",
              description: "Move them to another tier first.",
            }
          : errorCopy(e, { thing: "Tier" })
      }
      onConfirm={async () => {
        if (!tier) return;
        await mutate("deleteTier", slug, tier.id);
        toast.success("Tier deleted");
        onDeleted?.();
      }}
    />
  );
}

function CreateTierDrawer({
  slug,
  open,
  onOpenChange,
  existingIds,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
}): React.ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="New tier" size="lg">
      {open ? (
        <CreateTierForm
          slug={slug}
          existingIds={existingIds}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Drawer>
  );
}

function CreateTierForm({
  slug,
  existingIds,
  onDone,
}: {
  slug: string;
  existingIds: string[];
  onDone: () => void;
}): React.ReactElement {
  const form = useAdminForm<TierValues>({
    values: EMPTY_TIER,
    validate: (v) => validateTier(v, { existingIds, creating: true }),
    onSubmit: async (v) => {
      await mutate("createTier", slug, tierCreateBody(v));
      toast.success("Tier created", {
        description: `“${v.label.trim() || v.id.trim()}” is ready to assign.`,
      });
      onDone();
    },
  });
  return (
    <Form
      form={form}
      aria-label="New tier"
      className="flex min-h-0 flex-1 flex-col"
    >
      <DrawerBody className="space-y-4">
        <TierFields slug={slug} creating />
        {form.submitError && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="The tier wasn't created" live>
            {errorCopy(form.submitError, { thing: "Tier" }).description}
          </Callout>
        ) : null}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onDone} disabled={form.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.isSubmitting}>
          Create tier
        </Button>
      </DrawerFooter>
    </Form>
  );
}
