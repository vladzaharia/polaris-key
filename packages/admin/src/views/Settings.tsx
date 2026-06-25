import * as React from "react";
import { AlertTriangle, KeyRound, RotateCw, Trash2 } from "lucide-react";
import { ApiError, api, type ProductDetail, type UpdateProductBody } from "../api.js";
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
  const { data, loading, error, reload } = useResource(`product:${slug}`, () => api.product(slug));

  return (
    <section aria-labelledby="settings-title" className="space-y-6">
      <header className="space-y-1">
        <h2 id="settings-title" className="text-xl font-semibold tracking-tight">
          Settings
        </h2>
        <p className="text-sm text-muted-foreground">
          Registry settings for <span className="font-medium text-foreground">{slug}</span>.
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
          <GeneralCard slug={slug} product={data.product} />
          <SecretCard slug={slug} />
          <KeyCard slug={slug} product={data.product} />
          <DangerCard slug={slug} product={data.product} />
        </div>
      ) : null}
    </section>
  );
}

// ── general ───────────────────────────────────────────────────────────────────

function GeneralCard({ slug, product }: { slug: string; product: ProductDetail }): React.ReactElement {
  const toast = useToast();
  const [form, setForm] = React.useState({
    name: product.name,
    compatMin: product.compatMin,
    compatMax: product.compatMax,
    defaultMaxOfflineDays: String(product.defaultMaxOfflineDays),
    defaultMachineLimit: String(product.defaultMachineLimit),
    adminGroup: product.adminGroup ?? "",
  });
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  // Re-seed when the underlying product changes (e.g. after a re-sync invalidate).
  React.useEffect(() => {
    setForm({
      name: product.name,
      compatMin: product.compatMin,
      compatMax: product.compatMax,
      defaultMaxOfflineDays: String(product.defaultMaxOfflineDays),
      defaultMachineLimit: String(product.defaultMachineLimit),
      adminGroup: product.adminGroup ?? "",
    });
  }, [product]);

  const dirty =
    form.name !== product.name ||
    form.compatMin !== product.compatMin ||
    form.compatMax !== product.compatMax ||
    form.defaultMaxOfflineDays !== String(product.defaultMaxOfflineDays) ||
    form.defaultMachineLimit !== String(product.defaultMachineLimit) ||
    form.adminGroup !== (product.adminGroup ?? "");

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const offline = Number(form.defaultMaxOfflineDays);
    const machines = Number(form.defaultMachineLimit);
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Name is required.";
    if (!Number.isFinite(offline) || offline < 0) errs.defaultMaxOfflineDays = "Must be a non-negative number.";
    if (!Number.isFinite(machines) || machines < 0) errs.defaultMachineLimit = "Must be a non-negative number.";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const body: UpdateProductBody = {
      name: form.name.trim(),
      compatMin: form.compatMin.trim(),
      compatMax: form.compatMax.trim(),
      defaultMaxOfflineDays: offline,
      defaultMachineLimit: machines,
      adminGroup: form.adminGroup.trim(),
    };
    setSaving(true);
    try {
      await api.updateProduct(slug, body);
      invalidate(`product:${slug}`);
      toast.success("Settings saved");
    } catch (err) {
      if (err instanceof ApiError && err.fields?.length) {
        setFieldErrors(Object.fromEntries(err.fields.map((f) => [f, "Invalid value."])));
      }
      toast.error("Couldn’t save settings", err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Display name, compatibility window, and per-license defaults.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={fieldErrors.name} className="sm:col-span-2">
          <Input value={form.name} onChange={set("name")} autoComplete="off" />
        </Field>
        <Field label="Compat min" help="Lowest client version this product supports.">
          <Input value={form.compatMin} onChange={set("compatMin")} placeholder="0.0.0" autoComplete="off" />
        </Field>
        <Field label="Compat max" help="Highest supported version (blank for none).">
          <Input value={form.compatMax} onChange={set("compatMax")} placeholder="latest" autoComplete="off" />
        </Field>
        <Field label="Default max offline days" error={fieldErrors.defaultMaxOfflineDays}>
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            value={form.defaultMaxOfflineDays}
            onChange={set("defaultMaxOfflineDays")}
          />
        </Field>
        <Field label="Default device limit" error={fieldErrors.defaultMachineLimit}>
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            value={form.defaultMachineLimit}
            onChange={set("defaultMachineLimit")}
          />
        </Field>
        <Field
          label="Admin group"
          help="OIDC group whose members may administer this product. Blank to leave unset."
          className="sm:col-span-2"
        >
          <Input value={form.adminGroup} onChange={set("adminGroup")} placeholder="e.g. djdl-admins" autoComplete="off" />
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

// ── secrets ─────────────────────────────────────────────────────────────────────

function SecretCard({ slug }: { slug: string }): React.ReactElement {
  const toast = useToast();
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; value?: string }>({});

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const errs: { name?: string; value?: string } = {};
    if (!name.trim()) errs.name = "A secret name is required.";
    if (!value) errs.value = "A value is required.";
    setErrors(errs);
    if (errs.name || errs.value) return;
    setSaving(true);
    try {
      await api.putProductSecret(slug, name.trim(), value);
      toast.success("Secret saved", `“${name.trim()}” was stored. Its value is never shown again.`);
      setName("");
      setValue("");
    } catch (err) {
      toast.error("Couldn’t save secret", err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
      <CardHeader>
        <CardTitle>Product secrets</CardTitle>
        <CardDescription>
          Set a write-only secret (e.g. an OIDC client secret or a minter key). Values are stored encrypted and
          never read back.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Secret name" error={errors.name}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. oidc_client_secret"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Value" error={errors.value}>
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
          />
        </Field>
      </CardContent>
      <CardFooter>
        <Button type="submit" variant="secondary" loading={saving}>
          Set secret
        </Button>
      </CardFooter>
      </form>
    </Card>
  );
}

// ── signing key ─────────────────────────────────────────────────────────────────

function KeyCard({ slug, product }: { slug: string; product: ProductDetail }): React.ReactElement {
  const toast = useToast();
  const [confirm, setConfirm] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);
  const [rotated, setRotated] = React.useState<{ kid: string; publicKey: string } | null>(null);

  const onRotate = async (): Promise<void> => {
    setRotating(true);
    try {
      const res = await api.rotateProductKey(slug);
      setRotated({ kid: res.kid, publicKey: res.publicKey });
      invalidate(`product:${slug}`);
      toast.success("Signing key rotated", `New key ${res.kid} is now active.`);
      setConfirm(false);
    } catch (err) {
      toast.error("Couldn’t rotate the key", err instanceof Error ? err.message : undefined);
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
          The Ed25519 keypair this product signs config with. Rotating mints a new key and publishes it to the
          JWKS; old signatures stay verifiable until clients refresh.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="text-sm">
          <dt className="text-xs uppercase tracking-wider text-muted-foreground">Active key id</dt>
          <dd className="font-mono">{product.signingKid}</dd>
        </dl>
        {rotated ? (
          <div role="status" aria-live="polite" className="space-y-2 rounded-md border border-success/40 bg-success/10 p-3">
            <p className="text-sm font-medium text-foreground">
              New key minted: <span className="font-mono">{rotated.kid}</span>
            </p>
            <div>
              <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">Public key</p>
              <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{rotated.publicKey}</pre>
            </div>
          </div>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={() => setConfirm(true)}>
          <RotateCw aria-hidden />
          Rotate signing key
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Rotate the signing key?"
        description="A new Ed25519 key will be minted and published. This can’t be undone."
        confirmLabel="Rotate"
        confirmVariant="primary"
        loading={rotating}
        onConfirm={onRotate}
      />
    </Card>
  );
}

// ── danger zone ─────────────────────────────────────────────────────────────────

function DangerCard({ slug, product }: { slug: string; product: ProductDetail }): React.ReactElement {
  const toast = useToast();
  const { me } = useAdmin();
  const [confirm, setConfirm] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const onDelete = async (): Promise<void> => {
    setDeleting(true);
    try {
      await api.deleteProduct(slug);
      invalidate(`product:${slug}`);
      toast.success("Product deleted", `“${product.name}” was removed from the registry.`);
      // Leave the now-defunct product route; head to the next product or the dashboard.
      const next = me.products.find((prod) => prod.slug !== slug);
      window.location.hash = next ? hashFor({ kind: "product", slug: next.slug, view: "licenses" }) : hashFor({ kind: "dashboard" });
    } catch (err) {
      toast.error("Couldn’t delete the product", err instanceof Error ? err.message : undefined);
      setDeleting(false);
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Deleting a product removes its registry row, licenses, keys, and config. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="destructive" onClick={() => setConfirm(true)}>
          <Trash2 aria-hidden />
          Delete product
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete “${product.name}”?`}
        description="This permanently removes the product and every license, key, and config under it. This action cannot be undone."
        confirmLabel="Delete product"
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
