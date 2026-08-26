import * as React from "react";
import { AlertTriangle, FileCog, Pencil, Plus, Trash2 } from "lucide-react";
import { api, ApiError, type ProfileSummary } from "../api.js";
import { invalidate, useResource } from "../context.js";
import { absoluteTime, relativeTime } from "./format.js";
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  useToast,
  type ColumnDef,
} from "../components/ui/index.js";
import {
  CreateProfileDialog,
  type CreateProfileBody,
} from "./profiles/CreateProfileDialog.js";
import { ProfileDetailDialog } from "./profiles/ProfileDetailDialog.js";

/**
 * Profiles view: list every profile for a product, create new profiles, open a profile to edit
 * its catalog-driven managed payload (config/secret/flag values + per-key management state), and
 * delete profiles. A profile is the reusable managed payload a tier or license inherits.
 */
export function Profiles({ slug }: { slug: string }): React.ReactElement {
  const toast = useToast();
  const res = useResource(`profiles:${slug}`, () => api.profiles(slug));
  const profiles = res.data?.profiles ?? [];

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ProfileSummary | null>(null);
  const [deleting, setDeleting] = React.useState<ProfileSummary | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = (): void => invalidate(`profiles:${slug}`);

  const handleCreate = async (body: CreateProfileBody): Promise<void> => {
    setBusy(true);
    try {
      await api.createProfile(slug, body);
      toast.success("Profile created", `“${body.id}” is ready to configure.`);
      setCreateOpen(false);
      refresh();
    } catch (err) {
      toast.error("Could not create profile", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteProfile(slug, deleting.id);
      toast.success("Profile deleted", `Removed “${deleting.id}”.`);
      setDeleting(null);
      refresh();
    } catch (err) {
      toast.error(
        "Could not delete profile",
        describeError(err, PROFILE_IN_USE),
      );
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<ProfileSummary>[] = [
    {
      id: "id",
      header: "Id",
      accessor: (p) => p.id,
      sortable: true,
      cell: (p) => <span className="font-mono text-xs">{p.id}</span>,
    },
    {
      id: "name",
      header: "Name",
      accessor: (p) => p.name,
      sortable: true,
      cell: (p) => (
        <button
          type="button"
          className="font-medium text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setEditing(p)}
        >
          {p.name || p.id}
        </button>
      ),
    },
    {
      id: "description",
      header: "Description",
      accessor: (p) => p.description ?? "",
      cell: (p) =>
        p.description ? (
          <span className="line-clamp-1 max-w-sm text-muted-foreground">
            {p.description}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "modified",
      header: "Last modified",
      accessor: (p) => p.modifiedAt ?? 0,
      sortable: true,
      cell: (p) =>
        p.modifiedAt ? (
          <span className="text-sm" title={absoluteTime(p.modifiedAt)}>
            {relativeTime(p.modifiedAt)}
            {p.modifiedBy ? (
              <span className="text-muted-foreground"> · {p.modifiedBy}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      headerClassName: "w-px",
      className: "text-right",
      cell: (p) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit ${p.id}`}
            onClick={() => setEditing(p)}
          >
            <Pencil aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${p.id}`}
            onClick={() => setDeleting(p)}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Profiles</h2>
          <p className="text-sm text-muted-foreground">
            Named managed payloads — the config, secrets, and flags a tier or
            license inherits.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden />
          New profile
        </Button>
      </header>

      {res.error ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Could not load profiles"
          description={res.error}
          action={
            <Button variant="outline" onClick={res.reload}>
              Retry
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={profiles}
          rowKey={(p) => p.id}
          loading={res.loading && profiles.length === 0}
          filterable
          filterPlaceholder="Filter profiles…"
          empty={
            <EmptyState
              icon={<FileCog aria-hidden />}
              title="No profiles yet"
              description="Create a profile to define the managed config, secrets, and flags licenses inherit."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden />
                  New profile
                </Button>
              }
            />
          }
        />
      )}

      <CreateProfileDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingIds={profiles.map((p) => p.id)}
        saving={busy}
        onCreate={(body) => void handleCreate(body)}
      />

      <ProfileDetailDialog
        slug={slug}
        summary={editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />

      {/* `countLicensesUsingProfile` sums `license_profiles` AND `tiers.profile_id`, and a
          non-zero count makes the server 409. So the two referrer classes the old copy said
          would "fall back to their own settings" are precisely the two that BLOCK the delete
          — the dialog promised exactly the case the server rejects. */}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete profile “${deleting?.id ?? ""}”?`}
        description="Only an unreferenced profile can be deleted: while any tier or license still points at it the server refuses. Detach those first. This cannot be undone."
        confirmLabel="Delete profile"
        loading={busy}
        onConfirm={() => void handleDelete()}
      />
    </section>
  );
}

/**
 * `ApiError` carries only status/code/fields, never the server's message, so 409 has to be
 * interpreted per call site. The profiles endpoint uses it for three unrelated things: a
 * duplicate id, "no active catalog", and "profile is still referenced" on delete.
 */
function describeError(
  err: unknown,
  conflict = "That id is already in use.",
): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return conflict;
    if (err.fields?.length) return `Check: ${err.fields.join(", ")}.`;
    return err.message || `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

/** The only 409 a DELETE can produce (`countLicensesUsingProfile` > 0). */
const PROFILE_IN_USE =
  "Tiers or licenses still reference this profile. Detach them first.";
