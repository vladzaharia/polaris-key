import * as React from "react";
import { AlertTriangle, Fingerprint, Undo2 } from "lucide-react";
import { api, type FingerprintMode, type FingerprintProbeDto } from "../api.js";
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
  ConfirmDialog,
  DataTable,
  EmptyState,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
  type ColumnDef,
} from "../components/ui/index.js";

/**
 * Enrollment & fingerprints — the License section's answer to "which machine is this, and how
 * hard do we insist".
 *
 * The fingerprint policy API (`…/license/policy`) has existed with no console surface at all;
 * this view is the surface. Two halves, deliberately of different kinds:
 *
 *   • ENROLLMENT is shown read-only. Device registration is a CORE policy derived from the
 *     enabled service set, so editing it here would be a second control over one value — the
 *     kind of split that ends with two screens disagreeing. It is displayed because the section
 *     is called "Enrollment & fingerprints" and an operator reading it needs to know whether a
 *     device can even reach the point where a fingerprint matters.
 *   • The FINGERPRINT POLICY is editable, minus the probe list: `PATCH` replaces `probes`
 *     wholesale, and a half-built array editor that silently drops the platform hints it does
 *     not render is worse than a table that admits the list is authored in the manifest.
 */
export function FingerprintPolicy({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const policy = useResource(`fingerprint-policy:${slug}`, () =>
    api.fingerprintPolicy(slug),
  );

  return (
    <section aria-labelledby="fingerprints-title" className="space-y-6">
      <header className="space-y-1">
        <h2
          id="fingerprints-title"
          className="text-xl font-semibold tracking-tight"
        >
          Enrollment &amp; fingerprints
        </h2>
        <p className="text-sm text-muted-foreground">
          How devices on{" "}
          <span className="font-medium text-foreground">{slug}</span> register,
          and how tightly a seat is bound to the machine that took it.
        </p>
      </header>

      <EnrollmentCard slug={slug} />

      {policy.loading && !policy.data ? (
        <PolicySkeleton />
      ) : policy.error && !policy.data ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load the fingerprint policy"
          description={policy.error}
          action={
            <Button variant="outline" size="sm" onClick={policy.reload}>
              Retry
            </Button>
          }
        />
      ) : policy.data ? (
        <>
          <PolicyCard
            slug={slug}
            policy={policy.data.policy}
            source={policy.data.source}
          />
          <ProbesCard probes={policy.data.policy.probes} />
        </>
      ) : null}
    </section>
  );
}

// ── enrollment (read-only projection of the service set) ──────────────────────

function EnrollmentCard({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error } = useResource(`services:${slug}`, () =>
    api.services(slug),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Device registration</CardTitle>
        <CardDescription>
          Whether a device can obtain a token at all, and on what terms. Edited
          under <span className="font-medium">Platform → Services</span>, where
          it is validated against the enabled service set.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <Skeleton className="h-6 w-48" />
        ) : error && !data ? (
          <p className="text-sm text-muted-foreground">
            Couldn’t load the registration policy: {error}
          </p>
        ) : data ? (
          <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                Enforced now
              </dt>
              <dd>
                <Badge variant="primary">{data.effectiveRegistration}</Badge>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                Declared
              </dt>
              <dd>
                {data.registration ? (
                  <Badge variant="outline">{data.registration}</Badge>
                ) : (
                  <span className="text-muted-foreground">
                    derived from services
                  </span>
                )}
              </dd>
            </div>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── fingerprint policy ────────────────────────────────────────────────────────

/**
 * Drift tolerance per mode, from `FINGERPRINT_TOLERANCE` in the shared protocol. Stated as
 * component counts rather than adjectives because that is the difference an operator is
 * actually choosing between, and because "normal" tells them nothing on its own.
 */
const MODES: { value: FingerprintMode; label: string; help: string }[] = [
  {
    value: "off",
    label: "Off",
    help: "Fingerprints are recorded but never enforced — no device is ever refused for drift.",
  },
  {
    value: "lenient",
    label: "Lenient",
    help: "Up to 4 changed components still count as the same machine.",
  },
  {
    value: "normal",
    label: "Normal",
    help: "Up to 2 changed components still count as the same machine.",
  },
  {
    value: "strict",
    label: "Strict",
    help: "Every component must match, and a device with no fingerprint at all is refused.",
  },
];

function PolicyCard({
  slug,
  policy,
  source,
}: {
  slug: string;
  policy: { enabled: boolean; defaultMode: FingerprintMode };
  source: "manifest" | "admin";
}): React.ReactElement {
  const toast = useToast();
  const [enabled, setEnabled] = React.useState(policy.enabled);
  const [mode, setMode] = React.useState<FingerprintMode>(policy.defaultMode);
  const [saving, setSaving] = React.useState(false);
  const [confirmRevert, setConfirmRevert] = React.useState(false);
  const [reverting, setReverting] = React.useState(false);

  // Re-seed from the PATCH echo / a resync invalidate rather than trusting local state to have
  // stayed in step with the row.
  React.useEffect(() => {
    setEnabled(policy.enabled);
    setMode(policy.defaultMode);
  }, [policy]);

  const dirty = enabled !== policy.enabled || mode !== policy.defaultMode;
  const modeHelp = MODES.find((m) => m.value === mode)?.help ?? "";

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      // `probes` is omitted deliberately: the PATCH replaces the whole array, so sending the
      // list back unchanged would claim admin ownership of a list this view cannot edit.
      await api.updateFingerprintPolicy(slug, { enabled, defaultMode: mode });
      invalidate(`fingerprint-policy:${slug}`);
      toast.success("Fingerprint policy saved");
    } catch (err) {
      toast.error(
        "Couldn’t save the fingerprint policy",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  const onRevert = async (): Promise<void> => {
    setReverting(true);
    try {
      await api.revertFingerprintPolicy(slug);
      invalidate(`fingerprint-policy:${slug}`);
      toast.success(
        "Returned to manifest control",
        "The manifest’s policy re-applies on the next resync.",
      );
      setConfirmRevert(false);
    } catch (err) {
      toast.error(
        "Couldn’t revert the policy",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setReverting(false);
    }
  };

  const enabledId = `fingerprint-${slug}-enabled`;
  const modeId = `fingerprint-${slug}-mode`;

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <Fingerprint aria-hidden className="size-4 text-accent-fg" />
                Fingerprint policy
              </CardTitle>
              <CardDescription>
                Hardware components arrive already hashed on the device; the
                server re-derives the identifier and decides how much drift a
                seat survives.
              </CardDescription>
            </div>
            <Badge
              variant={source === "admin" ? "primary" : "outline"}
              title={
                source === "admin"
                  ? "An operator claimed this policy; resyncs no longer write it."
                  : "The repo manifest owns this policy; a resync may rewrite it."
              }
            >
              {source === "admin" ? "admin-owned" : "manifest-owned"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <label
                htmlFor={enabledId}
                className="text-sm font-medium text-foreground"
              >
                Enforce fingerprints
              </label>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                With this off, fingerprints are still collected and shown on
                each device, but a mismatch never blocks an activation.
              </p>
            </div>
            <Switch
              id={enabledId}
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={modeId}>Default mode</Label>
            <Select
              value={mode}
              onValueChange={(next) => setMode(next as FingerprintMode)}
            >
              <SelectTrigger
                id={modeId}
                aria-describedby={`${modeId}-help`}
                className="sm:max-w-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id={`${modeId}-help`} className="text-xs text-muted-foreground">
              {modeHelp} A tier may override this; a device that still presents
              the machine anchor is allowed one extra changed component.
            </p>
          </div>
        </CardContent>

        <CardFooter className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save policy
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={source !== "admin"}
            title={
              source === "admin"
                ? undefined
                : "This policy is already manifest-owned."
            }
            onClick={() => setConfirmRevert(true)}
          >
            <Undo2 aria-hidden />
            Revert to manifest
          </Button>
        </CardFooter>
      </form>

      <ConfirmDialog
        open={confirmRevert}
        onOpenChange={(next) => !reverting && setConfirmRevert(next)}
        title="Return the fingerprint policy to the manifest?"
        description={
          <>
            Ownership goes back to the repo manifest. The live policy is
            unchanged until the next resync re-applies the manifest's values —
            which also returns the auto-issue policy to manifest control.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("fingerprintRevert")}
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
        onConfirm={onRevert}
      />
    </Card>
  );
}

// ── probes ────────────────────────────────────────────────────────────────────

/**
 * Probes are product-declared presence checks a device answers yes/no (plus an optional
 * version) — a companion app, a driver, a plugin host. Read-only here: they are authored in
 * `.pkey/product` and the PATCH shape replaces the entire array, so an editor that rendered
 * only the fields it knows about would quietly delete the per-platform hints it did not.
 */
function ProbesCard({
  probes,
}: {
  probes: FingerprintProbeDto[];
}): React.ReactElement {
  const columns: ColumnDef<FingerprintProbeDto>[] = [
    {
      id: "id",
      header: "Id",
      accessor: (p) => p.id,
      sortable: true,
      cell: (p) => <span className="font-mono text-xs">{p.id}</span>,
    },
    {
      id: "label",
      header: "Label",
      accessor: (p) => p.label,
      sortable: true,
      cell: (p) => <span className="font-medium">{p.label || p.id}</span>,
    },
    {
      id: "macos",
      header: "macOS",
      cell: (p) => <Hint value={p.macos} />,
    },
    {
      id: "windows",
      header: "Windows",
      cell: (p) => <Hint value={p.windows} />,
    },
    {
      id: "linux",
      header: "Linux",
      cell: (p) => <Hint value={p.linux} />,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Probes</CardTitle>
        <CardDescription>
          Declared in the product’s{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">
            .pkey/product
          </code>{" "}
          manifest and applied by a resync. Each device reports presence and an
          optional version for every probe; the results show on the device.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={probes}
          rowKey={(p) => p.id}
          empty={
            <EmptyState
              icon={<Fingerprint aria-hidden />}
              title="No probes declared"
              description="Add a probes list to the product manifest and resync to collect companion-app facts."
              action={
                <a
                  className="text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground"
                  href={docsUrl("deviceFingerprints")}
                  target="_blank"
                  rel="noreferrer"
                >
                  Learn more
                </a>
              }
              className="rounded-none border-0"
            />
          }
        />
      </CardContent>
    </Card>
  );
}

function Hint({ value }: { value?: string }): React.ReactElement {
  return value ? (
    <span className="break-all font-mono text-xs">{value}</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

function PolicySkeleton(): React.ReactElement {
  return (
    <Card aria-hidden>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-9 w-64" />
      </CardContent>
    </Card>
  );
}
