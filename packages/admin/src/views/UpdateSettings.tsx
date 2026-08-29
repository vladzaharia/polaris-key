import * as React from "react";
import { AlertTriangle, Info } from "lucide-react";
import {
  ApiError,
  api,
  type ReleaseAccess,
  type UpdateSettingsBody,
} from "../api.js";
import { invalidate, useResource } from "../context.js";
import { docsUrl } from "../lib/docsLinks.js";
import {
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
  useToast,
} from "../components/ui/index.js";

/**
 * Update settings — the four answers to "which builds does this product offer, and to whom".
 *
 * Two of them (the compatibility window) used to live in product Settings, beside the display
 * name, which put a statement about SUPPORTED BUILDS in the form for "what is this product
 * called". They are here now because they are intersected with every grant the feed evaluates,
 * so they are read in the same breath as the access modes.
 *
 * The access modes and the compat window go to the same PATCH but land in different tables
 * (`release_config` vs the product row), which is why `configured: false` disables only half
 * the form: a product with no release configuration has nowhere to store an access mode and the
 * server answers 422 rather than accepting a value the next GET would not return.
 */
export function UpdateSettings({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(
    `update-settings:${slug}`,
    () => api.updateSettings(slug),
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
        <SettingsForm slug={slug} settings={data} />
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

function SettingsForm({
  slug,
  settings,
}: {
  slug: string;
  settings: {
    metadataAccess: ReleaseAccess;
    artifactsAccess: ReleaseAccess;
    compatMin: string;
    compatMax: string;
    configured: boolean;
  };
}): React.ReactElement {
  const toast = useToast();
  const [form, setForm] = React.useState({
    metadataAccess: settings.metadataAccess,
    artifactsAccess: settings.artifactsAccess,
    compatMin: settings.compatMin,
    compatMax: settings.compatMax,
  });
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );

  // Re-seed after a save (or a resync) replaces the settings this form was built from.
  React.useEffect(() => {
    setForm({
      metadataAccess: settings.metadataAccess,
      artifactsAccess: settings.artifactsAccess,
      compatMin: settings.compatMin,
      compatMax: settings.compatMax,
    });
    setFieldErrors({});
  }, [settings]);

  const dirty =
    form.metadataAccess !== settings.metadataAccess ||
    form.artifactsAccess !== settings.artifactsAccess ||
    form.compatMin !== settings.compatMin ||
    form.compatMax !== settings.compatMax;

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    // Send only what changed. The endpoint patches partially, and an unchanged access mode sent
    // at an unconfigured product would 422 the whole request — including the compat window,
    // which would otherwise have saved fine.
    const body: UpdateSettingsBody = {};
    if (form.metadataAccess !== settings.metadataAccess)
      body.metadataAccess = form.metadataAccess;
    if (form.artifactsAccess !== settings.artifactsAccess)
      body.artifactsAccess = form.artifactsAccess;
    if (form.compatMin !== settings.compatMin)
      body.compatMin = form.compatMin.trim();
    if (form.compatMax !== settings.compatMax)
      body.compatMax = form.compatMax.trim();

    setSaving(true);
    setFieldErrors({});
    try {
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
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <CardTitle>Feed access &amp; compatibility</CardTitle>
          <CardDescription>
            Who may read the appcast, who may download what it points at, and
            the version window every grant is intersected with.
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
                store an access mode on and the server refuses to write one. The
                modes below are the defaults the feed serves. Link a repo with a{" "}
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

          <div className="grid gap-4 sm:grid-cols-2">
            <AccessField
              id={`update-${slug}-metadata`}
              label="Metadata access"
              help="Who may read the changelog and the version-check endpoint (not the appcast — see Artifact access)."
              value={form.metadataAccess}
              disabled={!settings.configured}
              error={fieldErrors.metadataAccess}
              onChange={(metadataAccess) =>
                setForm((f) => ({ ...f, metadataAccess }))
              }
            />
            <AccessField
              id={`update-${slug}-artifacts`}
              label="Artifact access"
              help="Who may read the appcast feed and download the binaries it points at."
              value={form.artifactsAccess}
              disabled={!settings.configured}
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
        </CardContent>
        <CardFooter>
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save update settings
          </Button>
        </CardFooter>
      </form>
    </Card>
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
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
