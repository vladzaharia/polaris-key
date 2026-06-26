import * as React from "react";
import { AlertTriangle, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import {
  api,
  ApiError,
  type ProfileSummary,
  type TierBody,
  type TierSummary,
} from "../api.js";
import { invalidate, useResource } from "../context.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  useToast,
  type ColumnDef,
} from "../components/ui/index.js";
import {
  CreateTierDialog,
  EditTierDialog,
  type ProfileOption,
} from "./tiers/dialogs.js";

/**
 * Tiers view: list every tier for a product, create new tiers, edit an existing tier's label,
 * profile, policies, channels, and version window, and delete tiers. Tiers are the templates
 * licenses inherit from — a profile (managed payload) plus policy + channel + version defaults.
 */
export function Tiers({ slug }: { slug: string }): React.ReactElement {
  const toast = useToast();
  const tiersRes = useResource(`tiers:${slug}`, () => api.tiers(slug));
  // Profiles are needed for the create/edit profile selectors; a soft dependency (the tier
  // editor still works if this fails — it just shows ids).
  const profilesRes = useResource(`profiles:${slug}`, () => api.profiles(slug));

  const tiers = tiersRes.data?.tiers ?? [];
  const profiles: ProfileOption[] = (profilesRes.data?.profiles ?? []).map(
    (p: ProfileSummary) => ({
      id: p.id,
      name: p.name,
    }),
  );
  const profileName = React.useMemo(() => {
    const map = new Map(profiles.map((p) => [p.id, p.name || p.id]));
    return (id: string | null): string | null =>
      id ? (map.get(id) ?? id) : null;
  }, [profiles]);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TierSummary | null>(null);
  const [deleting, setDeleting] = React.useState<TierSummary | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = (): void => invalidate(`tiers:${slug}`);

  const handleCreate = async (body: TierBody): Promise<void> => {
    setBusy(true);
    try {
      await api.createTier(slug, body);
      toast.success("Tier created", `“${body.id}” is ready to assign.`);
      setCreateOpen(false);
      refresh();
    } catch (err) {
      toast.error("Could not create tier", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (id: string, body: TierBody): Promise<void> => {
    setBusy(true);
    try {
      await api.patchTier(slug, id, body);
      toast.success("Tier updated", `Saved changes to “${id}”.`);
      setEditing(null);
      refresh();
    } catch (err) {
      toast.error("Could not update tier", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteTier(slug, deleting.id);
      toast.success("Tier deleted", `Removed “${deleting.id}”.`);
      setDeleting(null);
      refresh();
    } catch (err) {
      toast.error("Could not delete tier", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<TierSummary>[] = [
    {
      id: "id",
      header: "Id",
      accessor: (t) => t.id,
      sortable: true,
      cell: (t) => <span className="font-mono text-xs">{t.id}</span>,
    },
    {
      id: "label",
      header: "Label",
      accessor: (t) => t.label,
      sortable: true,
      cell: (t) => <span className="font-medium">{t.label || t.id}</span>,
    },
    {
      id: "profile",
      header: "Profile",
      accessor: (t) => t.profile ?? "",
      sortable: true,
      cell: (t) =>
        t.profile ? (
          <Badge variant="primary">{profileName(t.profile)}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "expiry",
      header: "Expiry (days)",
      accessor: (t) => t.policyExpiryDays ?? -1,
      sortable: true,
      cell: (t) =>
        t.policyExpiryDays == null ? (
          <Muted>default</Muted>
        ) : (
          t.policyExpiryDays
        ),
    },
    {
      id: "devices",
      header: "Device limit",
      accessor: (t) => t.policyDeviceLimit ?? -1,
      sortable: true,
      cell: (t) =>
        t.policyDeviceLimit == null ? (
          <Muted>default</Muted>
        ) : (
          t.policyDeviceLimit
        ),
    },
    {
      id: "channels",
      header: "Channels",
      cell: (t) =>
        t.channels.length ? (
          <div className="flex flex-wrap gap-1">
            {t.channels.map((c) => (
              <Badge key={c} variant="outline">
                {c}
              </Badge>
            ))}
          </div>
        ) : (
          <Muted>any</Muted>
        ),
    },
    {
      id: "versions",
      header: "Version window",
      cell: (t) => <VersionWindow min={t.minVersion} max={t.maxVersion} />,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      headerClassName: "w-px",
      className: "text-right",
      cell: (t) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit ${t.id}`}
            onClick={() => setEditing(t)}
          >
            <Pencil aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${t.id}`}
            onClick={() => setDeleting(t)}
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
          <h2 className="text-2xl font-semibold tracking-tight">Tiers</h2>
          <p className="text-sm text-muted-foreground">
            Reusable license templates — a profile plus policy, channel, and
            version defaults.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden />
          New tier
        </Button>
      </header>

      {tiersRes.error ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Could not load tiers"
          description={tiersRes.error}
          action={
            <Button variant="outline" onClick={tiersRes.reload}>
              Retry
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={tiers}
          rowKey={(t) => t.id}
          loading={tiersRes.loading && tiers.length === 0}
          filterable
          filterPlaceholder="Filter tiers…"
          empty={
            <EmptyState
              icon={<Layers aria-hidden />}
              title="No tiers yet"
              description="Create a tier to template the profile, policies, and channels licenses inherit."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden />
                  New tier
                </Button>
              }
            />
          }
        />
      )}

      <CreateTierDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        profiles={profiles}
        existingIds={tiers.map((t) => t.id)}
        saving={busy}
        onCreate={(body) => void handleCreate(body)}
      />

      <EditTierDialog
        tier={editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        profiles={profiles}
        saving={busy}
        onSave={(id, body) => void handleSave(id, body)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete tier “${deleting?.id ?? ""}”?`}
        description="Licenses already assigned to this tier keep their settings, but the tier can no longer be assigned. This cannot be undone."
        confirmLabel="Delete tier"
        loading={busy}
        onConfirm={() => void handleDelete()}
      />
    </section>
  );
}

function Muted({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <span className="text-muted-foreground">{children}</span>;
}

function VersionWindow({
  min,
  max,
}: {
  min: string | null;
  max: string | null;
}): React.ReactElement {
  if (!min && !max) return <Muted>any</Muted>;
  return (
    <span className="font-mono text-xs">
      {min ?? "*"} – {max ?? "*"}
    </span>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "That id is already in use.";
    if (err.fields?.length) return `Check: ${err.fields.join(", ")}.`;
    return err.message || `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : "Request failed.";
}
