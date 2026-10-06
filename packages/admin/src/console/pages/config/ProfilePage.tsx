import * as React from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  ApiError,
  type OverrideUpdate,
  type ProfileDetail,
} from "../../../api.js";
import { fromSeconds } from "../../../lib/format.js";
import { ManagedPayloadEditor } from "../../../ManagedPayloadEditor.js";
import { Button } from "../../../ui/Button.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { IdChip } from "../../../ui/IdChip.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { mutate } from "../../data/mutations.js";
import { Link, navigate } from "../../router.js";
import { r } from "../../routes.js";
import { isNotFound, useCatalog, useProfile } from "./data.js";
import {
  DeleteProfileDialog,
  EditProfileDrawer,
  deleteBlockedReason,
} from "./profileActions.js";

type Tab = "payload" | "used-by";

/**
 * Config → Profiles → a profile (docs/design/ADMIN.md §6.6.3, T3). The id shows once, in the
 * meta line (PRF-3); **Edit details…** changes name and description (A-7, PRF-1); **Delete…** is
 * disabled with the reason while tiers or licenses use it (PRF-2). Tabs: Payload (the managed
 * payload editor) and Used by. Leaving with unsaved payload edits asks first (PRF-6); switching to
 * Used by does not, because the payload stays mounted under it (FLOWS.md C-33).
 */
export function ProfilePage({
  slug,
  id,
  tab,
}: {
  slug: string;
  id: string;
  tab?: string;
}): React.ReactElement {
  const profile = useProfile(slug, id);
  const [dirty, setDirty] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const guard = useUnsavedChangesGuard(dirty, {
    message: "Discard unsaved changes to this profile?",
    consequences: [
      "Your changes to its values are lost. Nothing has been saved.",
    ],
    // The record's own tabs keep the draft: the payload panel stays mounted.
    allow: (hash) => {
      const record = r.profile(slug, id);
      const path = hash.split("?")[0]!;
      return path === record || path.startsWith(`${record}/`);
    },
  });
  const current: Tab = tab === "used-by" ? "used-by" : "payload";

  if (profile.isPending)
    return <PageSkeleton template="record" label="the profile" />;

  const crumbs = (
    <Breadcrumbs
      items={[
        { label: "Profiles", to: r.profiles(slug) },
        { label: profile.data?.name || id },
      ]}
    />
  );

  if (profile.error || !profile.data) {
    return (
      <div className="space-y-6" data-template="record">
        <PageHeader eyebrow={crumbs} title={id} />
        {isNotFound(profile.error) ? (
          <EmptyState
            kind="not-found"
            headingLevel={2}
            title="Profile not found"
            description="It may have been deleted, or the link may be out of date."
            primaryAction={
              <Button asChild variant="outline">
                <Link to={r.profiles(slug)}>All profiles</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState
            error={profile.error}
            onRetry={() => void profile.refetch()}
            context={{ thing: "Profile", collectionHref: r.profiles(slug) }}
          />
        )}
      </div>
    );
  }

  const p = profile.data;
  const usedBy = {
    tiers: p.usedBy?.tiers.length ?? 0,
    licenses: p.usedBy?.licenses.length ?? 0,
  };
  const usedCount = usedBy.tiers + usedBy.licenses;

  return (
    <div className="space-y-6" data-template="record">
      <PageHeader
        eyebrow={crumbs}
        title={p.name || p.id}
        description={p.description}
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <IdChip value={p.id} noun="profile id" />
            {p.modifiedAt ? (
              <span>
                Modified <Timestamp at={fromSeconds(p.modifiedAt)} />
                {p.modifiedBy ? ` by ${p.modifiedBy}` : ""}
              </span>
            ) : null}
          </span>
        }
        refetching={profile.isFetching}
        sticky
        secondaryActions={[
          {
            label: "Edit details…",
            icon: <Pencil aria-hidden />,
            onSelect: () => setEditing(true),
          },
        ]}
        dangerActions={[
          {
            label: "Delete…",
            icon: <Trash2 aria-hidden />,
            disabledReason: deleteBlockedReason(usedBy),
            onSelect: () => setDeleting(true),
          },
        ]}
        tabs={
          <PageTabs
            label="Profile"
            value={current}
            items={[
              {
                value: "payload",
                label: "Payload",
                to: r.profile(slug, id),
                dirty,
              },
              {
                value: "used-by",
                label: "Used by",
                to: r.profile(slug, id, "used-by"),
                count: usedCount,
              },
            ]}
          />
        }
      />

      <div hidden={current !== "payload"}>
        <PayloadTab slug={slug} profile={p} onDirtyChange={setDirty} />
      </div>
      {current === "used-by" ? <UsedByTab slug={slug} profile={p} /> : null}

      <EditProfileDrawer
        slug={slug}
        profile={p}
        open={editing}
        onOpenChange={setEditing}
      />
      <DeleteProfileDialog
        slug={slug}
        profileId={p.id}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => navigate(r.profiles(slug))}
      />
      {guard.dialog}
    </div>
  );
}

function PayloadTab({
  slug,
  profile,
  onDirtyChange,
}: {
  slug: string;
  profile: ProfileDetail;
  onDirtyChange: (dirty: boolean) => void;
}): React.ReactElement {
  const catalog = useCatalog(slug);
  const [saving, setSaving] = React.useState(false);
  const [serverFields, setServerFields] = React.useState<
    string[] | undefined
  >();

  const submit = async (updates: OverrideUpdate[]): Promise<void> => {
    setSaving(true);
    setServerFields(undefined);
    try {
      await mutate("putProfilePayload", slug, profile.id, updates);
      toast.success("Payload saved", {
        description: `${updates.length} ${updates.length === 1 ? "key" : "keys"} updated.`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.fields?.length) {
        // Row-level, not a toast: the worker named the keys.
        setServerFields(err.fields);
      } else if (
        err instanceof ApiError &&
        err.reason === "no_active_catalog"
      ) {
        toast.error("Publish a catalog first", {
          description: "A profile's values are checked against the catalog.",
        });
      } else {
        toast.error(err, { context: { thing: "Profile" } });
      }
      throw err;
    } finally {
      setSaving(false);
    }
  };

  if (catalog.isPending)
    return <PageSkeleton template="form" label="the catalog" />;
  if (isNotFound(catalog.error)) {
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="Publish a catalog first"
        description="A profile's values are the catalog's keys. Once the product has a catalog, set them here."
        primaryAction={
          <Button asChild>
            <Link to={r.catalog(slug)}>Open the catalog</Link>
          </Button>
        }
      />
    );
  }
  if (catalog.error || !catalog.data) {
    return (
      <ErrorState
        error={catalog.error}
        onRetry={() => void catalog.refetch()}
        context={{ thing: "Catalog" }}
      />
    );
  }
  return (
    <ManagedPayloadEditor
      slug={slug}
      catalog={catalog.data}
      payload={profile.payload}
      saving={saving}
      serverFields={serverFields}
      submitLabel="Save payload"
      onSubmit={submit}
      onDirtyChange={onDirtyChange}
    />
  );
}

interface UsedRow {
  kind: "tier" | "license";
  id: string;
  name: string;
  detail: string;
}

function UsedByTab({
  slug,
  profile,
}: {
  slug: string;
  profile: ProfileDetail;
}): React.ReactElement {
  const rows: UsedRow[] = [
    ...(profile.usedBy?.tiers ?? []).map((t) => ({
      kind: "tier" as const,
      id: t.id,
      name: t.label || t.id,
      detail: "Baseline profile of the tier",
    })),
    ...(profile.usedBy?.licenses ?? []).map((l) => ({
      kind: "license" as const,
      id: l.id,
      name: l.name || l.email || l.id,
      detail: l.email && l.name ? l.email : "In the license's profile stack",
    })),
  ];
  const columns: DataColumn<UsedRow>[] = [
    {
      id: "name",
      header: "Name",
      accessorKey: "name",
      meta: { priority: 1, alwaysVisible: true },
      cell: ({ row }) => (
        <EntityLink
          slug={slug}
          kind={row.original.kind}
          id={row.original.id}
          label={row.original.name}
          className="block max-w-[20rem] truncate"
          title={row.original.name}
        />
      ),
    },
    {
      id: "kind",
      header: "Kind",
      accessorFn: (u) => (u.kind === "tier" ? "Tier" : "License"),
      meta: { priority: 1 },
    },
    {
      id: "detail",
      header: "How",
      accessorKey: "detail",
      enableSorting: false,
      meta: { priority: 2 },
      cell: ({ getValue }) => (
        <span
          className="block max-w-[24rem] truncate"
          title={getValue() as string}
        >
          {getValue() as string}
        </span>
      ),
    },
  ];
  return (
    <DataTable<UsedRow>
      id="profile-used-by"
      caption="What uses this profile"
      data={rows}
      columns={columns}
      getRowId={(u) => `${u.kind}:${u.id}`}
      exportCsv={false}
      mobile="cards"
      empty={
        <EmptyState
          kind="first-run"
          title="Nothing uses this profile"
          description="Attach it to a tier as its baseline, or add it to a license's profile stack. An unused profile can be deleted."
        />
      }
    />
  );
}
