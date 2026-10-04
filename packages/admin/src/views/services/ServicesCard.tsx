import * as React from "react";
import {
  AlertTriangle,
  Boxes,
  KeyRound,
  Package,
  RefreshCw,
  Settings2,
  Truck,
  Undo2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import {
  ApiError,
  SERVICE_ERROR_MESSAGES,
  api,
  type RegistrationPolicy,
  type ServiceSlug,
  type ServicesResponse,
} from "../../api.js";
import { useResource } from "../../context.js";
import {
  SERVICE_SLUGS,
  SERVICE_TABLE,
  type ServiceIconName,
  type ServiceTableRow,
} from "../../services.generated.js";
import { docsUrl } from "../../lib/docsLinks.js";
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
} from "../../components/ui/index.js";
import { qk } from "../../console/data/queries.js";
import { mutate } from "../../console/data/mutations.js";

/**
 * Which services this product runs (D-15) — the single authority every other console affordance
 * is a projection of, including the sidebar that frames this card.
 *
 * ── WHY THE TOGGLES BATCH BEHIND A SAVE BUTTON ──────────────────────────────────────────────
 *
 * The server validates the SET, not each flag (`core/services.ts` `validateServices`): Update
 * requires Distribution, Distribution requires Release, `requires-identity` requires Identity,
 * and Config-without-License forbids `requires-license`. An operator turning Release off while
 * Distribution is on is making a coherent two-step change, and a card that PATCHed on every flip would reject the first step and never
 * let them reach the second. So the form accumulates a whole proposed set and submits it once.
 *
 * ── WHY A REJECTION IS INLINE AND NOT A TOAST ───────────────────────────────────────────────
 *
 * The coherence codes name the exact toggle at fault. A toast puts that sentence in the corner
 * of the screen, away from the switch the operator just moved, and then dismisses itself; the
 * message is rendered beside the control instead, and stays until the set changes.
 */

/**
 * Each service's lucide icon, keyed by the name the service table gives it. Typed on
 * `ServiceIconName`, so a table row naming an icon not imported here is a type error.
 */
const SERVICE_ICONS: Record<ServiceIconName, LucideIcon> = {
  KeyRound,
  Settings2,
  Package,
  RefreshCw,
  UserRound,
  Truck,
};

interface ServiceRow {
  slug: ServiceSlug;
  /** The row's `data-service` scope, so its icon tile, icon and switch take the service's accent. */
  accent: ServiceTableRow["accent"];
  label: string;
  description: string;
  icon: React.ReactNode;
}

/** One row per service, in canonical order — label, text and icon from the generated table. */
const SERVICE_ROWS: ServiceRow[] = SERVICE_TABLE.map((row) => {
  const Icon = SERVICE_ICONS[row.icon];
  return {
    slug: row.slug,
    accent: row.accent,
    label: row.label,
    description: row.summary,
    icon: <Icon aria-hidden className="size-4 text-accent-fg" />,
  };
});

/** The sentinel for "no declared policy" — Radix Select has no concept of an empty value. */
const DERIVED = "__derived__";

const REGISTRATION_OPTIONS: { value: RegistrationPolicy; label: string }[] = [
  { value: "open", label: "Open — anyone may register a device" },
  {
    value: "requires-identity",
    label: "Requires identity — register behind a product sign-in",
  },
  {
    value: "requires-license",
    label: "Requires license — only activation mints device tokens",
  },
];

/**
 * Which control each coherence code indicts. The server returns the code; the card decides
 * where the sentence goes, because only the card knows what it drew.
 */
const ERROR_TARGETS: Record<string, (ServiceSlug | "registration")[]> = {
  distribution_requires_release: ["distribution"],
  update_requires_distribution: ["update"],
  registration_requires_identity: ["identity", "registration"],
  config_without_activation: ["config", "registration"],
};

export function ServicesCard({ slug }: { slug: string }): React.ReactElement {
  const toast = useToast();
  const { data, loading, error, reload } = useResource(qk.services(slug), () =>
    api.services(slug),
  );

  const [enabled, setEnabled] = React.useState<Record<ServiceSlug, boolean>>(
    () => emptyEnablement(),
  );
  const [registration, setRegistration] = React.useState<string>(DERIVED);
  const [saving, setSaving] = React.useState(false);
  const [codes, setCodes] = React.useState<string[]>([]);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = React.useState(false);
  const [reverting, setReverting] = React.useState(false);

  // Re-seed from the server's echo — the PATCH response IS the new truth, so a save that the
  // server adjusted (a cleared declaration, a re-derived effective policy) shows what landed.
  React.useEffect(() => {
    if (!data) return;
    setEnabled(readEnablement(data));
    setRegistration(data.registration ?? DERIVED);
    setCodes([]);
    setFailure(null);
  }, [data]);

  if (loading && !data) return <ServicesSkeleton />;
  if (error && !data) {
    return (
      <EmptyState
        icon={<AlertTriangle aria-hidden />}
        title="Couldn’t load services"
        description={error}
        action={
          <Button variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!data) {
    return <EmptyState icon={<Boxes aria-hidden />} title="No service state" />;
  }

  const current = readEnablement(data);
  const dirty =
    SERVICE_ROWS.some((row) => enabled[row.slug] !== current[row.slug]) ||
    registration !== (data.registration ?? DERIVED);

  const messagesFor = (target: ServiceSlug | "registration"): string[] =>
    codes
      .filter((code) => (ERROR_TARGETS[code] ?? []).includes(target))
      .map((code) => SERVICE_ERROR_MESSAGES[code] ?? code);

  // The rejection described one specific SET. The moment the operator changes the set they are
  // answering it, and leaving the message up would have them reading a verdict on a proposal
  // they have already withdrawn.
  const clearRejection = (): void => {
    setCodes([]);
    setFailure(null);
  };

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    clearRejection();
    try {
      await mutate("updateServices", slug, {
        services: Object.fromEntries(
          SERVICE_ROWS.map((row) => [row.slug, { enabled: enabled[row.slug] }]),
        ) as Record<ServiceSlug, { enabled: boolean }>,
        registration:
          registration === DERIVED
            ? null
            : (registration as RegistrationPolicy),
      });
      // The sidebar filters its sections on the product row's copy of this set, so the nav is
      // stale the moment this lands.
      toast.success("Services updated");
    } catch (err) {
      // Two distinct classes of 422, and conflating them would misplace the message.
      // `errors` are COHERENCE codes: each names a relationship between toggles that are
      // individually valid, so it is rendered beside the controls that form the relationship.
      // `fields` are malformed inputs (`services.license.enabled`) — a bug in this card rather
      // than a decision the operator made, so it is stated plainly instead of being dressed up
      // as validation next to a switch the operator set correctly.
      if (err instanceof ApiError && err.errors?.length) {
        setCodes(err.errors);
      } else if (err instanceof ApiError && err.fields?.length) {
        setFailure(
          `The server rejected this request as malformed: ${err.fields.join(", ")}.`,
        );
      } else {
        toast.error(
          "Couldn’t update services",
          err instanceof Error ? err.message : undefined,
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const onRevert = async (): Promise<void> => {
    setReverting(true);
    try {
      await mutate("revertServices", slug);
      toast.success(
        "Returned to manifest control",
        "Nothing changed live — the manifest re-applies on the next resync.",
      );
      setConfirmRevert(false);
    } catch (err) {
      toast.error(
        "Couldn’t revert to the manifest",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setReverting(false);
    }
  };

  const registrationErrors = messagesFor("registration");

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle>Services</CardTitle>
              <CardDescription>
                Which Polaris Key services this product runs. Disabled services
                answer as not-configured on the wire and disappear from the
                navigation.
              </CardDescription>
            </div>
            <SourceBadge source={data.source} />
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="divide-y divide-border">
            {SERVICE_ROWS.map((row) => {
              const id = `service-${slug}-${row.slug}`;
              const problems = messagesFor(row.slug);
              return (
                <div
                  key={row.slug}
                  data-service={row.accent}
                  className="flex flex-wrap items-start justify-between gap-4 py-4 first:pt-0"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-subtle ring-1 ring-inset ring-accent/30">
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
                      {problems.map((message) => (
                        <p
                          key={message}
                          role="alert"
                          className="mt-2 text-xs font-medium text-destructive"
                        >
                          {message}
                        </p>
                      ))}
                    </div>
                  </div>
                  <Switch
                    id={id}
                    checked={enabled[row.slug]}
                    aria-invalid={problems.length > 0 ? true : undefined}
                    onCheckedChange={(checked) => {
                      clearRejection();
                      setEnabled((prev) => ({ ...prev, [row.slug]: checked }));
                    }}
                  />
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`registration-${slug}`}>
              Device registration policy
            </Label>
            <Select
              value={registration}
              onValueChange={(next) => {
                clearRejection();
                setRegistration(next);
              }}
            >
              <SelectTrigger
                id={`registration-${slug}`}
                aria-describedby={`registration-${slug}-help`}
                aria-invalid={registrationErrors.length > 0 ? true : undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DERIVED}>
                  Derived from services (recommended)
                </SelectItem>
                {REGISTRATION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p
              id={`registration-${slug}-help`}
              className="text-xs text-muted-foreground"
            >
              How a device may obtain a token. Left derived, it follows the
              enabled set: <span className="font-medium">requires-license</span>{" "}
              with License on, else{" "}
              <span className="font-medium">requires-identity</span> with
              Identity on, else <span className="font-medium">open</span>.{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={docsUrl("registrationPolicy")}
                target="_blank"
                rel="noreferrer"
              >
                Learn more
              </a>
            </p>
            {registrationErrors.map((message) => (
              <p
                key={message}
                role="alert"
                className="text-xs font-medium text-destructive"
              >
                {message}
              </p>
            ))}
            <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <dt>Declared:</dt>
                <dd>
                  {data.registration ? (
                    <Badge variant="outline">{data.registration}</Badge>
                  ) : (
                    <span className="italic">derived</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt>Enforced now:</dt>
                <dd>
                  <Badge variant="primary">{data.effectiveRegistration}</Badge>
                </dd>
              </div>
            </dl>
          </div>

          {/* A code this build has no home for — a newer worker rule — is stated here rather
              than dropped, so the operator learns why the save failed even when the console
              cannot point at the switch. */}
          {codes
            .filter((code) => ERROR_TARGETS[code] === undefined)
            .map((code) => (
              <p
                key={code}
                role="alert"
                className="text-sm font-medium text-destructive"
              >
                {SERVICE_ERROR_MESSAGES[code] ?? code}
              </p>
            ))}

          {failure ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {failure}
            </p>
          ) : null}
        </CardContent>

        <CardFooter className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save services
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={data.source !== "admin"}
            title={
              data.source === "admin"
                ? undefined
                : "This product's services are already manifest-owned."
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
        title="Return service enablement to the manifest?"
        description={
          <>
            This changes NOTHING live. It hands ownership of this product's
            service set back to its repo manifest: the services stay exactly as
            they are now, and the manifest's values re-apply on the next resync
            (a push, or Resync from repo). Nothing is re-fetched from GitHub
            right now.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("servicesRevert")}
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

function SourceBadge({ source }: { source: string }): React.ReactElement {
  const admin = source === "admin";
  return (
    <Badge
      variant={admin ? "primary" : "outline"}
      title={
        admin
          ? "An operator claimed this row; resyncs no longer write it."
          : "The repo manifest owns this row; a resync may rewrite it."
      }
    >
      {admin ? "admin-owned" : "manifest-owned"}
    </Badge>
  );
}

function emptyEnablement(): Record<ServiceSlug, boolean> {
  return Object.fromEntries(
    SERVICE_SLUGS.map((slug) => [slug, false]),
  ) as Record<ServiceSlug, boolean>;
}

function readEnablement(data: ServicesResponse): Record<ServiceSlug, boolean> {
  const out = emptyEnablement();
  for (const row of SERVICE_ROWS) {
    out[row.slug] = data.services?.[row.slug]?.enabled === true;
  }
  return out;
}

function ServicesSkeleton(): React.ReactElement {
  return (
    <Card aria-hidden>
      <CardHeader>
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-80" />
      </CardHeader>
      <CardContent className="space-y-4">
        {SERVICE_SLUGS.map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
