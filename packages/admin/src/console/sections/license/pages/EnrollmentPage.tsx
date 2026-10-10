/**
 * License → Enrollment (ADMIN.md §6.5.3, T4). Three sections:
 *
 * 1. **Registration**: declared vs enforced, read-only, with **Change in Services** (FPP-2). It is
 *    a Core policy derived from the service set; a second control here would split one value.
 * 2. **Fingerprint policy**: one mode choice (Off, Lenient, Normal, Strict) replaces the switch
 *    plus mode that overlapped (FPP-1); the section's `SourceBadge` says who owns it; Revert
 *    names both effects, the fingerprint policy and auto-issue (FPP-3).
 * 3. **Probes**: a sortable table, where they come from, and **Resync from repo** (FPP-4), the
 *    console's one resync flow (UX-78).
 *
 * The probe list is not editable: `PATCH` replaces the whole array, and an editor that rendered
 * only the fields it knows would delete the per-platform hints it does not.
 */

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type FingerprintMode,
  type FingerprintProbeDto,
} from "../../../../api.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { r } from "../../../routes.js";
import { Link } from "../../../router.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useResyncFlow } from "../../../components/ResyncDialog.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../../templates/Settings.js";
import { confirmFor } from "../../../../lib/actions.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { REGISTRATION_LABELS } from "../../../../lib/labels.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Form, FormField, useAdminForm } from "../../../../ui/form.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { toast } from "../../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import { DataTable, type DataColumn } from "../../../../ui/data-table/index.js";

/**
 * The modes, with the drift each tolerates (`FINGERPRINT_TOLERANCE` in the shared protocol):
 * component counts, because that is the difference an operator is choosing between.
 */
export const MODES: {
  value: FingerprintMode;
  label: string;
  description: string;
}[] = [
  {
    value: "off",
    label: "Off",
    description:
      "Recorded, never enforced: no device is refused for drift, whatever its tier.",
  },
  {
    value: "lenient",
    label: "Lenient",
    description: "Up to 4 changed components still count as the same machine.",
  },
  {
    value: "normal",
    label: "Normal",
    description: "Up to 2 changed components still count as the same machine.",
  },
  {
    value: "strict",
    label: "Strict",
    description:
      "Every component must match, and a device with no fingerprint is refused.",
  },
];

interface PolicyValues {
  [key: string]: unknown;
  mode: FingerprintMode;
}

/** One choice over the API's two fields: `enabled: false` is Off for every tier. */
export function modeOf(policy: {
  enabled: boolean;
  defaultMode: FingerprintMode;
}): FingerprintMode {
  return policy.enabled ? policy.defaultMode : "off";
}

/** The PATCH for a chosen mode. `probes` is never sent: it would claim the manifest's list. */
export function policyPatch(mode: FingerprintMode): {
  enabled: boolean;
  defaultMode: FingerprintMode;
} {
  return mode === "off"
    ? { enabled: false, defaultMode: "off" }
    : { enabled: true, defaultMode: mode };
}

export function EnrollmentPage({ slug }: { slug: string }): React.ReactElement {
  const policyQ = useQuery({
    queryKey: qk.fingerprintPolicy(slug),
    queryFn: () => api.fingerprintPolicy(slug),
  });
  return (
    <SettingsTemplate
      header={
        <PageHeader
          title="Enrollment"
          refetching={policyQ.isFetching && !policyQ.isPending}
        />
      }
      sections={[
        { id: "enrollment-registration", title: "Registration" },
        { id: "enrollment-fingerprint", title: "Fingerprint policy" },
        { id: "enrollment-probes", title: "Probes" },
      ]}
    >
      <RegistrationSection slug={slug} />
      {policyQ.isPending ? (
        <>
          <section
            aria-busy="true"
            aria-label="Loading the fingerprint policy"
            className="space-y-3 rounded-lg border border-border bg-surface-raised p-5"
          >
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-24 w-full" />
          </section>
          <ProbesShell busy>
            <Skeleton className="h-16 w-full" />
          </ProbesShell>
        </>
      ) : policyQ.data ? (
        <>
          <PolicySection
            slug={slug}
            policy={policyQ.data.policy}
            source={policyQ.data.source}
          />
          <ProbesSection slug={slug} probes={policyQ.data.policy.probes} />
        </>
      ) : (
        <>
          <SettingsSection
            id="enrollment-fingerprint"
            title="Fingerprint policy"
          >
            <div className="p-5">
              <ErrorState
                error={policyQ.error}
                onRetry={() => void policyQ.refetch()}
                compact
              />
            </div>
          </SettingsSection>
          <ProbesShell>
            <p className="text-sm text-fg-muted">
              Probes load with the fingerprint policy.
            </p>
          </ProbesShell>
        </>
      )}
    </SettingsTemplate>
  );
}

/**
 * The Probes card while the policy it comes from is loading or failed, so the "On this page"
 * anchor always has a target. A plain card, not a labelled region: the real section replaces it.
 */
function ProbesShell({
  busy = false,
  children,
}: {
  busy?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      id="enrollment-probes"
      aria-busy={busy || undefined}
      className="scroll-mt-20 rounded-lg border border-border bg-surface-raised"
    >
      <p className="border-b border-border px-5 py-3 text-base font-semibold text-fg-strong">
        Probes
      </p>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function RegistrationSection({ slug }: { slug: string }): React.ReactElement {
  const servicesQ = useQuery({
    queryKey: qk.services(slug),
    queryFn: () => api.services(slug),
  });
  const data = servicesQ.data;
  const label = (v: string) => REGISTRATION_LABELS[v] ?? v;
  return (
    <SettingsSection
      id="enrollment-registration"
      title="Registration"
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to={r.services(slug)}>Change in Services</Link>
        </Button>
      }
    >
      {servicesQ.isPending ? (
        <div className="p-5">
          <Skeleton className="h-6 w-48" />
        </div>
      ) : data ? (
        <>
          <SettingsRow label="Enforced now">
            <StatusPill tone="accent" icon={null}>
              {label(data.effectiveRegistration)}
            </StatusPill>
          </SettingsRow>
          <SettingsRow label="Declared">
            {data.registration ? (
              label(data.registration)
            ) : (
              <span className="text-fg-muted">
                None: derived from the services
              </span>
            )}
          </SettingsRow>
        </>
      ) : (
        <div className="p-5">
          <ErrorState
            error={servicesQ.error}
            onRetry={() => void servicesQ.refetch()}
            compact
          />
        </div>
      )}
    </SettingsSection>
  );
}

function PolicySection({
  slug,
  policy,
  source,
}: {
  slug: string;
  policy: { enabled: boolean; defaultMode: FingerprintMode };
  source: "manifest" | "admin";
}): React.ReactElement {
  const [reverting, setReverting] = React.useState(false);
  const values = React.useMemo<PolicyValues>(
    () => ({ mode: modeOf(policy) }),
    [policy],
  );
  const form = useAdminForm<PolicyValues>({
    values,
    onSubmit: async (v) => {
      await mutate("updateFingerprintPolicy", slug, policyPatch(v.mode));
      toast.success("Fingerprint policy saved");
    },
  });
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard the unsaved fingerprint policy?",
    onDiscard: form.discard,
  });
  // `enabled` with mode `off`: the product default is off, but a tier that sets its own mode
  // still enforces it. Saving "Off" turns enforcement off for every tier.
  const tiersStillEnforce = policy.enabled && policy.defaultMode === "off";

  return (
    <Form form={form} aria-label="Fingerprint policy">
      <SettingsSection
        id="enrollment-fingerprint"
        title="Fingerprint policy"
        source={
          <SourceBadge
            source={source}
            path={source === "manifest" ? ".pkey/product" : undefined}
            onRevert={source === "admin" ? () => setReverting(true) : undefined}
          />
        }
      >
        <div className="space-y-4 px-5 py-4">
          <FormField
            name="mode"
            label="Mode"
            group
            help="A tier may set its own mode. A device that still presents the machine anchor is allowed one extra changed component."
          >
            {(f) => <RadioCards {...f} columns={4} options={MODES} />}
          </FormField>
          {tiersStillEnforce ? (
            <Callout tone="info">
              The product default is off, but tiers that set their own mode
              still enforce it. Saving Off turns enforcement off for every tier.
            </Callout>
          ) : null}
        </div>
      </SettingsSection>
      <SaveBar
        form={form}
        saveLabel="Save policy"
        section="Fingerprint policy"
      />
      {guard.dialog}
      <ConfirmDialog
        open={reverting}
        onOpenChange={setReverting}
        intent={confirmFor("manifest.revert").intent as "caution"}
        title="Return the device policy to the manifest?"
        consequences={[
          "The fingerprint policy goes back to manifest ownership.",
          "The auto-issue policy goes back to manifest ownership too.",
          "Live values don't change until the next resync applies the manifest's.",
        ]}
        confirmLabel="Return to manifest"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revertFingerprintPolicy", slug);
          toast.success("Returned to manifest control", {
            description: "The manifest's policy applies at the next resync.",
          });
        }}
      >
        <a
          className="text-sm text-accent-fg underline underline-offset-2"
          href={docsUrl("fingerprintRevert")}
          target="_blank"
          rel="noreferrer"
        >
          Docs
        </a>
      </ConfirmDialog>
    </Form>
  );
}

function ProbesSection({
  slug,
  probes,
}: {
  slug: string;
  probes: FingerprintProbeDto[];
}): React.ReactElement {
  const product = useProduct(slug).data;
  const linked = product?.releaseSource === "github";
  const [state, setState] = useTableUrlState("probes");
  // The console's one resync flow (UX-78): the dry run's plan, then a focused result panel.
  const resync = useResyncFlow();
  const columns = React.useMemo<DataColumn<FingerprintProbeDto>[]>(
    () => [
      {
        id: "label",
        header: "Probe",
        accessorFn: (p) => p.label || p.id,
        meta: { priority: 1 },
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">{getValue() as string}</span>
        ),
      },
      {
        id: "id",
        header: "Id",
        accessorKey: "id",
        meta: { priority: 1, mono: true },
      },
      ...(["macos", "windows", "linux"] as const).map(
        (os): DataColumn<FingerprintProbeDto> => ({
          id: os,
          header: { macos: "macOS", windows: "Windows", linux: "Linux" }[os],
          accessorFn: (p) => p[os] ?? "",
          // Priority 1: the paths are the probe's content, so phone cards show them too.
          meta: { priority: 1, mono: true },
          cell: ({ getValue }) =>
            (getValue() as string) || (
              <span className="font-sans text-fg-muted">—</span>
            ),
        }),
      ),
    ],
    [],
  );
  return (
    <SettingsSection
      id="enrollment-probes"
      title="Probes"
      description={
        <>
          From <code className="font-mono text-xs">.pkey/product</code>; each
          device's answers show in its drawer.
        </>
      }
      actions={
        <Button
          variant="outline"
          size="sm"
          iconStart={<RefreshCw />}
          disabledReason={
            linked ? undefined : "This product isn't linked to a repository."
          }
          onClick={() => resync.start({ slug, name: product?.name ?? slug })}
        >
          Resync from repo
        </Button>
      }
    >
      <div className="space-y-4 px-5 py-4">
        {resync.panel}
        <DataTable<FingerprintProbeDto>
          id="probes"
          caption="Probes"
          data={probes}
          columns={columns}
          getRowId={(p) => p.id}
          state={state}
          onStateChange={setState}
          exportCsv={false}
          empty={
            <EmptyState
              kind="first-run"
              variant="inline"
              title="No probes declared"
              description="Add probes to the product manifest and resync to collect companion-app facts."
              docs={docsUrl("deviceFingerprints")}
            />
          }
          mobile="cards"
        />
      </div>
      {resync.dialog}
    </SettingsSection>
  );
}
