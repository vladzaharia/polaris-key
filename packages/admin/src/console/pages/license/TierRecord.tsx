/**
 * The tier record (ADMIN.md §6.5.3, T3): an Overview form (nullable numbers, min ≤ max on the
 * client; TIR-1, TIR-3) that sends only what changed (TIR-4), and a Used by tab listing the
 * licenses on the tier. Delete is disabled with its reason while used, L2 when not.
 */

import * as React from "react";
import type { LicenseSummary, TierSummary } from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { r } from "../../routes.js";
import { Link, navigate } from "../../router.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { SettingsSection } from "../../templates/Settings.js";
import { fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Form, useAdminForm } from "../../../ui/form.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import {
  TierFields,
  tierPatchBody,
  tierValues,
  validateTier,
  type TierValues,
} from "./TierForm.js";
import { DeleteTierDialog, termText, usedByText } from "./TiersPage.js";
import { LicenseStatus, useLicenses, useTiers } from "./shared.js";

export const TIER_TABS = ["overview", "used-by"] as const;
type TierTab = (typeof TIER_TABS)[number];

export function TierRecord({
  slug,
  id,
  tab: rawTab,
}: {
  slug: string;
  id: string;
  tab?: string;
}): React.ReactElement {
  const tab: TierTab = rawTab === "used-by" ? "used-by" : "overview";
  const tiersQ = useTiers(slug);
  const tier = tiersQ.data?.tiers.find((t) => t.id === id);

  if (tiersQ.isPending) return <PageSkeleton template="record" label="tier" />;
  if (!tier) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={
            <Breadcrumbs
              items={[{ label: "Tiers", to: r.tiers(slug) }, { label: id }]}
            />
          }
          title={tiersQ.data ? "Tier not found" : "Tier"}
        />
        {tiersQ.data ? (
          <EmptyState
            kind="not-found"
            title="This tier doesn't exist"
            description="It may have been deleted, or the link has a typo."
            primaryAction={
              <Button variant="outline" onClick={() => navigate(r.tiers(slug))}>
                Back to tiers
              </Button>
            }
          />
        ) : (
          <ErrorState
            error={tiersQ.error}
            onRetry={() => void tiersQ.refetch()}
            context={{ thing: "Tier", collectionHref: r.tiers(slug) }}
          />
        )}
      </div>
    );
  }
  return (
    <TierRecordBody
      slug={slug}
      tier={tier}
      tab={tab}
      refetching={tiersQ.isFetching}
    />
  );
}

function TierRecordBody({
  slug,
  tier,
  tab,
  refetching,
}: {
  slug: string;
  tier: TierSummary;
  tab: TierTab;
  refetching: boolean;
}): React.ReactElement {
  const licensesQ = useLicenses(slug);
  const onTier = React.useMemo(
    () => (licensesQ.data?.licenses ?? []).filter((l) => l.tier === tier.id),
    [licensesQ.data, tier.id],
  );
  const used = licensesQ.data ? onTier.length : null;
  const [deleting, setDeleting] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[
              { label: "Tiers", to: r.tiers(slug) },
              { label: tier.label || tier.id },
            ]}
          />
        }
        title={tier.label || tier.id}
        description={
          <>
            <span className="font-mono text-xs">{tier.id}</span> ·{" "}
            {termText(tier.policyExpiryDays)} ·{" "}
            {used === null ? "Usage unknown" : usedByText(used)}
          </>
        }
        dangerActions={[
          {
            label: "Delete tier…",
            onSelect: () => setDeleting(true),
            disabledReason: used ? usedByText(used) : undefined,
          },
        ]}
        refetching={refetching}
        tabs={
          <PageTabs
            label="Tier sections"
            value={tab}
            items={[
              {
                value: "overview",
                label: "Overview",
                to: r.tier(slug, tier.id),
                dirty,
              },
              {
                value: "used-by",
                label: "Used by",
                to: r.tier(slug, tier.id, "used-by"),
                count: used ?? undefined,
              },
            ]}
          />
        }
      />
      {tab === "overview" || dirty ? (
        <div hidden={tab !== "overview"}>
          <TierOverview slug={slug} tier={tier} onDirtyChange={setDirty} />
        </div>
      ) : null}
      {tab === "used-by" ? (
        <TierUsedBy
          slug={slug}
          licenses={onTier}
          loading={licensesQ.isPending}
          error={licensesQ.error}
          onRetry={() => void licensesQ.refetch()}
        />
      ) : null}
      <DeleteTierDialog
        slug={slug}
        tier={deleting ? tier : null}
        onOpenChange={(o) => !o && setDeleting(false)}
        onDeleted={() => navigate(r.tiers(slug))}
      />
    </div>
  );
}

function TierOverview({
  slug,
  tier,
  onDirtyChange,
}: {
  slug: string;
  tier: TierSummary;
  onDirtyChange: (dirty: boolean) => void;
}): React.ReactElement {
  const values = React.useMemo(() => tierValues(tier), [tier]);
  const form = useAdminForm<TierValues>({
    values,
    validate: (v) => validateTier(v),
    onSubmit: async (draft, { server }) => {
      const body = tierPatchBody(server, draft);
      if (Object.keys(body).length === 0) return;
      await mutate("patchTier", slug, tier.id, body);
      toast.success("Tier saved");
    },
  });
  React.useEffect(
    () => onDirtyChange(form.isDirty),
    [form.isDirty, onDirtyChange],
  );
  const recordPrefix = r.tier(slug, tier.id);
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard unsaved changes to this tier?",
    onDiscard: form.discard,
    allow: (hash) => {
      const path = hash.split("?")[0]!;
      return path === recordPrefix || path.startsWith(`${recordPrefix}/`);
    },
  });
  return (
    <Form form={form} aria-label="Tier">
      <SettingsSection
        id="tier-overview"
        title="Policy"
        description="A blank number uses the product default."
      >
        <div className="px-5 py-4">
          <TierFields slug={slug} heldChannels={values.channels} />
        </div>
      </SettingsSection>
      <SaveBar form={form} saveLabel="Save tier" section="Policy" />
      {guard.dialog}
    </Form>
  );
}

function TierUsedBy({
  slug,
  licenses,
  loading,
  error,
  onRetry,
}: {
  slug: string;
  licenses: LicenseSummary[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const [state, setState] = useTableUrlState("usedby", { namespace: true });
  const columns = React.useMemo<DataColumn<LicenseSummary>[]>(
    () => [
      {
        id: "holder",
        header: "Holder",
        accessorFn: (l) => l.name || l.email || l.id,
        meta: { priority: 1, primary: true },
        cell: ({ row }) => (
          <span className="inline-flex min-w-0 flex-col">
            <span className="truncate">
              {row.original.name || "Unnamed license"}
            </span>
            <span className="truncate text-xs font-normal text-fg-muted">
              {row.original.email}
            </span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (l) => l.status,
        meta: { priority: 1 },
        cell: ({ row }) => <LicenseStatus license={row.original} />,
      },
      {
        id: "expires",
        header: "Expires",
        accessorFn: (l) => l.expiresAt ?? Number.MAX_SAFE_INTEGER,
        meta: { numeric: true, priority: 2 },
        cell: ({ row }) =>
          row.original.expiresAt == null ? (
            <span className="text-fg-muted">No expiry</span>
          ) : (
            <Timestamp at={fromSeconds(row.original.expiresAt)} format="date" />
          ),
      },
      {
        id: "devices",
        header: "Devices",
        accessorKey: "deviceCount",
        meta: { priority: 2, numeric: true },
      },
    ],
    [],
  );
  return (
    <div className="space-y-3">
      <DataTable<LicenseSummary>
        id="tier-used-by"
        caption="Licenses on this tier"
        data={licenses}
        columns={columns}
        getRowId={(l) => l.id}
        rowHref={(l) => r.license(slug, l.id)}
        linkComponent={Link}
        search={{ placeholder: "Search licenses", columns: ["holder"] }}
        state={state}
        onStateChange={setState}
        loading={loading}
        error={error ?? undefined}
        onRetry={onRetry}
        empty={
          <EmptyState
            kind="first-run"
            title="No licenses on this tier"
            description="Put a license on this tier from its Terms."
          />
        }
        mobile="cards"
      />
    </div>
  );
}
