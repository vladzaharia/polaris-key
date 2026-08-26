import * as React from "react";
import {
  AlertTriangle,
  Download,
  Globe2,
  KeyRound,
  Mail,
  RotateCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  ApiError,
  api,
  type PortalProductSettings,
  type ProductDetail,
  type UpdatePortalSettingsBody,
  type UpdateProductBody,
} from "../api.js";
import { useAdmin } from "../context.js";
import { invalidate, useResource } from "../context.js";
import { hashFor } from "../route.js";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Switch,
  useToast,
} from "../components/ui/index.js";

/**
 * Product settings. Edits the platform-registry row via the endpoints `api.ts` exposes:
 * `updateProduct` (name / compat window / defaults / admin group), `rotateProductKey` (with a
 * confirm, surfacing the new kid + public key), `putProductSecret` (write-only secret), and the
 * destructive `deleteProduct` (ConfirmDialog gated). Every mutation toasts + invalidates the
 * cached product so the form reflects the server.
 */
export function Settings({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(`product:${slug}`, () =>
    api.product(slug).then((r) => r.product),
  );

  return (
    <section aria-labelledby="settings-title" className="space-y-6">
      <header className="space-y-1">
        <h2
          id="settings-title"
          className="text-xl font-semibold tracking-tight"
        >
          Settings
        </h2>
        <p className="text-sm text-muted-foreground">
          Registry settings for{" "}
          <span className="font-medium text-foreground">{slug}</span>.
        </p>
      </header>

      {loading && !data ? (
        <SettingsSkeleton />
      ) : error && !data ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load settings"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
          }
        />
      ) : data ? (
        <div className="space-y-6">
          <GeneralCard slug={slug} product={data} />
          <PortalCard slug={slug} product={data} />
          <KeyCard slug={slug} product={data} />
          <DangerCard slug={slug} product={data} />
        </div>
      ) : null}
    </section>
  );
}

// ── general ───────────────────────────────────────────────────────────────────

function GeneralCard({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const toast = useToast();
  const [form, setForm] = React.useState({
    name: product.name,
    compatMin: product.compatMin,
    compatMax: product.compatMax,
    defaultMaxOfflineDays: String(product.defaultMaxOfflineDays),
    defaultDeviceLimit: String(product.defaultDeviceLimit),
  });
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );

  // Re-seed when the underlying product changes (e.g. after a re-sync invalidate).
  React.useEffect(() => {
    setForm({
      name: product.name,
      compatMin: product.compatMin,
      compatMax: product.compatMax,
      defaultMaxOfflineDays: String(product.defaultMaxOfflineDays),
      defaultDeviceLimit: String(product.defaultDeviceLimit),
    });
  }, [product]);

  const dirty =
    form.name !== product.name ||
    form.compatMin !== product.compatMin ||
    form.compatMax !== product.compatMax ||
    form.defaultMaxOfflineDays !== String(product.defaultMaxOfflineDays) ||
    form.defaultDeviceLimit !== String(product.defaultDeviceLimit);

  const set =
    (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const offline = Number(form.defaultMaxOfflineDays);
    const devices = Number(form.defaultDeviceLimit);
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Name is required.";
    if (!Number.isFinite(offline) || offline < 0)
      errs.defaultMaxOfflineDays = "Must be a non-negative number.";
    if (!Number.isFinite(devices) || devices < 0)
      errs.defaultDeviceLimit = "Must be a non-negative number.";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const body: UpdateProductBody = {
      name: form.name.trim(),
      compatMin: form.compatMin.trim(),
      compatMax: form.compatMax.trim(),
      defaultMaxOfflineDays: offline,
      defaultDeviceLimit: devices,
    };
    setSaving(true);
    try {
      await api.updateProduct(slug, body);
      invalidate(`product:${slug}`);
      toast.success("Settings saved");
    } catch (err) {
      if (err instanceof ApiError && err.fields?.length) {
        setFieldErrors(
          Object.fromEntries(err.fields.map((f) => [f, "Invalid value."])),
        );
      }
      toast.error(
        "Couldn’t save settings",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            Display name, compatibility window, and per-license defaults.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            error={fieldErrors.name}
            className="sm:col-span-2"
          >
            <Input
              value={form.name}
              onChange={set("name")}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Compat min"
            help="Lowest client version this product supports."
          >
            <Input
              value={form.compatMin}
              onChange={set("compatMin")}
              placeholder="0.0.0"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Compat max"
            help="Highest supported version (blank for none)."
          >
            <Input
              value={form.compatMax}
              onChange={set("compatMax")}
              placeholder="latest"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Default max offline days"
            error={fieldErrors.defaultMaxOfflineDays}
          >
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={form.defaultMaxOfflineDays}
              onChange={set("defaultMaxOfflineDays")}
            />
          </Field>
          <Field
            label="Default device limit"
            error={fieldErrors.defaultDeviceLimit}
          >
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={form.defaultDeviceLimit}
              onChange={set("defaultDeviceLimit")}
            />
          </Field>
        </CardContent>
        <CardFooter>
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

// ── customer portal ───────────────────────────────────────────────────────────

const DEFAULT_PORTAL_SETTINGS: PortalProductSettings = {
  portalEnabled: true,
  oidcEnabled: true,
  magicEnabled: true,
  licenseKeyClaimEnabled: true,
  releasesEnabled: true,
  branding: null,
  modifiedAt: 0,
};

type PortalToggleKey = Exclude<keyof UpdatePortalSettingsBody, "branding">;

function PortalCard({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const toast = useToast();
  const settings = product.portalSettings ?? DEFAULT_PORTAL_SETTINGS;
  const [form, setForm] = React.useState<Required<UpdatePortalSettingsBody>>({
    portalEnabled: settings.portalEnabled,
    oidcEnabled: settings.oidcEnabled,
    magicEnabled: settings.magicEnabled,
    licenseKeyClaimEnabled: settings.licenseKeyClaimEnabled,
    releasesEnabled: settings.releasesEnabled,
    branding: settings.branding ?? null,
  });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setForm({
      portalEnabled: settings.portalEnabled,
      oidcEnabled: settings.oidcEnabled,
      magicEnabled: settings.magicEnabled,
      licenseKeyClaimEnabled: settings.licenseKeyClaimEnabled,
      releasesEnabled: settings.releasesEnabled,
      branding: settings.branding ?? null,
    });
  }, [settings]);

  const dirty =
    form.portalEnabled !== settings.portalEnabled ||
    form.oidcEnabled !== settings.oidcEnabled ||
    form.magicEnabled !== settings.magicEnabled ||
    form.licenseKeyClaimEnabled !== settings.licenseKeyClaimEnabled ||
    form.releasesEnabled !== settings.releasesEnabled;

  const setToggle =
    (key: PortalToggleKey) =>
    (checked: boolean): void =>
      setForm((current) => ({ ...current, [key]: checked }));

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updatePortalSettings(slug, {
        portalEnabled: form.portalEnabled,
        oidcEnabled: form.oidcEnabled,
        magicEnabled: form.magicEnabled,
        licenseKeyClaimEnabled: form.licenseKeyClaimEnabled,
        releasesEnabled: form.releasesEnabled,
      });
      invalidate(`product:${slug}`);
      toast.success("Portal settings saved");
    } catch (err) {
      toast.error(
        "Couldn’t save portal settings",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  const rows: Array<{
    key: PortalToggleKey;
    label: string;
    description: string;
    icon: React.ReactNode;
  }> = [
    {
      key: "portalEnabled",
      label: "Customer portal",
      description: "Show this product’s licenses to verified customers.",
      icon: <Globe2 aria-hidden className="size-4 text-primary" />,
    },
    {
      key: "oidcEnabled",
      label: "OIDC access",
      description: "Allow portal account linking from the shared OIDC subject.",
      icon: <ShieldCheck aria-hidden className="size-4 text-primary" />,
    },
    {
      key: "magicEnabled",
      label: "Email magic links",
      description: "Allow verified email sign-in to link matching licenses.",
      icon: <Mail aria-hidden className="size-4 text-primary" />,
    },
    {
      key: "licenseKeyClaimEnabled",
      label: "License-key claim",
      description: "Allow customers to add a license by entering a valid key.",
      icon: <KeyRound aria-hidden className="size-4 text-primary" />,
    },
    {
      key: "releasesEnabled",
      label: "Release downloads",
      description: "Expose entitled release artifacts in the customer portal.",
      icon: <Download aria-hidden className="size-4 text-primary" />,
    },
  ];

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Customer portal</CardTitle>
          <CardDescription>
            Per-product module and access settings for the root customer portal.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {rows.map((row) => {
            const id = `portal-${slug}-${row.key}`;
            return (
              <div
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    {row.icon}
                  </div>
                  <div className="min-w-0">
                    <label
                      htmlFor={id}
                      className="text-sm font-medium text-foreground"
                    >
                      {row.label}
                    </label>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                      {row.description}
                    </p>
                  </div>
                </div>
                <Switch
                  id={id}
                  checked={Boolean(form[row.key])}
                  onCheckedChange={setToggle(row.key)}
                />
              </div>
            );
          })}
        </CardContent>
        <CardFooter>
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save portal settings
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

// ── signing key ─────────────────────────────────────────────────────────────────

function KeyCard({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const toast = useToast();
  const [confirm, setConfirm] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);
  const [rotated, setRotated] = React.useState<{
    kid: string;
    publicKey: string;
    status?: string;
  } | null>(null);

  const onRotate = async (): Promise<void> => {
    setRotating(true);
    try {
      const res = await api.rotateProductKey(slug);
      setRotated({
        kid: res.kid,
        publicKey: res.publicKey,
        status: res.status,
      });
      invalidate(`product:${slug}`);
      toast.success("Signing key prepared", `New key ${res.kid} is staged.`);
      setConfirm(false);
    } catch (err) {
      toast.error(
        "Couldn’t rotate the key",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setRotating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound aria-hidden className="size-4 text-primary" />
          Signing key
        </CardTitle>
        <CardDescription>
          The Ed25519 keypair this product signs config with. Preparing a key
          publishes it to discovery first; activation happens after a
          trust-refresh window.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="text-sm">
          <dt className="text-xs uppercase tracking-wider text-muted-foreground">
            Active key id
          </dt>
          <dd className="font-mono">{product.signingKid}</dd>
        </dl>
        {rotated ? (
          <div
            role="status"
            aria-live="polite"
            className="space-y-2 rounded-md border border-success/40 bg-success/10 p-3"
          >
            <p className="text-sm font-medium text-foreground">
              New key {rotated.status ?? "staged"}:{" "}
              <span className="font-mono">{rotated.kid}</span>
            </p>
            <div>
              <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                Public key
              </p>
              <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                {rotated.publicKey}
              </pre>
            </div>
          </div>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={() => setConfirm(true)}>
          <RotateCw aria-hidden />
          Prepare signing key
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Prepare a signing key?"
        description="A new Ed25519 key will be minted as staged and published for trust refresh before activation."
        confirmLabel="Prepare"
        confirmVariant="primary"
        loading={rotating}
        onConfirm={onRotate}
      />
    </Card>
  );
}

// ── danger zone ─────────────────────────────────────────────────────────────────

function DangerCard({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const toast = useToast();
  const { me } = useAdmin();
  const [confirm, setConfirm] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const onDelete = async (): Promise<void> => {
    setDeleting(true);
    try {
      await api.deleteProduct(slug);
      invalidate(`product:${slug}`);
      toast.success(
        "Product disabled",
        `“${product.name}” was tombstoned in the registry.`,
      );
      // Leave the now-defunct product route; head to the next product or the dashboard.
      const next = me.products.find((prod) => prod.slug !== slug);
      window.location.hash = next
        ? hashFor({ kind: "product", slug: next.slug, view: "licenses" })
        : hashFor({ kind: "dashboard" });
    } catch (err) {
      toast.error(
        "Couldn’t disable the product",
        err instanceof Error ? err.message : undefined,
      );
      setDeleting(false);
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Disabling a product tombstones it, disables licenses, deauthorizes
          devices, revokes hot credentials, and preserves audit history.
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="destructive" onClick={() => setConfirm(true)}>
          <Trash2 aria-hidden />
          Disable product
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disable “${product.name}”?`}
        description="This leaves audit/runtime data in place while removing the product from active administration and runtime use."
        confirmLabel="Disable product"
        loading={deleting}
        onConfirm={onDelete}
      />
    </Card>
  );
}

function SettingsSkeleton(): React.ReactElement {
  return (
    <div className="space-y-6" aria-hidden>
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
