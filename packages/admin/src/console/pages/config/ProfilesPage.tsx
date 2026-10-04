import * as React from "react";
import { Plus } from "lucide-react";
import type { ProfileSummary } from "../../../api.js";
import { fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Link, navigate } from "../../router.js";
import { r } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { isNotFound, useCatalog, useProfiles } from "./data.js";
import {
  CreateProfileDrawer,
  DeleteProfileDialog,
  deleteBlockedReason,
} from "./profileActions.js";

function usedByText(p: ProfileSummary): string {
  const u = p.usedBy;
  if (!u || (u.tiers === 0 && u.licenses === 0)) return "Nothing";
  const parts: string[] = [];
  if (u.tiers) parts.push(`${u.tiers} ${u.tiers === 1 ? "tier" : "tiers"}`);
  if (u.licenses)
    parts.push(`${u.licenses} ${u.licenses === 1 ? "license" : "licenses"}`);
  return parts.join(" · ");
}

/**
 * Config → Profiles (docs/design/ADMIN.md §6.6.3, T2): every profile with what uses it, the row
 * as the link to its record (PRF-4), the description on two lines (PRF-7), create in a drawer
 * with the id-taken and no-catalog cases told apart (PRF-5), and Delete disabled while anything
 * still points at the profile (PRF-2).
 */
export function ProfilesPage({ slug }: { slug: string }): React.ReactElement {
  const profiles = useProfiles(slug);
  const catalog = useCatalog(slug);
  const [state, setState] = useTableUrlState("profiles");
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  const rows = React.useMemo(
    () => profiles.data?.profiles ?? [],
    [profiles.data],
  );
  const noCatalog = isNotFound(catalog.error);
  const createBlocked = noCatalog
    ? "Publish a catalog first: a profile's values are checked against it."
    : undefined;

  const columns = React.useMemo<DataColumn<ProfileSummary>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        accessorFn: (p) => p.name || p.id,
        meta: { priority: 1, primary: true, alwaysVisible: true },
      },
      {
        id: "id",
        header: "Id",
        accessorKey: "id",
        meta: { priority: 2, mono: true },
      },
      {
        id: "description",
        header: "Description",
        accessorFn: (p) => p.description ?? "",
        enableSorting: false,
        meta: { priority: 2 },
        cell: ({ row }) =>
          row.original.description ? (
            <span className="line-clamp-2 max-w-md whitespace-normal text-fg-muted">
              {row.original.description}
            </span>
          ) : (
            <span className="text-fg-muted">—</span>
          ),
      },
      {
        id: "usedBy",
        header: "Used by",
        accessorFn: (p) =>
          (p.usedBy?.tiers ?? 0) * 1_000_000 + (p.usedBy?.licenses ?? 0),
        meta: { priority: 1, label: "Used by", csv: usedByText },
        cell: ({ row }) => (
          <span
            className={
              usedByText(row.original) === "Nothing"
                ? "text-fg-muted"
                : undefined
            }
          >
            {usedByText(row.original)}
          </span>
        ),
      },
      {
        id: "modifiedAt",
        header: "Last modified",
        accessorFn: (p) => p.modifiedAt ?? 0,
        meta: {
          priority: 3,
          csv: (p) =>
            p.modifiedAt
              ? new Date(fromSeconds(p.modifiedAt)).toISOString()
              : "",
        },
        cell: ({ row }) =>
          row.original.modifiedAt ? (
            <span>
              <Timestamp at={fromSeconds(row.original.modifiedAt)} />
              {row.original.modifiedBy ? (
                <span className="text-fg-muted">
                  {" "}
                  · {row.original.modifiedBy}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-fg-muted">—</span>
          ),
      },
    ],
    [],
  );

  const newButton = (
    <Button
      iconStart={<Plus aria-hidden />}
      disabledReason={createBlocked}
      onClick={() => setCreating(true)}
    >
      New profile
    </Button>
  );

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Profiles"
          titleAside={
            profiles.data ? (
              <span className="text-sm text-fg-muted">{rows.length}</span>
            ) : null
          }
          description="Named sets of config, secret and flag values that tiers and licenses inherit."
          refetching={profiles.isFetching && !profiles.isPending}
          primaryAction={newButton}
        />
      }
    >
      <DataTable<ProfileSummary>
        id="profiles"
        caption="Profiles"
        data={rows}
        columns={columns}
        getRowId={(p) => p.id}
        rowLabel={(p) => p.name || p.id}
        rowHref={(p) => r.profile(slug, p.id)}
        linkComponent={Link}
        search={{
          placeholder: "Search name, id, description…",
          columns: ["name", "id", "description"],
        }}
        state={state}
        onStateChange={setState}
        loading={profiles.isPending}
        error={profiles.error}
        onRetry={() => void profiles.refetch()}
        rowActions={(p) => [
          {
            label: "Open",
            onSelect: () => navigate(r.profile(slug, p.id)),
          },
          { type: "separator" },
          {
            label: "Delete…",
            tone: "danger",
            disabledReason: deleteBlockedReason(p.usedBy),
            onSelect: () => setDeleting(p.id),
          },
        ]}
        empty={
          <EmptyState
            kind="first-run"
            title="No profiles yet"
            description="A profile names a set of config, secret and flag values once, so tiers and licenses can inherit it."
            docs="/docs/services/config/profiles/"
            primaryAction={newButton}
          />
        }
      />
      <CreateProfileDrawer
        slug={slug}
        open={creating}
        onOpenChange={setCreating}
        existingIds={rows.map((p) => p.id)}
        onCreated={(id) => navigate(r.profile(slug, id))}
      />
      <DeleteProfileDialog
        slug={slug}
        profileId={deleting ?? ""}
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      />
    </CollectionTemplate>
  );
}
