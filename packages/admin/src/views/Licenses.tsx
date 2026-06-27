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
  DialogActionBar,
  DialogBody,
  DialogContent,
  DialogDescription,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
  type ColumnDef,
} from "../components/ui/index.js";
import {
  ChannelList,
  ChannelMultiSelect,
  dateInputToEpoch,
  epochToDateInput,
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
        accessor: (r) => r.deviceCount,
        cell: (r) => <span className="tabular-nums">{r.deviceCount}</span>,
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
          onRowClickLabel={(r) => `Open license ${r.name || r.id}`}
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
  const [expires, setExpires] = React.useState("");
  const [maxOffline, setMaxOffline] = React.useState("");
  const [channels, setChannels] = React.useState<string[]>([]);
  const [minVersion, setMinVersion] = React.useState("");
  const [maxVersion, setMaxVersion] = React.useState("");
  const [fieldErrors, setFieldErrors] = React.useState<
    Partial<
      Record<"name" | "email" | "expires" | "maxOffline" | "versions", string>
    >
  >({});
  const [activeTab, setActiveTab] = React.useState("holder");
  const [submitting, setSubmitting] = React.useState(false);
  const [mintedKey, setMintedKey] = React.useState<string | null>(null);
  const [createdId, setCreatedId] = React.useState<string | null>(null);
  const selectedTier = tiers.find((t) => t.id === tier) ?? null;

  // Reset transient state whenever the dialog is (re)opened.
  React.useEffect(() => {
    if (open) {
      setName("");
      setEmail("");
      setTier("__none__");
      setSelectedProfiles([]);
      setExpires("");
      setMaxOffline("");
      setChannels([]);
      setMinVersion("");
      setMaxVersion("");
      setFieldErrors({});
      setActiveTab("holder");
      setMintedKey(null);
      setCreatedId(null);
      setSubmitting(false);
    }
  }, [open]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const nextErrors = validateLicenseCreateForm({
      name,
      email,
      expires,
      maxOffline,
      minVersion,
      maxVersion,
    });
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setActiveTab(nextErrors.name || nextErrors.email ? "holder" : "policy");
      return;
    }
    setSubmitting(true);
    try {
      const body: CreateLicenseBody = {
        name: name.trim(),
        email: email.trim(),
      };
      if (tier !== "__none__") body.tier = tier;
      if (selectedProfiles.length > 0) body.profiles = selectedProfiles;
      const nextExpiry = dateInputToEpoch(expires);
      if (nextExpiry != null) body.expiresAt = nextExpiry;
      if (maxOffline.trim()) body.maxOfflineDays = Number(maxOffline);
      if (channels.length > 0) body.channels = channels;
      if (minVersion.trim()) body.minVersion = minVersion.trim();
      if (maxVersion.trim()) body.maxVersion = maxVersion.trim();
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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create license</DialogTitle>
          <DialogDescription>
            {mintedKey
              ? "The license is created. Copy its key now — it is shown only once."
              : "Add a license holder, policy overrides, and their first key."}
          </DialogDescription>
        </DialogHeader>

        {mintedKey ? (
          <>
            <DialogBody>
              <div className="space-y-4">
                <OneTimeKeyPanel value={mintedKey} />
              </div>
            </DialogBody>
            <DialogActionBar>
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
            </DialogActionBar>
          </>
        ) : (
          <form onSubmit={submit} className="contents" noValidate>
            <DialogBody>
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="w-full">
                  <TabsTrigger value="holder" className="flex-1">
                    Holder
                  </TabsTrigger>
                  <TabsTrigger value="policy" className="flex-1">
                    Policy
                  </TabsTrigger>
                  <TabsTrigger value="profiles" className="flex-1">
                    Profiles
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="holder" className="space-y-4">
                  <Field label="Name" required error={fieldErrors.name}>
                    <Input
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        clearFieldError(setFieldErrors, "name");
                      }}
                      placeholder="Ada Lovelace"
                      autoFocus
                    />
                  </Field>
                  <Field label="Email" required error={fieldErrors.email}>
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        clearFieldError(setFieldErrors, "email");
                      }}
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
                </TabsContent>

                <TabsContent value="policy" className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Expires"
                      help="Optional. Blank means no license expiry."
                      error={fieldErrors.expires}
                    >
                      <Input
                        type="date"
                        value={expires}
                        onChange={(e) => {
                          setExpires(e.target.value);
                          clearFieldError(setFieldErrors, "expires");
                        }}
                      />
                    </Field>
                    <Field
                      label="Max offline days"
                      help="Optional. Overrides the product default for this license."
                      error={fieldErrors.maxOffline}
                    >
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        value={maxOffline}
                        onChange={(e) => {
                          setMaxOffline(e.target.value);
                          clearFieldError(setFieldErrors, "maxOffline");
                        }}
                        placeholder="e.g. 14"
                      />
                    </Field>
                  </div>
                  <Field
                    label="Release channels"
                    help="Optional. Leave empty to inherit tier or product release defaults."
                  >
                    <div>
                      <ChannelMultiSelect
                        value={channels}
                        onChange={setChannels}
                        idPrefix="create-license-channel"
                      />
                    </div>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Minimum version"
                      help="Optional floor for app updates."
                      error={fieldErrors.versions}
                    >
                      <Input
                        value={minVersion}
                        onChange={(e) => {
                          setMinVersion(e.target.value);
                          clearFieldError(setFieldErrors, "versions");
                        }}
                        placeholder="e.g. 1.2.0"
                      />
                    </Field>
                    <Field label="Maximum version" help="Optional ceiling.">
                      <Input
                        value={maxVersion}
                        onChange={(e) => {
                          setMaxVersion(e.target.value);
                          clearFieldError(setFieldErrors, "versions");
                        }}
                        placeholder="e.g. 2.0.0"
                      />
                    </Field>
                  </div>
                  <PolicySummary
                    expires={expires}
                    maxOffline={maxOffline}
                    channels={channels}
                    minVersion={minVersion}
                    maxVersion={maxVersion}
                    selectedTier={selectedTier}
                  />
                </TabsContent>

                <TabsContent value="profiles" className="space-y-4">
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
                            const checked = selectedProfiles.includes(
                              profile.id,
                            );
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
                                        : prev.filter(
                                            (id) => id !== profile.id,
                                          ),
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
                </TabsContent>
              </Tabs>
            </DialogBody>
            <DialogActionBar>
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
            </DialogActionBar>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type FieldErrors = Partial<
  Record<"name" | "email" | "expires" | "maxOffline" | "versions", string>
>;

function validateLicenseCreateForm(input: {
  name: string;
  email: string;
  expires: string;
  maxOffline: string;
  minVersion: string;
  maxVersion: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.name.trim()) errors.name = "Enter the holder name.";
  if (!input.email.trim()) errors.email = "Enter the holder email.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))
    errors.email = "Enter a valid email address.";
  if (input.expires.trim() && dateInputToEpoch(input.expires) == null)
    errors.expires = "Use a valid expiry date.";
  if (input.maxOffline.trim()) {
    const value = Number(input.maxOffline);
    if (!Number.isInteger(value) || value < 0)
      errors.maxOffline = "Enter a whole number of days, 0 or higher.";
  }
  const min = input.minVersion.trim();
  const max = input.maxVersion.trim();
  if (min && max && compareDottedVersion(min, max) > 0)
    errors.versions = "Minimum version must be lower than maximum version.";
  return errors;
}

function clearFieldError(
  setErrors: React.Dispatch<React.SetStateAction<FieldErrors>>,
  field: keyof FieldErrors,
): void {
  setErrors((prev) => {
    if (!prev[field]) return prev;
    const next = { ...prev };
    delete next[field];
    return next;
  });
}

function compareDottedVersion(a: string, b: string): number {
  const parse = (value: string): number[] | null => {
    if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
    return value.split(".").map((part) => Number(part));
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function PolicySummary({
  expires,
  maxOffline,
  channels,
  minVersion,
  maxVersion,
  selectedTier,
}: {
  expires: string;
  maxOffline: string;
  channels: string[];
  minVersion: string;
  maxVersion: string;
  selectedTier: {
    policyDeviceLimit: number | null;
    channels: string[];
  } | null;
}): React.ReactElement {
  const expiryEpoch = dateInputToEpoch(expires);
  const version =
    minVersion.trim() || maxVersion.trim()
      ? `${minVersion.trim() || "any"} to ${maxVersion.trim() || "any"}`
      : "Inherits product compatibility";
  const tierChannels = selectedTier?.channels ?? [];
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        Effective policy summary
      </p>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <SummaryItem
          label="Expiry"
          value={expiryEpoch ? epochToDateInput(expiryEpoch) : "No expiry"}
        />
        <SummaryItem
          label="Offline grace"
          value={
            maxOffline.trim() ? `${Number(maxOffline)} days` : "Product default"
          }
        />
        <SummaryItem
          label="Device limit"
          value={
            selectedTier?.policyDeviceLimit != null
              ? `${selectedTier.policyDeviceLimit} devices from tier`
              : "Product default"
          }
        />
        <SummaryItem
          label="Channels"
          value={
            channels.length
              ? channels.join(", ")
              : tierChannels.length
                ? `${tierChannels.join(", ")} from tier`
                : "Product default"
          }
        />
        <SummaryItem label="Version range" value={version} />
      </dl>
    </div>
  );
}

function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}
