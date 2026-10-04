/**
 * Core → Services (T4; docs/design/ADMIN.md §2.3, §7.2 chunk 5). Which services the product runs
 * and how a device may register: the one authority every other console affordance projects
 * (the sidebar's sections included).
 *
 * - The server validates the SET, not each flag (`core/services.ts`): the draft accumulates a
 *   whole proposed set and one `SaveBar` submits it (SVC-3).
 * - Dependencies are visible before a save: each row names what it requires and what requires
 *   it, and a draft that breaks an edge says so inline with a one-click fix (SVC-1). The server's
 *   coherence codes still land beside the controls they indict.
 * - Turning a service off is L1: the save asks first, with the consequences (SVC-2).
 * - Each row is its service's `data-service` scope, so its glyph and switch take the accent
 *   (SVC-4). Raw slugs never show: policies read through `REGISTRATION_LABELS` (SVC-5).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Undo2 } from "lucide-react";
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
import { cn } from "../../../lib/cn.js";
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
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { PageHeader } from "../../components/PageHeader.js";
import { queryClient } from "../../data/queryClient.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../templates/Settings.js";
import { SaveCancelled, intentOf, useConfirmGate } from "./confirmGate.js";

/** "Derived from services": no declared policy. RadioCards needs a string value. */
const DERIVED = "derived";

type Draft = Record<ServiceSlug, boolean> & { registration: string };

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
  identity: "Product sign-in and the customer portal stop working.",
};

function readDraft(data: ServicesResponse): Draft {
  const out = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, data.services?.[s]?.enabled === true]),
  ) as Record<ServiceSlug, boolean>;
  return { ...out, registration: data.registration ?? DERIVED };
}

/** The coherence codes a draft would earn, computed as the server does, before any save. */
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

/** Services that require `slug`. */
const REQUIRED_BY: Record<ServiceSlug, ServiceSlug[]> = Object.fromEntries(
  SERVICE_SLUGS.map((s) => [
    s,
    SERVICE_SLUGS.filter((o) => SERVICE_REQUIRES[o].includes(s)),
  ]),
) as Record<ServiceSlug, ServiceSlug[]>;

export function ServicesPage({ slug }: { slug: string }): React.ReactElement {
  const query = useQuery(
    { queryKey: qk.services(slug), queryFn: () => api.services(slug) },
    queryClient,
  );
  useLoadingAnnouncement("services", query.isPending);

  const header = (
    <PageHeader
      title="Services"
      description="Which Polaris Key services this product runs, and how a device may register."
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
  const [confirmRevert, setConfirmRevert] = React.useState(false);
  const gate = useConfirmGate<ServiceSlug[]>();
  const values = React.useMemo(() => readDraft(data), [data]);

  const form = useAdminForm<Draft>({
    values,
    onSubmit: async (draft) => {
      setCodes([]);
      const turningOff = SERVICE_SLUGS.filter((s) => values[s] && !draft[s]);
      if (turningOff.length && !(await gate.ask(turningOff))) {
        throw new SaveCancelled();
      }
      try {
        await mutate("updateServices", slug, {
          services: Object.fromEntries(
            SERVICE_SLUGS.map((s) => [s, { enabled: draft[s] }]),
          ) as Record<ServiceSlug, { enabled: boolean }>,
          registration:
            draft.registration === DERIVED
              ? null
              : (draft.registration as RegistrationPolicy),
        });
      } catch (err) {
        if (err instanceof ApiError && err.errors?.length) setCodes(err.errors);
        throw err;
      }
      toast.success("Services saved");
    },
    // Coherence codes render beside their controls; malformed fields fall to the summary.
    mapServerErrors: () => null,
  });
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard your changes to services?",
    onDiscard: form.discard,
  });

  const draft = form.rhf.watch() as Draft;
  const proposed = draftCoherence(draft);
  // Server codes describe the last submitted set; once the draft moves, the live check speaks.
  const shown = form.isDirty && codes.length === 0 ? proposed : codes;
  const messagesFor = (target: ServiceSlug | "registration"): string[] =>
    shown
      .filter((code) => (ERROR_TARGETS[code] ?? []).includes(target))
      .map((code) => SERVICE_ERROR_MESSAGES[code] ?? errorText(code));
  const enable = (s: ServiceSlug, on: boolean): void => {
    setCodes([]);
    form.rhf.setValue(s, on, { shouldDirty: true });
  };

  const submitError =
    form.submitError &&
    !(form.submitError instanceof SaveCancelled) &&
    !(form.submitError instanceof ApiError && form.submitError.errors?.length)
      ? form.submitError
      : null;

  const isAdmin = data.source === "admin";

  return (
    <SettingsTemplate
      header={header}
      sections={[
        { id: "services-enablement", title: "Enabled services" },
        { id: "services-registration", title: "Device registration" },
      ]}
    >
      <Form form={form} aria-label="Services" className="space-y-6">
        <SettingsSection
          id="services-enablement"
          title="Enabled services"
          description="A service that is off answers not-configured on the wire and leaves the navigation."
          source={
            <SourceBadge
              source={isAdmin ? "admin" : "manifest"}
              path=".pkey/product"
            />
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              iconStart={<Undo2 aria-hidden />}
              disabledReason={
                isAdmin
                  ? undefined
                  : "The manifest already owns this product's services."
              }
              onClick={() => setConfirmRevert(true)}
            >
              Revert to manifest…
            </Button>
          }
        >
          {SERVICE_TABLE.map((row) => {
            const problems = messagesFor(row.slug);
            const requires = SERVICE_REQUIRES[row.slug];
            const requiredBy = REQUIRED_BY[row.slug];
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
                      {requires.length ? (
                        <span className="mt-1 block text-xs">
                          Requires {requires.map(serviceLabel).join(", ")}.
                        </span>
                      ) : null}
                      {requiredBy.length ? (
                        <span className="mt-1 block text-xs">
                          Required by {requiredBy.map(serviceLabel).join(", ")}.
                        </span>
                      ) : null}
                    </>
                  }
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Switch
                      id={id}
                      checked={draft[row.slug]}
                      readOnly={form.isSubmitting}
                      onCheckedChange={(c) => enable(row.slug, c)}
                      aria-invalid={problems.length ? true : undefined}
                    />
                    <span className="text-sm text-fg-muted">
                      {draft[row.slug] ? "On" : "Off"}
                    </span>
                    {draft[row.slug] !== values[row.slug] ? (
                      <StatusPill tone="accent" icon={null} size="sm">
                        Changed
                      </StatusPill>
                    ) : null}
                  </div>
                  {problems.map((message) => (
                    <CoherenceLine
                      key={message}
                      message={message}
                      fix={fixFor(row.slug, draft)}
                      onFix={enable}
                    />
                  ))}
                </SettingsRow>
              </div>
            );
          })}
          <SettingsRow
            label="Delivery chain"
            help="Release says what exists, Distribution delivers it, Update offers it to clients. Each needs the one before it."
          >
            <DeliveryChain draft={draft} />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection
          id="services-registration"
          title="Device registration"
          description={
            <>
              How a device obtains a token.{" "}
              <a
                href={docsUrl("registrationPolicy")}
                target="_blank"
                rel="noreferrer"
                className="text-accent-fg underline-offset-4 hover:underline"
              >
                How registration works
              </a>
            </>
          }
        >
          <SettingsRow
            label="Registration policy"
            help={
              <>
                Enforced now:{" "}
                <StatusPill tone="neutral" icon={null}>
                  {REGISTRATION_LABELS[data.effectiveRegistration] ??
                    data.effectiveRegistration}
                </StatusPill>
                {form.isDirty &&
                effectiveOf(draft) !== data.effectiveRegistration ? (
                  <span className="mt-1 block">
                    After saving:{" "}
                    {REGISTRATION_LABELS[effectiveOf(draft)] ??
                      effectiveOf(draft)}
                  </span>
                ) : null}
              </>
            }
          >
            <RadioCards
              aria-label="Registration policy"
              name="registration"
              id="services-registration-policy"
              options={REGISTRATION_OPTIONS}
              columns={2}
              value={draft.registration}
              readOnly={form.isSubmitting}
              aria-invalid={
                messagesFor("registration").length ? true : undefined
              }
              onChange={(v) => {
                setCodes([]);
                form.rhf.setValue("registration", v, { shouldDirty: true });
              }}
            />
            {messagesFor("registration").map((message) => (
              <CoherenceLine key={message} message={message} />
            ))}
          </SettingsRow>
        </SettingsSection>

        {/* A code this build cannot place (a newer worker rule) is stated, not dropped. */}
        {shown
          .filter((code) => ERROR_TARGETS[code] === undefined)
          .map((code) => (
            <Callout
              key={code}
              tone="danger"
              title="These services can't be saved together"
            >
              {SERVICE_ERROR_MESSAGES[code] ?? errorText(code)}
            </Callout>
          ))}
        {submitError ? (
          <Callout tone="danger" title={errorCopy(submitError).title}>
            {errorCopy(submitError).description}
          </Callout>
        ) : null}
        <SaveBar form={form} section="Services" saveLabel="Save services" />
      </Form>

      <ConfirmDialog
        open={gate.open}
        onOpenChange={(open) => {
          if (!open) gate.cancel();
        }}
        intent={intentOf("service.disable")}
        title={`Turn off ${(gate.payload ?? []).map(serviceLabel).join(", ")}?`}
        consequences={[
          ...(gate.payload ?? []).map((s) => DISABLE_CONSEQUENCES[s]),
          "The section leaves the navigation; its settings are kept and return when it is turned on again.",
        ]}
        confirmLabel={`Turn off ${(gate.payload ?? []).length === 1 ? serviceLabel(gate.payload![0]!) : "services"}`}
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

/** The one-click fix for a broken edge on `slug`: enable what it needs, or turn it off. */
function fixFor(
  slug: ServiceSlug,
  draft: Draft,
): { label: string; service: ServiceSlug; on: boolean } | undefined {
  const missing = SERVICE_REQUIRES[slug].find((r) => !draft[r]);
  if (draft[slug] && missing)
    return {
      label: `Turn on ${serviceLabel(missing)}`,
      service: missing,
      on: true,
    };
  const dependent = REQUIRED_BY[slug].find((d) => draft[d]);
  if (!draft[slug] && dependent)
    return {
      label: `Turn off ${serviceLabel(dependent)} too`,
      service: dependent,
      on: false,
    };
  return undefined;
}

function CoherenceLine({
  message,
  fix,
  onFix,
}: {
  message: string;
  fix?: { label: string; service: ServiceSlug; on: boolean };
  onFix?: (s: ServiceSlug, on: boolean) => void;
}): React.ReactElement {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-danger">
      <span>{message}</span>
      {fix && onFix ? (
        <Button
          variant="link"
          size="xs"
          onClick={() => onFix(fix.service, fix.on)}
        >
          {fix.label}
        </Button>
      ) : null}
    </p>
  );
}

/** Release → Distribution → Update, each with its state in words (never color alone). */
function DeliveryChain({ draft }: { draft: Draft }): React.ReactElement {
  const chain: ServiceSlug[] = ["release", "distribution", "update"];
  return (
    <ol
      aria-label="Delivery chain"
      className="flex flex-wrap items-center gap-2"
    >
      {chain.map((s, i) => (
        <li key={s} className="flex items-center gap-2" data-service={s}>
          {i > 0 ? (
            <ArrowRight aria-hidden className="size-4 text-fg-subtle" />
          ) : null}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm",
              draft[s]
                ? "border-accent bg-accent-subtle text-fg-strong"
                : "border-border text-fg-muted",
            )}
          >
            <ServiceGlyph id={s} />
            {serviceLabel(s)}
            <span className="text-xs">{draft[s] ? "On" : "Off"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function errorText(code: string): string {
  return `The server refused this set (${code}).`;
}
