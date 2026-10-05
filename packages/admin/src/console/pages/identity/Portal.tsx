/**
 * Identity → Portal (ADMIN.md §2.3, T4): what the customer portal offers this product's customers
 * and which sign-in methods it accepts. One resource (`GET`/`PATCH …/identity/portal`), so one
 * form and one SaveBar.
 *
 * Fixes IDN-3 (dependencies): with the portal off, the sign-in methods and modules below it are
 * read-only, and "Release downloads" is read-only while the Release service is off. Fixes IDN-4:
 * nothing renders until the endpoint answers (the code defaults never stand in for real values),
 * and branding is shown as a read-out. Fixes IDN-5: the title is the page's name, and the linking
 * select has the width of its longest option.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type PortalProductSettings } from "../../../api.js";
import { fromSeconds } from "../../../lib/format.js";
import { Form, useAdminForm } from "../../../ui/form.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { JsonViewer } from "../../../ui/JsonViewer.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { Select } from "../../../ui/Select.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../templates/Settings.js";

type AutoLink = "auto" | "on" | "off";

/** The draft. `autoLink` is the tri-state as a select value (`null` on the wire is "auto"). */
type PortalDraft = {
  portalEnabled: boolean;
  oidcEnabled: boolean;
  magicEnabled: boolean;
  licenseKeyClaimEnabled: boolean;
  releasesEnabled: boolean;
  keyReissueEnabled: boolean;
  claimByKey: boolean;
  autoLink: AutoLink;
};

type ToggleKey = Exclude<keyof PortalDraft, "autoLink">;

const autoLinkOf = (v: boolean | null): AutoLink =>
  v === null ? "auto" : v ? "on" : "off";
const autoLinkSetting = (v: AutoLink): boolean | null =>
  v === "auto" ? null : v === "on";

function draftOf(s: PortalProductSettings): PortalDraft {
  return {
    portalEnabled: s.portalEnabled,
    oidcEnabled: s.oidcEnabled,
    magicEnabled: s.magicEnabled,
    licenseKeyClaimEnabled: s.licenseKeyClaimEnabled,
    releasesEnabled: s.releasesEnabled,
    keyReissueEnabled: s.keyReissueEnabled ?? false,
    claimByKey: s.claimByKey ?? false,
    autoLink: autoLinkOf(s.autoLinkEnabled),
  };
}

/**
 * `autoLinkEnabled` is a select, not a switch: it has three states and the third ("auto") tracks
 * the product's OIDC issuer. A switch would have to show "auto" as on or off, and the first touch
 * would freeze it (R5-01/R5-02).
 */
const AUTO_LINK_OPTIONS: {
  value: AutoLink;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "Auto (follow the OIDC issuer)",
    description:
      "On for products on the platform issuer; off for a product on its own ‘custom’ issuer, whose email and subject claims this platform does not vouch for.",
  },
  {
    value: "on",
    label: "Always link",
    description:
      "Link matching licenses on sign-in even when the issuer is tenant-controlled. Only for an issuer you operate.",
  },
  {
    value: "off",
    label: "Never link",
    description:
      "Customers must claim each license explicitly, even on the platform issuer.",
  },
];

const SIGN_IN_ROWS: { key: ToggleKey; label: string }[] = [
  { key: "oidcEnabled", label: "OIDC access" },
  { key: "magicEnabled", label: "Email magic links" },
  { key: "licenseKeyClaimEnabled", label: "License-key claim" },
];

const PORTAL_OFF = "Turn on the customer portal to change this.";

export function PortalPage({ slug }: { slug: string }): React.ReactElement {
  // Identity's own endpoint, not the copy on the product row: `identity/portal` owns the table, so
  // it is the value a save round-trips against.
  const settings = useQuery(
    {
      queryKey: qk.portal(slug),
      queryFn: () => api.portalSettings(slug).then((r) => r.settings),
    },
    queryClient,
  );
  const product = useProduct(slug);

  const header = (
    <PageHeader
      title="Portal"
      titleAside={
        settings.data ? (
          // `modifiedAt` 0: no row was ever written, so these are the defaults.
          settings.data.modifiedAt && settings.data.modifiedAt > 0 ? (
            <StatusPill tone="info" icon={false}>
              Edited <Timestamp at={fromSeconds(settings.data.modifiedAt)} />
            </StatusPill>
          ) : (
            <StatusPill tone="neutral" icon={false}>
              Defaults
            </StatusPill>
          )
        ) : null
      }
      refetching={settings.isFetching && !settings.isPending}
    />
  );

  if (settings.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="portal settings" />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      </div>
    );
  }

  return (
    <PortalForm
      slug={slug}
      header={header}
      settings={settings.data}
      releaseOn={product.data?.services?.release?.enabled}
    />
  );
}

function PortalForm({
  slug,
  header,
  settings,
  releaseOn,
}: {
  slug: string;
  header: React.ReactNode;
  settings: PortalProductSettings;
  /** `undefined` while the product row (enablement) is still loading. */
  releaseOn: boolean | undefined;
}): React.ReactElement {
  const form = useAdminForm<PortalDraft>({
    values: draftOf(settings),
    onSubmit: async (draft) => {
      try {
        // The whole module set, never `branding`: this page only reads branding, and sending it
        // back would let a page that cannot edit it overwrite it.
        await mutate("updatePortalSettings", slug, {
          portalEnabled: draft.portalEnabled,
          oidcEnabled: draft.oidcEnabled,
          magicEnabled: draft.magicEnabled,
          licenseKeyClaimEnabled: draft.licenseKeyClaimEnabled,
          releasesEnabled: draft.releasesEnabled,
          keyReissueEnabled: draft.keyReissueEnabled,
          claimByKey: draft.claimByKey,
          autoLinkEnabled: autoLinkSetting(draft.autoLink),
        });
      } catch (err) {
        toast.error(err);
        throw err;
      }
      toast.success("Portal settings saved");
    },
    // Errors show in the toast; this resource has no per-field errors worth mapping.
    mapServerErrors: () => null,
  });
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard unsaved portal settings?",
    onDiscard: form.discard,
  });

  const values = form.rhf.watch();
  const set = (key: keyof PortalDraft, value: boolean | AutoLink): void =>
    form.rhf.setValue(key, value as never, { shouldDirty: true });
  const portalOn = values.portalEnabled;
  const readOnly = form.isSubmitting;
  const autoLinkHelp = AUTO_LINK_OPTIONS.find(
    (o) => o.value === values.autoLink,
  )!.description;
  const releaseOff = releaseOn === false;

  const toggle = (
    key: ToggleKey,
    label: string,
    help: React.ReactNode,
    disabled: boolean,
  ): React.ReactElement => {
    const id = `portal-${slug}-${key}`;
    return (
      <SettingsRow
        key={key}
        label={label}
        htmlFor={id}
        help={help ? <span id={`${id}-help`}>{help}</span> : undefined}
      >
        <Switch
          id={id}
          checked={Boolean(values[key])}
          disabled={disabled}
          readOnly={readOnly}
          aria-describedby={help ? `${id}-help` : undefined}
          onCheckedChange={(c) => set(key, c)}
        />
      </SettingsRow>
    );
  };

  const autoLinkId = `portal-${slug}-autoLinkEnabled`;

  return (
    // Four short sections: no "On this page" rail.
    <SettingsTemplate header={header} sections={[]}>
      <Form form={form} aria-label="Portal settings" className="space-y-6">
        <SettingsSection id="portal-access" title="Availability">
          {toggle("portalEnabled", "Customer portal", null, false)}
        </SettingsSection>

        <SettingsSection
          id="portal-sign-in"
          title="Sign-in methods"
          description={portalOn ? undefined : PORTAL_OFF}
        >
          {SIGN_IN_ROWS.map((row) =>
            toggle(row.key, row.label, null, !portalOn),
          )}
          <SettingsRow
            label="Automatic license linking"
            htmlFor={autoLinkId}
            help={<span id={`${autoLinkId}-help`}>{autoLinkHelp}</span>}
          >
            <Select
              id={autoLinkId}
              aria-describedby={`${autoLinkId}-help`}
              className="w-full sm:w-80"
              options={AUTO_LINK_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              value={values.autoLink}
              disabled={!portalOn}
              readOnly={readOnly}
              onChange={(v) => v && set("autoLink", v as AutoLink)}
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection
          id="portal-modules"
          title="Modules"
          description={portalOn ? undefined : PORTAL_OFF}
        >
          {toggle(
            "releasesEnabled",
            "Release downloads",
            releaseOff ? (
              <>
                Release is off for this product, so there is nothing to
                download.{" "}
                <Link
                  to={r.services(slug)}
                  className="text-accent-fg underline underline-offset-2"
                >
                  Open Services
                </Link>
              </>
            ) : null,
            !portalOn || releaseOff,
          )}
        </SettingsSection>

        <SettingsSection
          id="portal-keys"
          title="License keys"
          description={portalOn ? undefined : PORTAL_OFF}
        >
          {toggle(
            "keyReissueEnabled",
            "Customers can get a new key",
            "A customer who signed in within the last 5 minutes can replace a license's key. The old key stops activating new devices; devices already activated keep working.",
            !portalOn,
          )}
          {toggle(
            "claimByKey",
            "Add by key without the purchase email",
            "Off: a license that carries an email joins only an account with that email verified. On: anyone holding the key can add it. A license already in an account never moves by its key either way.",
            !portalOn,
          )}
        </SettingsSection>

        <SaveBar
          form={form}
          saveLabel="Save portal settings"
          section="Portal"
        />
      </Form>

      <SettingsSection id="portal-branding" title="Branding">
        <SettingsRow
          label="Current branding"
          align={settings.branding == null ? "end" : "stretch"}
        >
          {settings.branding == null ? (
            <p className="text-fg-muted">
              None. The portal shows the product name in the Polaris Key theme.
            </p>
          ) : (
            <JsonViewer
              value={settings.branding}
              label="Portal branding"
              collapsedDepth={2}
            />
          )}
        </SettingsRow>
      </SettingsSection>
      {guard.dialog}
    </SettingsTemplate>
  );
}
