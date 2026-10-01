import * as React from "react";
import { AlertTriangle, Info, Undo2 } from "lucide-react";
import {
  ApiError,
  api,
  type DeliveryAccess,
  type ReleaseAccess,
  type SettingsSource,
  type UpdateSettings as UpdateSettingsDto,
  type UpdateSettingsBlock,
  type UpdateSettingsBody,
} from "../api.js";
import { invalidate, useResource } from "../context.js";
import { docsUrl } from "../lib/docsLinks.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
  ConfirmDialog,
} from "../components/ui/index.js";

/**
 * Update settings — the answers to "which builds does this product offer, and to whom".
 *
 * Two of them (the compatibility window) used to live in product Settings, beside the display
 * name, which put a statement about SUPPORTED BUILDS in the form for "what is this product
 * called". They are here now because they are intersected with every grant the feed evaluates,
 * so they are read in the same breath as the access modes.
 *
 * The metadata mode and the compat window go to the same PATCH but land in different tables
 * (`release_config` vs the product row), which is why `configured: false` disables only half
 * the form: a product with no release configuration has nowhere to store an access mode and the
 * server answers 422 rather than accepting a value the next GET would not return.
 *
 * ARTIFACT access is Distribution's delivery access since P2b-04 (`…/distribution/access`): the
 * ONE answer the appcast, the downloads and the portal read, so the feed can no longer offer what
 * the download refuses. It is edited here because it is read in the same breath, but it saves to
 * its own endpoint and carries its own owner.
 *
 * Ownership (P0-01). The metadata mode, the delivery access and the compat window are ALSO
 * written by a manifest resync, so each carries a source badge: saving one here claims it
 * (`admin`), and resync skips a claimed block until "Revert to manifest" hands it back. The operator-only artifact policy
 * (minimum macOS version, the Sparkle signature requirement) has no manifest spelling at all, so
 * it has no badge — no push can write or erase it. Turning the signature requirement off weakens
 * a security control and asks for confirmation first.
 */
export function UpdateSettings({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(
    `update-settings:${slug}`,
    () => api.updateSettings(slug),
  );
  // Distribution's delivery access (P2b-04). Loaded beside the settings; while it is loading or
  // unreadable the Artifact access control is disabled rather than guessed at.
  const delivery = useResource(`delivery-access:${slug}`, () =>
    api.deliveryAccess(slug),
  );

  return (
    <section aria-labelledby="update-settings-title" className="space-y-6">
      <header className="space-y-1">
        <h2
          id="update-settings-title"
          className="text-xl font-semibold tracking-tight"
        >
          Update settings
        </h2>
        <p className="text-sm text-muted-foreground">
          Feed access and the compatibility window for{" "}
          <span className="font-medium text-foreground">{slug}</span>.
        </p>
      </header>

      {loading && !data ? (
        <SettingsSkeleton />
      ) : error && !data ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load update settings"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
          }
        />
      ) : data ? (
        <SettingsForm
          slug={slug}
          settings={data}
          delivery={delivery.data ?? null}
          deliveryError={delivery.error ?? null}
        />
      ) : null}
    </section>
  );
}

/**
 * The access ladder, loosest first. `entitled` (D-13) is the only mode that consults the
 * license's own grants rather than merely asking whether one exists, so it is the only mode
 * that can hold a device on an older channel or below a version ceiling.
 */
const ACCESS_MODES: { value: ReleaseAccess; label: string; help: string }[] = [
  {
    value: "public",
    label: "Public",
    help: "Anyone may read it — no device token, no license.",
  },
  {
    value: "authenticated",
    label: "Authenticated",
    help: "A registered device with a valid token, licensed or not.",
  },
  {
    value: "licensed",
    label: "Licensed",
    help: "A device whose license is usable. Any usable license passes.",
  },
  {
    value: "entitled",
    label: "Entitled",
    help: "Licensed, plus the license’s own tier channels and version window are enforced on the feed — the only mode where two licensed devices can be offered different builds.",
  },
];

type FormState = {
  metadataAccess: ReleaseAccess;
  /** Distribution's delivery access for the app; `null` until it has loaded. */
  artifactsAccess: ReleaseAccess | null;
  compatMin: string;
  compatMax: string;
  /** The input's raw text; empty means "no minimum" and is sent as `null`. */
  minimumSystemVersion: string;
  requireSparkleSignature: boolean;
};

function seed(
  settings: UpdateSettingsDto,
  delivery: DeliveryAccess | null,
): FormState {
  return {
    metadataAccess: settings.metadataAccess,
    artifactsAccess: delivery?.app.mode ?? null,
    compatMin: settings.compatMin,
    compatMax: settings.compatMax,
    minimumSystemVersion: settings.minimumSystemVersion ?? "",
    requireSparkleSignature: settings.requireSparkleSignature,
  };
}

/** The revertible blocks: Update's two, plus Distribution's delivery access (P2b-04). */
type Block = UpdateSettingsBlock | "delivery";

const BLOCK_COPY: Record<Block, { name: string; title: string }> = {
  access: {
    name: "metadata access mode",
    title: "Return the metadata access mode to the manifest?",
  },
  delivery: {
    name: "delivery access",
    title: "Return the delivery access to the manifest?",
  },
  compat: {
    name: "compatibility window",
    title: "Return the compatibility window to the manifest?",
  },
};

function SettingsForm({
  slug,
  settings,
  delivery,
  deliveryError,
}: {
  slug: string;
  settings: UpdateSettingsDto;
  delivery: DeliveryAccess | null;
  deliveryError: string | null;
}): React.ReactElement {
  const toast = useToast();
  const [form, setForm] = React.useState<FormState>(() =>
    seed(settings, delivery),
  );
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );
  // A save that turns the signature requirement OFF waits here for the operator to confirm.
  const [pendingUnsigned, setPendingUnsigned] = React.useState<{
    body: UpdateSettingsBody;
    artifacts: ReleaseAccess | null;
  } | null>(null);
  const [confirmRevert, setConfirmRevert] = React.useState<Block | null>(null);
  const [reverting, setReverting] = React.useState(false);

  // Re-seed after a save (or a resync) replaces the settings this form was built from.
  React.useEffect(() => {
    setForm(seed(settings, delivery));
    setFieldErrors({});
  }, [settings, delivery]);

  const initial = seed(settings, delivery);
  const dirty = (Object.keys(initial) as (keyof FormState)[]).some(
    (k) => form[k] !== initial[k],
  );

  const save = async (
    body: UpdateSettingsBody,
    artifacts: ReleaseAccess | null,
  ): Promise<void> => {
    setSaving(true);
    setFieldErrors({});
    try {
      // Two owners, two endpoints (P2b-04): the delivery access is Distribution's.
      if (artifacts !== null) {
        try {
          await api.saveDeliveryAccess(slug, { mode: artifacts });
        } catch (err) {
          // Attribute a refusal of the delivery-access save to its own control.
          if (err instanceof ApiError && err.fields?.length) {
            const attributed = new ApiError(
              err.status,
              ["artifactsAccess"],
              err.code,
            );
            attributed.message = err.message;
            throw attributed;
          }
          throw err;
        }
        invalidate(`delivery-access:${slug}`);
      }
      if (Object.keys(body).length > 0)
        await api.saveUpdateSettings(slug, body);
      invalidate(`update-settings:${slug}`);
      // The compat window lives on the product row, so anything showing the product (the
      // overview, the releases distribution card) is now stale.
      invalidate(`product:${slug}`);
      toast.success("Update settings saved");
    } catch (err) {
      // Same split as `ServicesCard`: a 422 that NAMES the offending keys is rendered beside
      // those inputs and nowhere else. Adding a toast on top would put the same rejection in
      // two places — one of which is in the corner of the screen, away from the field at
      // fault, and dismisses itself. The toast is the fallback for a failure the server did
      // not attribute to an input (a 500, a dropped connection), which has nowhere inline to go.
      if (err instanceof ApiError && err.fields?.length) {
        setFieldErrors(
          Object.fromEntries(
            err.fields.map((f) => [
              f,
              err.message && err.message !== `api ${err.status}`
                ? err.message
                : "The server rejected this value.",
            ]),
          ),
        );
      } else {
        toast.error(
          "Couldn’t save update settings",
          err instanceof Error ? err.message : undefined,
        );
      }
    } finally {
      setSaving(false);
      setPendingUnsigned(null);
    }
  };

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    // Send only what changed. The endpoint patches partially, and an unchanged access mode sent
    // at an unconfigured product would 422 the whole request — including the compat window,
    // which would otherwise have saved fine. Sending an unchanged block would also CLAIM it
    // for the operator, which the operator did not ask for.
    const body: UpdateSettingsBody = {};
    if (form.metadataAccess !== settings.metadataAccess)
      body.metadataAccess = form.metadataAccess;
    const artifacts =
      form.artifactsAccess !== null &&
      form.artifactsAccess !== initial.artifactsAccess
        ? form.artifactsAccess
        : null;
    if (form.compatMin !== settings.compatMin)
      body.compatMin = form.compatMin.trim();
    if (form.compatMax !== settings.compatMax)
      body.compatMax = form.compatMax.trim();
    const minSys = form.minimumSystemVersion.trim();
    if (minSys !== (settings.minimumSystemVersion ?? ""))
      body.minimumSystemVersion = minSys === "" ? null : minSys;
    if (form.requireSparkleSignature !== settings.requireSparkleSignature)
      body.requireSparkleSignature = form.requireSparkleSignature;

    if (body.requireSparkleSignature === false) {
      setPendingUnsigned({ body, artifacts });
      return;
    }
    await save(body, artifacts);
  };

  const onRevert = async (block: Block): Promise<void> => {
    setReverting(true);
    try {
      if (block === "delivery") {
        await api.revertDeliveryAccess(slug);
        invalidate(`delivery-access:${slug}`);
      } else {
        await api.revertUpdateSettings(slug, [block]);
        invalidate(`update-settings:${slug}`);
      }
      toast.success(
        "Returned to manifest control",
        `The manifest’s ${BLOCK_COPY[block].name} re-apply on the next resync.`,
      );
      setConfirmRevert(null);
    } catch (err) {
      toast.error(
        `Couldn’t revert the ${BLOCK_COPY[block].name}`,
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setReverting(false);
    }
  };

  const signatureId = `update-${slug}-signature`;

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <CardTitle>Feed access &amp; compatibility</CardTitle>
          <CardDescription>
            Who may read the changelog and version check, who may read the
            appcast and download what it points at, the version window every
            grant is intersected with, and the operator-only artifact policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!settings.configured ? (
            <div
              role="note"
              className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
            >
              <Info
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-warning"
              />
              <p className="text-muted-foreground">
                This product has no release configuration, so there is no row to
                store an access mode or artifact policy on and the server
                refuses to write one. The values below are the defaults the feed
                serves. Link a repo with a{" "}
                <code className="font-mono text-xs">.pkey/release</code> block
                (or resync one) and they become editable. The compatibility
                window lives on the product itself and can still be changed.{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href={docsUrl("updateAccessNote")}
                  target="_blank"
                  rel="noreferrer"
                >
                  Learn more
                </a>
              </p>
            </div>
          ) : null}

          <BlockHeading
            title="Feed access"
            block="access"
            source={settings.accessSource}
            canRevert={settings.configured}
            onRevert={() => setConfirmRevert("access")}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <AccessField
              id={`update-${slug}-metadata`}
              label="Metadata access"
              help="Who may read the changelog, the version-check endpoint and the installer (not the appcast — see Artifact access)."
              value={form.metadataAccess}
              disabled={!settings.configured}
              error={fieldErrors.metadataAccess}
              onChange={(metadataAccess) =>
                setForm((f) => ({ ...f, metadataAccess }))
              }
            />
          </div>

          <BlockHeading
            title="Delivery access"
            block="delivery"
            source={delivery?.app.source ?? "manifest"}
            canRevert={settings.configured && delivery !== null}
            onRevert={() => setConfirmRevert("delivery")}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <AccessField
              id={`update-${slug}-artifacts`}
              label="Artifact access"
              help={
                deliveryError
                  ? `Couldn’t load the delivery access: ${deliveryError}`
                  : "Distribution’s delivery access: who may read the appcast, download the binaries it points at, and mint a download in the customer portal — one answer for all three."
              }
              value={form.artifactsAccess ?? "public"}
              disabled={!settings.configured || delivery === null}
              error={fieldErrors.artifactsAccess}
              onChange={(artifactsAccess) =>
                setForm((f) => ({ ...f, artifactsAccess }))
              }
            />
          </div>

          <dl className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
            {ACCESS_MODES.map((mode) => (
              <div key={mode.value} className="flex flex-col gap-0.5">
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {mode.label}
                </dt>
                <dd className="text-sm text-muted-foreground">{mode.help}</dd>
              </div>
            ))}
          </dl>

          <BlockHeading
            title="Compatibility window"
            block="compat"
            source={settings.compatSource}
            canRevert
            onRevert={() => setConfirmRevert("compat")}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Compat min"
              help="Lowest client version this product supports (semver, e.g. 1.0.0)."
              error={fieldErrors.compatMin}
            >
              <Input
                value={form.compatMin}
                onChange={(e) =>
                  setForm((f) => ({ ...f, compatMin: e.target.value }))
                }
                placeholder="0.0.0"
                autoComplete="off"
              />
            </Field>
            <Field
              label="Compat max"
              help="Highest supported version (semver). Every license grant is intersected with this window."
              error={fieldErrors.compatMax}
            >
              <Input
                value={form.compatMax}
                onChange={(e) =>
                  setForm((f) => ({ ...f, compatMax: e.target.value }))
                }
                placeholder="99.0.0"
                autoComplete="off"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">Artifact policy</h3>
            <Badge
              variant="outline"
              title="No manifest can set these; a resync never writes them."
            >
              operator-only
            </Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Minimum macOS version"
              help="Rendered as sparkle:minimumSystemVersion (e.g. 13.0). Leave empty for no minimum."
              error={fieldErrors.minimumSystemVersion}
            >
              <Input
                value={form.minimumSystemVersion}
                disabled={!settings.configured}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    minimumSystemVersion: e.target.value,
                  }))
                }
                placeholder="none"
                autoComplete="off"
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={signatureId}>Require Sparkle signatures</Label>
                <Switch
                  id={signatureId}
                  checked={form.requireSparkleSignature}
                  disabled={!settings.configured}
                  aria-describedby={`${signatureId}-help`}
                  aria-invalid={
                    fieldErrors.requireSparkleSignature ? true : undefined
                  }
                  onCheckedChange={(requireSparkleSignature) =>
                    setForm((f) => ({ ...f, requireSparkleSignature }))
                  }
                />
              </div>
              <p
                id={`${signatureId}-help`}
                className="text-xs text-muted-foreground"
              >
                The appcast only lists a DMG with a verified EdDSA signature.
                Turning this off lets an unsigned build ship to every updater.
              </p>
              {fieldErrors.requireSparkleSignature ? (
                <p
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {fieldErrors.requireSparkleSignature}
                </p>
              ) : null}
            </div>
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save update settings
          </Button>
        </CardFooter>
      </form>

      <ConfirmDialog
        open={pendingUnsigned !== null}
        onOpenChange={(next) => !saving && !next && setPendingUnsigned(null)}
        title="Turn off the Sparkle signature requirement?"
        description={
          <>
            The feed will list builds with no verified EdDSA signature, so an
            unsigned — or tampered — DMG can reach every updater. The change is
            recorded in the audit log.
          </>
        }
        confirmLabel="Turn off signatures"
        confirmVariant="destructive"
        loading={saving}
        onConfirm={() =>
          pendingUnsigned
            ? save(pendingUnsigned.body, pendingUnsigned.artifacts)
            : undefined
        }
      />

      <ConfirmDialog
        open={confirmRevert !== null}
        onOpenChange={(next) => !reverting && !next && setConfirmRevert(null)}
        title={confirmRevert ? BLOCK_COPY[confirmRevert].title : ""}
        description={
          <>
            Ownership goes back to the repo manifest. The live values are
            unchanged until the next resync re-applies the manifest’s.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("updateSettingsRevert")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </>
        }
        confirmLabel="Return to manifest"
        confirmVariant="primary"
        loading={reverting}
        onConfirm={() => (confirmRevert ? onRevert(confirmRevert) : undefined)}
      />
    </Card>
  );
}

/** A block's heading, its ownership badge, and the button that hands it back to the manifest. */
function BlockHeading({
  title,
  block,
  source,
  canRevert,
  onRevert,
}: {
  title: string;
  block: Block;
  source: SettingsSource;
  canRevert: boolean;
  onRevert: () => void;
}): React.ReactElement {
  const admin = source === "admin";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge
          variant={admin ? "primary" : "outline"}
          data-testid={`${block}-source`}
          title={
            admin
              ? "An operator claimed this block; resyncs no longer write it."
              : "The repo manifest owns this block; a resync may rewrite it."
          }
        >
          {admin ? "admin-owned" : "manifest-owned"}
        </Badge>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!admin || !canRevert}
        aria-label={`Revert ${title.toLowerCase()} to manifest`}
        title={admin ? undefined : "This block is already manifest-owned."}
        onClick={onRevert}
      >
        <Undo2 aria-hidden />
        Revert to manifest
      </Button>
    </div>
  );
}

/**
 * Hand-wired rather than wrapped in `Field`: `Field` clones its single child to inject the
 * generated `id`/`aria-describedby`, and the child here is a Radix `Select.Root`, which renders
 * no DOM of its own and drops both — the label would point at nothing and the help text would
 * never be announced. The trigger is the focusable element, so it carries them directly.
 */
function AccessField({
  id,
  label,
  help,
  value,
  disabled,
  error,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: ReleaseAccess;
  disabled: boolean;
  error?: string;
  onChange: (next: ReleaseAccess) => void;
}): React.ReactElement {
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {disabled ? (
          <span className="text-xs text-muted-foreground">not configured</span>
        ) : null}
      </div>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as ReleaseAccess)}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          aria-describedby={error ? `${helpId} ${errorId}` : helpId}
          aria-invalid={error ? true : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ACCESS_MODES.map((mode) => (
            <SelectItem key={mode.value} value={mode.value}>
              {mode.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={helpId} className="text-xs text-muted-foreground">
        {help}
      </p>
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-xs font-medium text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SettingsSkeleton(): React.ReactElement {
  return (
    <Card aria-hidden>
      <CardHeader>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-72" />
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
