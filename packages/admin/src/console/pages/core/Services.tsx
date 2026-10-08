/**
 * Core → Services (T4; docs/design/ADMIN.md §2.3; docs/design/EXPERIENCE.md §0.4 S2, UX-22).
 * Which services the product runs and how a device may register: the one authority every other
 * console affordance projects (the sidebar's sections included).
 *
 * - **The service chain has one rule: turning on X turns on what X needs, and nothing more.**
 *   Turning X off takes its dependents with it, and the L1 confirm lists them first. The edges
 *   come from `SERVICE_REQUIRES` (generated), never from a list kept here.
 * - **Each switch saves on its own** (S-18 §4.9): on is L0, an undo toast naming what came on with
 *   it; off is L1. There is no services save bar. A switch sends only the flags it flips (the
 *   PATCH merges), so a stale page never rewrites a flag it did not touch, nor the policy.
 * - The registration policy is a choice of four, not a switch: it keeps its own section save.
 * - The server still validates the SET (`core/services.ts`). A flip the policy would make
 *   incoherent is refused before it is sent, and every coherence code (the client's or the
 *   server's) lands beside the controls it indicts.
 * - Each row is its service's `data-service` scope, so its glyph and switch take the accent
 *   (SVC-4). Raw slugs never show: policies read through `REGISTRATION_LABELS` (SVC-5).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import {
  ApiError,
  SERVICE_ERROR_MESSAGES,
  api,
  type RegistrationPolicy,
  type ServiceSlug,
  type ServicesResponse,
} from "../../../api.js";
import {
  SERVICE_REQUIRES,
  SERVICE_SLUGS,
  SERVICE_TABLE,
} from "../../../services.generated.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { REGISTRATION_LABELS } from "../../../lib/labels.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Form, useAdminForm } from "../../../ui/form.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { ServiceGlyph, serviceLabel } from "../../../ui/ServiceBadge.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { Switch } from "../../../ui/Switch.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { queryClient } from "../../data/queryClient.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../templates/Settings.js";
import { intentOf, useConfirmGate } from "./confirmGate.js";

/** "Derived from services": no declared policy. RadioCards needs a string value. */
const DERIVED = "derived";

type Enabled = Record<ServiceSlug, boolean>;
type Draft = Enabled & { registration: string };

const REGISTRATION_OPTIONS = [
  {
    value: DERIVED,
    label: "Derived from services",
    description:
      "License required with License on, else identity required with Identity on, else open.",
  },
  {
    value: "open",
    label: REGISTRATION_LABELS.open!,
    description: "Any device may register and receive a token.",
  },
  {
    value: "requires-identity",
    label: REGISTRATION_LABELS["requires-identity"]!,
    description: "A device registers behind a product sign-in.",
  },
  {
    value: "requires-license",
    label: REGISTRATION_LABELS["requires-license"]!,
    description: "Only license activation issues device tokens.",
  },
] as const;

/** Which controls each coherence code indicts. */
const ERROR_TARGETS: Record<string, (ServiceSlug | "registration")[]> = {
  distribution_requires_release: ["distribution", "release"],
  update_requires_distribution: ["update", "distribution"],
  registration_requires_identity: ["identity", "registration"],
  config_without_activation: ["config", "license", "registration"],
  sync_requires_config: ["sync", "config"],
  sync_requires_identity: ["sync", "identity"],
};

/** What turning a service off does, in the docs' words (services-enablement). */
const DISABLE_CONSEQUENCES: Record<ServiceSlug, string> = {
  license:
    "License's endpoints answer not-configured: no activation, no license documents.",
  config:
    "Config's endpoints answer not-configured: no config documents and no edge-mint tokens.",
  release:
    "Release's endpoints answer not-configured: the truth store stops answering clients.",
  distribution:
    "Distribution stops serving downloads and store rollouts are no longer managed here.",
  update: "The update feed answers not-configured: clients see no updates.",
  identity:
    "Sign-in through this product stops. Licences stay attached to their owners' accounts.",
  sync: "Cloud Sync's endpoints answer not-found: settings stay on each device and nothing syncs.",
};

/** What the turn-off confirmation shows: the services, and (Identity only) the signed-in count. */
interface TurnOff {
  slugs: ServiceSlug[];
  /** Devices signed in through the product that turning Identity off signs out; `null` when
   *  Identity is not among `slugs` or the count could not be read. */
  signedIn: number | null;
}

/** PX-W17: the consequence line for the devices turning Identity off signs out. */
export function signedInConsequence(signedIn: number | null): string[] {
  if (!signedIn) return [];
  return [
    `${signedIn} signed-in device${signedIn === 1 ? "" : "s"} will be signed out; installs and licences keep working.`,
  ];
}

function readEnabled(data: ServicesResponse): Enabled {
  return Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, data.services?.[s]?.enabled === true]),
  ) as Enabled;
}

/** The coherence codes a set would earn, computed as the server does, before any save. */
export function draftCoherence(draft: Draft): string[] {
  const codes: string[] = [];
  for (const slug of SERVICE_SLUGS) {
    if (!draft[slug]) continue;
    for (const req of SERVICE_REQUIRES[slug]) {
      if (!draft[req]) codes.push(`${slug}_requires_${req}`);
    }
  }
  if (draft.registration === "requires-identity" && !draft.identity)
    codes.push("registration_requires_identity");
  if (
    draft.registration === "requires-license" &&
    draft.config &&
    !draft.license
  )
    codes.push("config_without_activation");
  return codes;
}

/** What the wire would enforce for a draft (the derivation, when nothing is declared). */
function effectiveOf(draft: Draft): RegistrationPolicy {
  if (draft.registration !== DERIVED)
    return draft.registration as RegistrationPolicy;
  if (draft.license) return "requires-license";
  if (draft.identity) return "requires-identity";
  return "open";
}

/** Walks `edges` from `slug`, nearest first, without `slug` itself. */
function closure(
  slug: ServiceSlug,
  edges: (s: ServiceSlug) => readonly ServiceSlug[],
): ServiceSlug[] {
  const out: ServiceSlug[] = [];
  const queue = [...edges(slug)];
  while (queue.length) {
    const next = queue.shift()!;
    if (next === slug || out.includes(next)) continue;
    out.push(next);
    queue.push(...edges(next));
  }
  return out;
}

/** Everything `slug` needs, directly or through what it needs (Update: Distribution, Release). */
export function needsOf(slug: ServiceSlug): ServiceSlug[] {
  return closure(slug, (s) => SERVICE_REQUIRES[s]);
}

/** Everything that needs `slug`, directly or not (Release: Distribution, Update). */
export function dependentsOf(slug: ServiceSlug): ServiceSlug[] {
  return closure(slug, (s) =>
    SERVICE_SLUGS.filter((o) => SERVICE_REQUIRES[o].includes(s)),
  );
}

/**
 * The chain rule: the flags one switch flips. On: `slug` and whatever it needs that is off, and
 * nothing more. Off: `slug` and whatever needs it that is on. `slug` is always first.
 */
export function chainFlip(
  slug: ServiceSlug,
  on: boolean,
  enabled: Enabled,
): ServiceSlug[] {
  const pulled = on
    ? needsOf(slug).filter((s) => !enabled[s])
    : dependentsOf(slug).filter((s) => enabled[s]);
  return [slug, ...pulled];
}

/** "Distribution and Release", "A, B and C". */
function listOf(slugs: readonly ServiceSlug[]): string {
  const names = slugs.map(serviceLabel);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function ServicesPage({ slug }: { slug: string }): React.ReactElement {
  const query = useQuery(
    { queryKey: qk.services(slug), queryFn: () => api.services(slug) },
    queryClient,
  );
  useLoadingAnnouncement("services", query.isPending);

  const header = (
    <PageHeader
      title="Services"
      refetching={query.isFetching && !query.isPending}
    />
  );

  if (query.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="services" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  return <ServicesForm slug={slug} data={query.data} header={header} />;
}

function ServicesForm({
  slug,
  data,
  header,
}: {
  slug: string;
  data: ServicesResponse;
  header: React.ReactNode;
}): React.ReactElement {
  const [codes, setCodes] = React.useState<string[]>([]);
  const [switchError, setSwitchError] = React.useState<unknown>(null);
  const [pending, setPending] = React.useState<{
    flip: ServiceSlug[];
    on: boolean;
  } | null>(null);
  const [confirmRevert, setConfirmRevert] = React.useState(false);
  const gate = useConfirmGate<TurnOff>();

  const saved = React.useMemo(() => readEnabled(data), [data]);
  // A switch shows where it is going while its save is in flight.
  const enabled: Enabled = pending
    ? {
        ...saved,
        ...Object.fromEntries(pending.flip.map((s) => [s, pending.on])),
      }
    : saved;
  const savedRegistration = data.registration ?? DERIVED;

  /** One switch's write: only the flags it flips. `true` when it landed. */
  const write = async (flip: ServiceSlug[], on: boolean): Promise<boolean> => {
    setCodes([]);
    setSwitchError(null);
    setPending({ flip, on });
    try {
      const next = await mutate("updateServices", slug, {
        services: Object.fromEntries(
          flip.map((s) => [s, { enabled: on }]),
        ) as UpdateServices,
      });
      // The response is the new set: show it now, before the invalidation's refetch lands.
      queryClient.setQueryData(qk.services(slug), next);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.errors?.length) setCodes(err.errors);
      else setSwitchError(err);
      return false;
    } finally {
      setPending(null);
    }
  };

  const flipService = async (s: ServiceSlug, on: boolean): Promise<void> => {
    const flip = chainFlip(s, on, enabled);
    const after = {
      ...enabled,
      ...Object.fromEntries(flip.map((f) => [f, on])),
      registration: savedRegistration,
    } as Draft;
    // The chain keeps the service edges whole; only the policy can still refuse the set.
    const refused = draftCoherence(after);
    if (refused.length) {
      setSwitchError(null);
      setCodes(refused);
      return;
    }
    if (!on) {
      // PX-W17: turning Identity off signs every signed-in device out; the dry run (the same body
      // the switch writes) counts them so the confirmation can say how many. A failed count
      // leaves the generic line.
      const signedIn = flip.includes("identity")
        ? await mutate("servicesDryRun", slug, {
            services: Object.fromEntries(
              flip.map((f) => [f, { enabled: false }]),
            ) as UpdateServices,
          })
            .then((r) => r.signedInDevicesToClear)
            .catch(() => null)
        : null;
      if (!(await gate.ask({ slugs: flip, signedIn }))) return;
    }
    if (!(await write(flip, on))) return;
    const pulled = flip.slice(1);
    const undo = { label: "Undo", onClick: () => void write(flip, !on) };
    if (on)
      toast.success(`${serviceLabel(s)} turned on`, {
        description: pulled.length
          ? `Also turned on ${listOf(pulled)}.`
          : undefined,
        action: undo,
      });
    else
      toast.success(`${serviceLabel(s)} turned off`, {
        description: pulled.length
          ? `${listOf(pulled)} turned off with it.`
          : undefined,
        action: undo,
      });
  };

  const regForm = useAdminForm<{ registration: string }>({
    values: { registration: savedRegistration },
    onSubmit: async ({ registration }) => {
      setCodes([]);
      setSwitchError(null);
      try {
        const next = await mutate("updateServices", slug, {
          registration:
            registration === DERIVED
              ? null
              : (registration as RegistrationPolicy),
        });
        queryClient.setQueryData(qk.services(slug), next);
      } catch (err) {
        if (err instanceof ApiError && err.errors?.length) setCodes(err.errors);
        throw err;
      }
      toast.success("Registration policy saved");
    },
    // Coherence codes render beside their controls; anything else falls to the callout.
    mapServerErrors: () => null,
  });
  const guard = useUnsavedChangesGuard(regForm.isDirty, {
    message: "Discard your change to the registration policy?",
    onDiscard: regForm.discard,
  });
  const registration = regForm.rhf.watch("registration");
  const draft: Draft = { ...enabled, registration };

  // Server (or refused-flip) codes describe the last attempt; while the policy is being edited
  // and nothing was refused, the live check speaks.
  const shown =
    codes.length === 0 && regForm.isDirty ? draftCoherence(draft) : codes;
  const messagesFor = (target: ServiceSlug | "registration"): string[] =>
    shown
      .filter((code) => (ERROR_TARGETS[code] ?? []).includes(target))
      .map((code) => SERVICE_ERROR_MESSAGES[code] ?? errorText(code));

  const regError =
    regForm.submitError &&
    !(
      regForm.submitError instanceof ApiError &&
      regForm.submitError.errors?.length
    )
      ? regForm.submitError
      : null;

  const isAdmin = data.source === "admin";
  const busy = pending !== null || regForm.isSubmitting;
  const turnOffSlugs = gate.payload?.slugs ?? [];

  return (
    <SettingsTemplate
      header={header}
      sections={[
        { id: "services-enablement", title: "Enabled services" },
        { id: "services-registration", title: "Device registration" },
        { id: "services-package-feeds", title: "Package feeds" },
      ]}
    >
      <SettingsSection
        id="services-enablement"
        title="Enabled services"
        description="Each switch saves on its own. Turning one on also turns on what it needs."
        source={
          <SourceBadge
            source={isAdmin ? "admin" : "manifest"}
            path=".pkey/product"
          />
        }
        actions={
          // Nothing to revert while the manifest already owns the set.
          isAdmin ? (
            <Button
              variant="outline"
              size="sm"
              iconStart={<Undo2 aria-hidden />}
              onClick={() => setConfirmRevert(true)}
            >
              Revert to manifest…
            </Button>
          ) : undefined
        }
        footer={
          <>
            {/* A code this build cannot place (a newer worker rule) is stated, not dropped. */}
            {shown
              .filter((code) => ERROR_TARGETS[code] === undefined)
              .map((code) => (
                <div key={code} className="border-t border-border px-5 py-3">
                  <Callout
                    tone="danger"
                    title="These services can't be saved together"
                  >
                    {SERVICE_ERROR_MESSAGES[code] ?? errorText(code)}
                  </Callout>
                </div>
              ))}
            {switchError ? (
              <div className="border-t border-border px-5 py-3">
                <Callout tone="danger" title={errorCopy(switchError).title}>
                  {errorCopy(switchError).description}
                </Callout>
              </div>
            ) : null}
          </>
        }
      >
        {SERVICE_TABLE.map((row) => {
          const problems = messagesFor(row.slug);
          const needs = needsOf(row.slug);
          const id = `service-${row.slug}`;
          return (
            <div key={row.slug} data-service={row.accent}>
              <SettingsRow
                label={
                  <span className="inline-flex items-center gap-2">
                    <ServiceGlyph id={row.slug} />
                    {row.label}
                  </span>
                }
                htmlFor={id}
                help={
                  <>
                    {row.summary}
                    {needs.length ? (
                      <span className="block">Needs {listOf(needs)}.</span>
                    ) : null}
                  </>
                }
                footer={
                  problems.length ? (
                    <div className="mt-2">
                      {problems.map((message) => (
                        <CoherenceLine key={message} message={message} />
                      ))}
                    </div>
                  ) : undefined
                }
              >
                <Switch
                  id={id}
                  checked={enabled[row.slug]}
                  readOnly={busy}
                  onCheckedChange={(c) => void flipService(row.slug, c)}
                  aria-invalid={problems.length ? true : undefined}
                />
              </SettingsRow>
            </div>
          );
        })}
      </SettingsSection>

      <Form form={regForm} aria-label="Device registration">
        <SettingsSection
          id="services-registration"
          title="Device registration"
          description={
            <a
              href={docsUrl("registrationPolicy")}
              target="_blank"
              rel="noreferrer"
              className="text-accent-fg underline-offset-4 hover:underline"
            >
              How registration works
            </a>
          }
          footer={
            <>
              {regError ? (
                <div className="px-5 py-3">
                  <Callout tone="danger" title={errorCopy(regError).title}>
                    {errorCopy(regError).description}
                  </Callout>
                </div>
              ) : null}
              <SaveBar
                form={regForm}
                section="Device registration"
                saveLabel="Save registration policy"
              />
            </>
          }
        >
          <SettingsRow
            label="Registration policy"
            align="block"
            aside={
              <span className="text-fg-muted">
                Enforced now:{" "}
                <span className="font-medium text-fg-strong">
                  {REGISTRATION_LABELS[data.effectiveRegistration] ??
                    data.effectiveRegistration}
                </span>
                {regForm.isDirty &&
                effectiveOf(draft) !== data.effectiveRegistration ? (
                  <>
                    {" · After saving: "}
                    <span className="font-medium text-fg-strong">
                      {REGISTRATION_LABELS[effectiveOf(draft)] ??
                        effectiveOf(draft)}
                    </span>
                  </>
                ) : null}
              </span>
            }
          >
            <RadioCards
              aria-label="Registration policy"
              name="registration"
              id="services-registration-policy"
              options={REGISTRATION_OPTIONS}
              columns={2}
              value={registration}
              readOnly={busy}
              aria-invalid={
                messagesFor("registration").length ? true : undefined
              }
              onChange={(v) => {
                setCodes([]);
                regForm.rhf.setValue("registration", v, { shouldDirty: true });
              }}
            />
            {messagesFor("registration").map((message) => (
              <CoherenceLine key={message} message={message} />
            ))}
          </SettingsRow>
        </SettingsSection>
      </Form>

      <PackageFeedsSection slug={slug} distributionOn={saved.distribution} />

      <ConfirmDialog
        open={gate.open}
        onOpenChange={(open) => {
          if (!open) gate.cancel();
        }}
        intent={intentOf("service.disable")}
        title={`Turn off ${serviceLabel(turnOffSlugs[0] ?? "license")}?`}
        consequences={[
          ...(turnOffSlugs.length > 1
            ? [
                `Also turns off ${listOf(turnOffSlugs.slice(1))}, which ${turnOffSlugs.length > 2 ? "need" : "needs"} it.`,
              ]
            : []),
          ...turnOffSlugs.map((s) => DISABLE_CONSEQUENCES[s]),
          ...signedInConsequence(gate.payload?.signedIn ?? null),
          "The section leaves the navigation; its settings are kept and return when it is turned on again.",
        ]}
        confirmLabel={
          turnOffSlugs.length > 1
            ? `Turn off ${turnOffSlugs.length} services`
            : `Turn off ${serviceLabel(turnOffSlugs[0] ?? "license")}`
        }
        onConfirm={gate.confirm}
      />
      <ConfirmDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        intent="caution"
        title="Revert services to the manifest?"
        description="Ownership of this product's service set returns to its repo manifest."
        consequences={[
          "Nothing changes now: the services stay as they are.",
          "The manifest's values apply on the next resync (a push, or Resync from repo).",
        ]}
        confirmLabel="Revert to manifest"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revertServices", slug);
          toast.success("Services follow the manifest again");
        }}
      />
      {guard.dialog}
    </SettingsTemplate>
  );
}

type UpdateServices = Partial<Record<ServiceSlug, { enabled: boolean }>>;

function CoherenceLine({ message }: { message: string }): React.ReactElement {
  return <p className="mt-2 text-xs text-danger">{message}</p>;
}

function errorText(code: string): string {
  return `The server refused this set (${code}).`;
}

/**
 * Distribution's `packageFeeds` sub-capability (F-11, plans/F-01.md §6.3): whether the product's
 * packages are served on the registry host. Operator-owned (a manifest never writes it), its own
 * resource (`PUT …/distribution/package-feeds`, 409 when it moved). Like the service switches it
 * saves on its own: on is L0 with an undo toast, off is L1 (every feed of the product stops
 * answering at once).
 */
function PackageFeedsSection({
  slug,
  distributionOn,
}: {
  slug: string;
  distributionOn: boolean;
}): React.ReactElement {
  const query = useQuery(
    {
      queryKey: qk.packageFeedsSwitch(slug),
      queryFn: () => api.packageFeeds(slug),
    },
    queryClient,
  );
  const gate = useConfirmGate<true>();
  const [pending, setPending] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  // The undo toast outlives this render: it reads the switch's version from here, not a closure.
  const latest = React.useRef(query.data?.packageFeeds);
  latest.current = query.data?.packageFeeds;
  const enabled = pending ?? query.data?.packageFeeds?.enabled ?? false;

  const write = async (on: boolean): Promise<boolean> => {
    setError(null);
    setPending(on);
    try {
      const res = await mutate("savePackageFeeds", slug, {
        enabled: on,
        expectedVersion: latest.current?.version ?? 0,
      });
      queryClient.setQueryData(qk.packageFeedsSwitch(slug), {
        packageFeeds: res.packageFeeds,
      });
      latest.current = res.packageFeeds;
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setPending(null);
    }
  };
  const flip = async (on: boolean): Promise<void> => {
    if (!on && !(await gate.ask(true))) return;
    if (!(await write(on))) return;
    toast.success(on ? "Package feeds turned on" : "Package feeds turned off", {
      action: { label: "Undo", onClick: () => void write(!on) },
    });
  };

  return (
    <div data-service="distribution">
      <SettingsSection
        id="services-package-feeds"
        title="Package feeds"
        description={
          <>
            npm, pip, docker, SwiftPM, Gradle and Godot, from the registry host.{" "}
            <a
              href={docsUrl("packageFeeds")}
              target="_blank"
              rel="noreferrer"
              className="text-accent-fg underline-offset-4 hover:underline"
            >
              How package feeds work
            </a>
          </>
        }
        footer={
          error ? (
            <div className="border-t border-border px-5 py-3">
              <Callout tone="danger" title={errorCopy(error).title}>
                {errorCopy(error).description}
              </Callout>
            </div>
          ) : undefined
        }
      >
        {query.isError ? (
          <div className="px-5 py-4">
            <ErrorState
              compact
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : (
          <SettingsRow
            label={
              <span className="inline-flex items-center gap-2">
                <ServiceGlyph id="distribution" />
                Package feeds
              </span>
            }
            htmlFor="service-package-feeds"
            help={
              distributionOn
                ? enabled
                  ? "On: every feed of this product answers installs and updates."
                  : "Off: every feed of this product answers not-found. Its feed settings are kept."
                : "Needs Distribution: with Distribution off, no feed answers whatever this says."
            }
          >
            <Switch
              id="service-package-feeds"
              checked={enabled}
              readOnly={pending !== null || query.isPending}
              onCheckedChange={(c) => void flip(c)}
            />
          </SettingsRow>
        )}
      </SettingsSection>
      <ConfirmDialog
        open={gate.open}
        onOpenChange={(open) => {
          if (!open) gate.cancel();
        }}
        intent={intentOf("packageFeeds.disable")}
        title="Turn off package feeds?"
        consequences={[
          "Every feed of this product answers not-found within 30 seconds: installs and updates from it fail.",
          "Package feeds leave the navigation; feed settings, packages and versions are kept and answer again when it is turned on.",
        ]}
        confirmLabel="Turn off package feeds"
        onConfirm={gate.confirm}
      />
    </div>
  );
}
