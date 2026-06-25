import * as React from "react";
import { Plus, Users } from "lucide-react";
import {
  api,
  type CreateLicenseBody,
  type LicenseSummary,
  type ProfileSummary,
} from "../api.js";
import { invalidate, useResource } from "../context.js";
import { navigate } from "../route.js";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
  type ColumnDef,
} from "../components/ui/index.js";
import {
  ChannelList,
  LicenseStatusBadge,
  OneTimeKeyPanel,
} from "./licenses/shared.js";

/**
 * The per-product Licenses list. Loads the license summaries, renders them in a sortable +
 * filterable table, and offers a "Create license" dialog. On a successful create the minted key
 * is surfaced ONCE in a copy panel (the API never returns it again), then the operator can open
 * the new license's detail page.
 */
export function Licenses({ slug }: { slug: string }): React.ReactElement {
  const key = `licenses:${slug}`;
  const { data, loading, error, reload } = useResource(key, () =>
    api.licenses(slug),
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const licenses = data?.licenses ?? [];

  const columns: ColumnDef<LicenseSummary>[] = React.useMemo(
    () => [
      {
        id: "name",
        header: "Name",
        sortable: true,
        accessor: (r) => r.name,
        cell: (r) => (
          <div className="flex flex-col">
            <span className="font-medium text-foreground">{r.name || "—"}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {r.id}
            </span>
          </div>
        ),
      },
      {
        id: "email",
        header: "Email",
        sortable: true,
        accessor: (r) => r.email,
        cell: (r) => r.email || "—",
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        accessor: (r) => r.status,
        cell: (r) => <LicenseStatusBadge status={r.status} />,
      },
      {
        id: "keys",
        header: "Keys",
        sortable: true,
        accessor: (r) => r.activeKeyCount,
        cell: (r) => (
          <span className="tabular-nums">
            {r.activeKeyCount}
            <span className="text-muted-foreground"> / {r.keyCount}</span>
          </span>
        ),
      },
      {
        id: "devices",
        header: "Devices",
        sortable: true,
        accessor: (r) => r.machineCount,
        cell: (r) => <span className="tabular-nums">{r.machineCount}</span>,
      },
      {
        id: "tier",
        header: "Tier",
        sortable: true,
        accessor: (r) => r.tier ?? "",
        cell: (r) =>
          r.tier ? (
            <Badge variant="outline">{r.tier}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "channels",
        header: "Channels",
        cell: (r) => <ChannelList channels={r.channels} />,
      },
      {
        id: "identity",
        header: "Identity",
        sortable: true,
        accessor: (r) => r.identityProvider,
        cell: (r) => (
          <Badge
            variant={r.identityProvider === "oidc" ? "primary" : "default"}
          >
            {r.identityProvider}
          </Badge>
        ),
      },
    ],
    [],
  );

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Licenses</h2>
          <p className="text-sm text-muted-foreground">
            Manage license holders, keys, and devices for {slug}.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden />
          Create license
        </Button>
      </header>

      {error ? (
        <EmptyState
          title="Could not load licenses"
          description={error}
          action={
            <Button variant="outline" onClick={reload}>
              Retry
            </Button>
          }
        />
      ) : !loading && licenses.length === 0 ? (
        <EmptyState
          icon={<Users aria-hidden />}
          title="No licenses yet"
          description="Create the first license to mint a key and authorize devices."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden />
              Create license
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={licenses}
          rowKey={(r) => r.id}
          loading={loading}
          filterable
          filterPlaceholder="Filter by name, email, status…"
          onRowClick={(r) =>
            navigate({ kind: "product", slug, view: "license", id: r.id })
          }
        />
      )}

      <CreateLicenseDialog
        slug={slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          invalidate(key);
          reload();
        }}
      />
    </section>
  );
}

function CreateLicenseDialog({
  slug,
  open,
  onOpenChange,
  onCreated,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}): React.ReactElement {
  const toast = useToast();
  const tiersRes = useResource(`tiers:${slug}`, () => api.tiers(slug));
  const profilesRes = useResource(`profiles:${slug}`, () => api.profiles(slug));
  const tiers = tiersRes.data?.tiers ?? [];
  const profiles = profilesRes.data?.profiles ?? [];
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [tier, setTier] = React.useState("__none__");
  const [selectedProfiles, setSelectedProfiles] = React.useState<string[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [mintedKey, setMintedKey] = React.useState<string | null>(null);
  const [createdId, setCreatedId] = React.useState<string | null>(null);

  // Reset transient state whenever the dialog is (re)opened.
  React.useEffect(() => {
    if (open) {
      setName("");
      setEmail("");
      setTier("__none__");
      setSelectedProfiles([]);
      setMintedKey(null);
      setCreatedId(null);
      setSubmitting(false);
    }
  }, [open]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setSubmitting(true);
    try {
      const body: CreateLicenseBody = {
        name: name.trim(),
        email: email.trim(),
      };
      if (tier !== "__none__") body.tier = tier;
      if (selectedProfiles.length > 0) body.profiles = selectedProfiles;
      const res = await api.createLicense(slug, body);
      setMintedKey(res.key);
      setCreatedId(res.licenseId);
      toast.success("License created", `${name.trim()} was added.`);
      onCreated();
    } catch (err) {
      toast.error(
        "Could not create license",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create license</DialogTitle>
          <DialogDescription>
            {mintedKey
              ? "The license is created. Copy its key now — it is shown only once."
              : "Add a license holder and mint their first key."}
          </DialogDescription>
        </DialogHeader>

        {mintedKey ? (
          <div className="space-y-4">
            <OneTimeKeyPanel value={mintedKey} />
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
              {createdId ? (
                <Button
                  onClick={() => {
                    onOpenChange(false);
                    navigate({
                      kind: "product",
                      slug,
                      view: "license",
                      id: createdId,
                    });
                  }}
                >
                  Open license
                </Button>
              ) : null}
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Field label="Name" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
                autoFocus
              />
            </Field>
            <Field label="Email" required>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ada@example.com"
              />
            </Field>
            <Field
              label="Tier"
              help="Optional. Applies the tier's policy + profile."
            >
              <Select value={tier} onValueChange={setTier}>
                <SelectTrigger aria-label="Tier">
                  <SelectValue placeholder="No tier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No tier</SelectItem>
                  {tiers.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label || t.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Profiles"
              help="Optional. Profiles apply in the order selected here."
            >
              <div className="rounded-md border border-border p-3">
                {profiles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No profiles are defined.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {profiles.map((profile: ProfileSummary) => {
                      const checked = selectedProfiles.includes(profile.id);
                      return (
                        <label
                          key={profile.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) => {
                              setSelectedProfiles((prev) =>
                                value
                                  ? [...prev, profile.id]
                                  : prev.filter((id) => id !== profile.id),
                              );
                            }}
                          />
                          <span>{profile.name || profile.id}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {profile.id}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={submitting}
                disabled={!name.trim() || !email.trim()}
              >
                Create license
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
