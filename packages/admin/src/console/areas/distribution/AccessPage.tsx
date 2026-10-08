/**
 * Distribution → Access (ADMIN.md §6.4, T4): who may download each deliverable — Distribution's
 * delivery access, the ONE answer the appcast, the downloads and the portal read. Moved here
 * from Update settings.
 *
 * - One section for the app and **one per pack** (UPS-5, DLV-3), each its own form and SaveBar
 *   (UPS-1, UPS-6): saving one never touches another.
 * - Modes are `RadioCards` with their consequence inline. A pack's `entitled` mode takes its
 *   **gate**, a catalog flag (a combobox when Config is on).
 * - The app's `SourceBadge` offers **Revert to manifest** only while the console owns it (UPS-4,
 *   UPS-7); a pack has no manifest spelling.
 * - Nothing is shown as "Public" while loading or on error (UPS-3); a refetch never wipes an edit
 *   (UPS-2, `useAdminForm`).
 * - `?deliverable=<id>` scrolls to that pack's section (the Deliverables gate cell links here).
 */

import * as React from "react";
import type { DeliveryAccess, ReleaseAccess } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import { ACCESS_DESCRIPTIONS, ACCESS_LABELS } from "../../../lib/labels.js";
import { Callout } from "../../../ui/Callout.js";
import { Combobox } from "../../../ui/Combobox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Form, FormField, useAdminForm } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { useProductServices } from "../../../context.js";
import { useSearchParam } from "../../router.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../templates/Settings.js";
import { QUERY, useAccess, useCatalog, useDeliverables } from "./data.js";
import { serverFieldErrors, SubmitError } from "./forms.js";

const MODES: ReleaseAccess[] = [
  "public",
  "authenticated",
  "licensed",
  "entitled",
];

/** The app's `entitled` is Release's eligibility (channel and version window), not a flag. */
const APP_ENTITLED =
  "A device whose own license covers the requested channel and version.";
const PACK_ENTITLED = "A device whose license holds the pack's gate flag.";

function modeOptions(kind: "app" | "pack") {
  return MODES.map((m) => ({
    value: m,
    label: ACCESS_LABELS[m] ?? m,
    description:
      m === "entitled"
        ? kind === "app"
          ? APP_ENTITLED
          : PACK_ENTITLED
        : ACCESS_DESCRIPTIONS[m],
  }));
}

const describe = (e: unknown) =>
  errorCopy(e, { area: "distribution", thing: "Deliverable" });

export function AccessPage({ slug }: { slug: string }): React.ReactElement {
  const access = useAccess(slug);
  const deliverables = useDeliverables(slug);
  const services = useProductServices(slug);
  const configOn = services?.config?.enabled !== false;
  const catalog = useCatalog(slug, configOn);
  const [focus] = useSearchParam("deliverable", QUERY.deliverable);

  const packs = (deliverables.data?.deliverables ?? []).filter(
    (d) => d.kind === "pack",
  );
  const flags = (catalog.data?.entries ?? [])
    .filter((e) => e.kind === "flag")
    .map((e) => ({ value: e.key, label: e.label || e.key, secondary: e.key }));

  // DLV-3: arriving from a pack's gate cell, bring its section into view.
  const scrolled = React.useRef(false);
  React.useEffect(() => {
    if (scrolled.current || !access.data || focus === "app") return;
    const el = document.getElementById(`access-${focus}`);
    if (el) {
      scrolled.current = true;
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    }
  }, [access.data, packs.length, focus]);

  const sections = [
    { id: "access-app", title: "App" },
    ...packs.map((p) => ({ id: `access-${p.id}`, title: p.id })),
  ];

  return (
    <SettingsTemplate
      header={
        <PageHeader
          title="Access"
          description="The appcast, the download routes and the customer portal all use this."
          refetching={access.isFetching && !access.isPending}
        />
      }
      sections={sections}
    >
      {access.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading access">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : access.isError || !access.data ? (
        <ErrorState
          error={access.error}
          onRetry={() => void access.refetch()}
          context={{ area: "distribution", thing: "Delivery access" }}
        />
      ) : (
        <>
          <AppAccess slug={slug} access={access.data} />
          {deliverables.isError ? (
            <Callout tone="warning" title="Packs couldn't be listed">
              {errorCopy(deliverables.error).description} The app's access above
              is unaffected.
            </Callout>
          ) : null}
          {packs.map((p) => (
            <PackAccess
              key={p.id}
              slug={slug}
              id={p.id}
              access={access.data!}
              flags={flags}
              flagsAvailable={configOn && catalog.isSuccess}
            />
          ))}
        </>
      )}
    </SettingsTemplate>
  );
}

function AppAccess({
  slug,
  access,
}: {
  slug: string;
  access: DeliveryAccess;
}): React.ReactElement {
  const [reverting, setReverting] = React.useState(false);
  const form = useAdminForm<{ mode: ReleaseAccess }>({
    values: { mode: access.app.mode },
    mapServerErrors: serverFieldErrors,
    onSubmit: async (v) => {
      await mutate("saveDeliveryAccess", slug, { mode: v.mode });
      toast.success(`App access set to ${ACCESS_LABELS[v.mode] ?? v.mode}`);
    },
  });
  const admin = access.app.source === "admin";
  return (
    <Form form={form} aria-label="App access">
      <SettingsSection
        id="access-app"
        title="App"
        source={
          <SourceBadge
            source={admin ? "admin" : "manifest"}
            path=".pkey/release"
            onRevert={admin ? () => setReverting(true) : undefined}
          />
        }
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ area: "distribution" }}
            />
            <SaveBar form={form} section="App" />
          </>
        }
      >
        <SettingsRow
          label="Who may download"
          align="block"
          help={
            admin
              ? "Set in the console: it survives a resync until it is reverted."
              : undefined
          }
        >
          <FormField<ReleaseAccess>
            name="mode"
            label="Who may download"
            hideLabel
            group
          >
            {(field) => (
              <RadioCards<ReleaseAccess>
                {...field}
                columns={4}
                options={modeOptions("app")}
              />
            )}
          </FormField>
        </SettingsRow>
      </SettingsSection>
      <ConfirmDialog
        open={reverting}
        onOpenChange={setReverting}
        intent="caution"
        title="Return the app's access to the manifest?"
        consequences={[
          "The live mode stays as it is until the next resync.",
          "The next resync re-applies access.artifacts from .pkey/release.",
        ]}
        confirmLabel="Revert to manifest"
        describeError={describe}
        onConfirm={async () => {
          await mutate("revertDeliveryAccess", slug);
          toast.success(
            "The app's access returns to the manifest on the next resync",
          );
        }}
      />
    </Form>
  );
}

const ENTITLEMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function PackAccess({
  slug,
  id,
  access,
  flags,
  flagsAvailable,
}: {
  slug: string;
  id: string;
  access: DeliveryAccess;
  flags: { value: string; label: string; secondary: string }[];
  flagsAvailable: boolean;
}): React.ReactElement {
  const row = access.deliverables.find((d) => d.deliverableId === id);
  const form = useAdminForm<{ mode: ReleaseAccess; entitlement: string }>({
    values: {
      mode: row?.mode ?? access.app.mode,
      entitlement: row?.entitlement ?? "",
    },
    resetOn: [row?.modifiedAt ?? null, row?.mode ?? null, access.app.mode],
    mapServerErrors: serverFieldErrors,
    validate: (v): Record<string, string> =>
      v.mode === "entitled" &&
      v.entitlement.trim() !== "" &&
      !ENTITLEMENT.test(v.entitlement.trim())
        ? { entitlement: "Use a short identifier: letters, digits, . _ : -" }
        : {},
    onSubmit: async (v) => {
      const entitlement = v.entitlement.trim();
      await mutate("saveDeliveryAccess", slug, {
        mode: v.mode,
        deliverable: id,
        entitlement:
          v.mode === "entitled"
            ? entitlement === ""
              ? null
              : entitlement
            : undefined,
      });
      toast.success(`${id} access set to ${ACCESS_LABELS[v.mode] ?? v.mode}`);
    },
  });
  const mode = form.rhf.watch("mode");
  const gate = form.rhf.watch("entitlement");
  const options =
    flags.some((f) => f.value === gate) || !gate
      ? flags
      : [
          { value: gate, label: gate, secondary: "not in the catalog" },
          ...flags,
        ];
  return (
    <Form form={form} aria-label={`${id} access`}>
      <SettingsSection
        id={`access-${id}`}
        title={id}
        description={
          row ? (
            <>
              Pack · set <Timestamp at={fromSeconds(row.modifiedAt)} />
            </>
          ) : (
            `Pack · inherits the app's mode (${ACCESS_LABELS[access.app.mode] ?? access.app.mode}) until you set one`
          )
        }
        source={
          row ? (
            <SourceBadge source="admin" />
          ) : (
            <StatusPill tone="neutral" icon={false}>
              Inherited
            </StatusPill>
          )
        }
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ area: "distribution" }}
            />
            <SaveBar form={form} section={id} />
          </>
        }
      >
        <SettingsRow label="Who may download" align="block">
          <FormField<ReleaseAccess>
            name="mode"
            label="Who may download"
            hideLabel
            group
          >
            {(field) => (
              <RadioCards<ReleaseAccess>
                {...field}
                columns={4}
                options={modeOptions("pack")}
              />
            )}
          </FormField>
        </SettingsRow>
        {mode === "entitled" ? (
          <SettingsRow
            label="Gate"
            align="stretch"
            help="The license flag a device must hold. Renaming the flag moves who may download at once."
          >
            <FormField<string> name="entitlement" label="Flag" hideLabel>
              {(field) =>
                flagsAvailable ? (
                  <Combobox
                    id={field.id}
                    value={field.value || null}
                    onChange={(v) => field.onChange(v ?? "")}
                    clearable
                    aria-describedby={field["aria-describedby"]}
                    aria-invalid={field["aria-invalid"]}
                    placeholder="Choose a flag"
                    searchPlaceholder="Search flags"
                    emptyText="No flag matches. Add a flag to the catalog first."
                    options={options}
                  />
                ) : (
                  <Input
                    {...field}
                    mono
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="pro-content"
                  />
                )
              }
            </FormField>
            {gate.trim() === "" ? (
              <Callout tone="warning" title="No gate" className="mt-3">
                With Entitled and no gate, nobody can download this pack.
              </Callout>
            ) : null}
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </Form>
  );
}
