import * as React from "react";
import { AlertTriangle, KeyRound, RotateCw, Trash2 } from "lucide-react";
import {
  ApiError,
  api,
  type ProductDetail,
  type UpdateProductBody,
} from "../api.js";
import { useAdmin } from "../context.js";
import { useResource } from "../context.js";
import { r } from "../console/routes.js";
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
  useToast,
} from "../components/ui/index.js";
import { qk } from "../console/data/queries.js";
import { mutate } from "../console/data/mutations.js";

/**
 * PLATFORM settings — what is left of this view after spec §8 dissolved the grab-bag.
 *
 * The rule the split follows: a setting belongs to the service that enforces it, and only
 * settings no service owns stay here. The customer-portal toggles moved to Identity (they
 * describe how a human signs in), and the compatibility window moved to Update settings (it
 * describes which builds are offered). What remains is genuinely platform-level: the registry
 * row's name and per-license defaults, the signing keypair every service's documents are signed
 * with, and the destructive product tombstone. A product running no services at all still has
 * all three, which is the test for "does this belong to the platform".
 */
export function Settings({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(qk.product(slug), () =>
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
      defaultMaxOfflineDays: String(product.defaultMaxOfflineDays),
      defaultDeviceLimit: String(product.defaultDeviceLimit),
    });
  }, [product]);

  const dirty =
    form.name !== product.name ||
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

    // No compat window here any more: `PATCH /manage/api/products/<slug>` stopped accepting it
    // when Update settings took ownership, so sending it would be a field the server ignores.
    const body: UpdateProductBody = {
      name: form.name.trim(),
      defaultMaxOfflineDays: offline,
      defaultDeviceLimit: devices,
    };
    setSaving(true);
    try {
      await mutate("updateProduct", slug, body);
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
            Display name and the per-license defaults new licenses inherit.
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
          {/* Operators looked for the compat window here for as long as it lived here; a note
              costs one line and saves the "it disappeared" support round-trip. */}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            The compatibility window (min / max client version) is now edited
            under <span className="font-medium">Update → Update settings</span>,
            beside the feed access modes it constrains.
          </p>
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
      const res = await mutate("rotateProductKey", slug);
      setRotated({
        kid: res.kid,
        publicKey: res.publicKey,
        status: res.status,
      });
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
          <KeyRound aria-hidden className="size-4 text-accent-fg" />
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
              <pre className="overflow-x-auto rounded-sm bg-muted p-2 font-mono text-xs">
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
      await mutate("deleteProduct", slug);
      toast.success(
        "Product disabled",
        `“${product.name}” was tombstoned in the registry.`,
      );
      // Leave the now-defunct product route; head to the next product or the dashboard.
      const next = me.products.find((prod) => prod.slug !== slug);
      window.location.hash = next ? r.overview(next.slug) : r.home();
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
