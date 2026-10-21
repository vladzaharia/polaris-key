/**
 * Settings → Polaris Locker (ST-14; notes/S-18 §4.10; products.features).
 *
 * The hub's Customer portal area: the three switches the Locker reads (`portal.enabled`,
 * `portal.keyReissue`, `identity.keyEntry.claimByKey`) and the branding it shows. It is a Core
 * page, so it is there whether or not Identity is on: the Locker lists a product's licenses
 * either way, and the switches apply either way.
 *
 * One form, one `SaveBar`. A save sends only what changed to `PATCH …/identity/portal`, the one
 * route that writes the three settings rows and the branding blob. A branding field the Worker
 * refuses is named on the field; the draft survives.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type PortalProductSettings } from "../../../../api.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import {
  Form,
  FormField,
  diffValues,
  useAdminForm,
  type FieldErrorMap,
} from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { ClaimByKeyWarning } from "../../identity/components/ClaimByKeyWarning.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";

/** The branding fields the Locker reads, in editor order (Worker: `portal/branding.ts`). */
export const BRANDING_FIELDS = [
  "developerName",
  "tintColor",
  "tintColorDark",
  "website",
  "supportUrl",
  "supportEmail",
] as const;
export type BrandingField = (typeof BRANDING_FIELDS)[number];

export type PortalDraft = {
  portalEnabled: boolean;
  keyReissueEnabled: boolean;
  claimByKey: boolean;
  developerName: string;
  tintColor: string;
  tintColorDark: string;
  website: string;
  supportUrl: string;
  supportEmail: string;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const HTTPS = /^https:\/\/\S+$/;

/** What the server holds, as the form's values. */
export function draftOf(s: PortalProductSettings): PortalDraft {
  const b =
    s.branding && typeof s.branding === "object"
      ? (s.branding as Record<string, unknown>)
      : {};
  const str = (k: BrandingField): string =>
    typeof b[k] === "string" ? (b[k] as string) : "";
  return {
    portalEnabled: s.portalEnabled,
    keyReissueEnabled: s.keyReissueEnabled ?? false,
    claimByKey: s.claimByKey ?? false,
    developerName: str("developerName"),
    tintColor: str("tintColor"),
    tintColorDark: str("tintColorDark"),
    website: str("website"),
    supportUrl: str("supportUrl"),
    supportEmail: str("supportEmail"),
  };
}

/** The same rules as the Worker, so a bad value is named before the save. */
export function validatePortal(d: PortalDraft): FieldErrorMap {
  const errors: FieldErrorMap = {};
  const v = (k: BrandingField): string => d[k].trim();
  if (v("developerName").length > 60)
    errors.developerName = "Use 60 characters or fewer.";
  for (const k of ["tintColor", "tintColorDark"] as const)
    if (v(k) !== "" && !HEX.test(v(k)))
      errors[k] = "Use a six-digit color such as #3a7bd5.";
  for (const k of ["website", "supportUrl"] as const)
    if (v(k) !== "" && !HTTPS.test(v(k)))
      errors[k] = "Use an https:// address.";
  if (v("supportEmail") !== "" && !/^\S+@\S+\.\S+$/.test(v("supportEmail")))
    errors.supportEmail = "Use an email address.";
  return errors;
}

/** The PATCH body for what changed: the toggles that moved, and the whole branding if any field did. */
export function patchOf(
  server: PortalDraft,
  draft: PortalDraft,
): Record<string, unknown> {
  const changed = diffValues(server, draft) as Partial<PortalDraft>;
  const body: Record<string, unknown> = {};
  for (const k of ["portalEnabled", "keyReissueEnabled", "claimByKey"] as const)
    if (changed[k] !== undefined) body[k] = changed[k];
  if (BRANDING_FIELDS.some((k) => changed[k] !== undefined))
    body.branding = Object.fromEntries(
      BRANDING_FIELDS.map((k) => [k, draft[k].trim()]).filter(
        ([, v]) => v !== "",
      ),
    );
  return body;
}

const toggleRows = (name: string) =>
  [
    {
      key: "portalEnabled",
      id: "portal.enabled",
      label: `Show ${name} in Polaris Locker`,
      help: "Turn off to hide this product's licenses, page and downloads in every library. Licenses and sign-in keep working.",
    },
    {
      key: "keyReissueEnabled",
      id: "portal.keyReissue",
      label: "Let customers replace a lost key",
      help: "Polaris Locker issues a new key. The old key stops working at once.",
    },
    {
      key: "claimByKey",
      id: "identity.keyEntry.claimByKey",
      label: "A key adds its license to whoever enters it",
      help: "Off: only to the account with the buyer’s email.",
    },
  ] as const;

export function PortalPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  const query = useQuery({
    queryKey: qk.portal(slug),
    queryFn: () => api.portalSettings(slug).then((r) => r.settings),
  });
  useLoadingAnnouncement("Polaris Locker", query.isPending);
  if (query.isPending)
    return <PageSkeleton template="form" label="Polaris Locker" />;
  if (query.isError || !query.data)
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  return (
    <PortalForm
      slug={slug}
      name={product.data?.name ?? slug}
      settings={query.data}
    />
  );
}

function PortalForm({
  slug,
  name,
  settings,
}: {
  slug: string;
  name: string;
  settings: PortalProductSettings;
}): React.ReactElement {
  const gate = useWriteGate("core", slug);
  const values = React.useMemo(() => draftOf(settings), [settings]);
  const form = useAdminForm<PortalDraft>({
    values,
    resetOn: [settings.modifiedAt],
    validate: validatePortal,
    onSubmit: async (draft, { server }) => {
      const body = patchOf(server, draft);
      try {
        await mutate("updatePortalSettings", slug, body);
      } catch (err) {
        toast.error(err);
        throw err;
      }
      toast.success("Saved Polaris Locker settings");
    },
    // The Worker names `branding.<field>`; the form's field is `<field>`.
    mapServerErrors: (e) =>
      e instanceof ApiError && e.fields?.length
        ? Object.fromEntries(
            e.fields.map((f) => [
              f.replace(/^branding\./, ""),
              "Check this value.",
            ]),
          )
        : null,
  });
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard unsaved Polaris Locker changes?",
    onDiscard: form.discard,
  });
  const draft = form.rhf.watch();
  const readOnly = !gate.allowed || form.isSubmitting;
  const tint = HEX.test(draft.tintColor.trim()) ? draft.tintColor.trim() : null;
  const tintDark = HEX.test(draft.tintColorDark.trim())
    ? draft.tintColorDark.trim()
    : null;

  return (
    <div className="space-y-6" data-template="portal">
      <Form
        form={form}
        aria-label="Polaris Locker settings"
        className="space-y-6"
      >
        <SettingsSection
          id="portal-switches"
          title="Polaris Locker"
          description="Where customers see their licenses and devices. These apply whether or not sign-in is on."
        >
          {toggleRows(name).map((row) => (
            <SettingsRow
              key={row.key}
              id={`setting-${row.id}`}
              label={row.label}
              htmlFor={`portal-${row.key}`}
              help={row.help}
              footer={
                row.key === "claimByKey" && draft.claimByKey ? (
                  <ClaimByKeyWarning />
                ) : undefined
              }
            >
              <FormField name={row.key} label={row.label} hideLabel>
                {(f) => (
                  <Switch
                    id={`portal-${row.key}`}
                    checked={f.value as boolean}
                    disabled={readOnly}
                    onCheckedChange={(c) => f.onChange(c)}
                    aria-describedby={f["aria-describedby"]}
                  />
                )}
              </FormField>
            </SettingsRow>
          ))}
        </SettingsSection>

        <SettingsSection
          id="portal-branding"
          title="Branding"
          description="What Polaris Locker shows beside this product. Leave a field empty to show nothing for it."
        >
          <SettingsRow
            label="Developer name"
            htmlFor="portal-developerName"
            help="Shown under the product name."
            align="stretch"
          >
            <FormField name="developerName" label="Developer name" hideLabel>
              {(f) => (
                <Input
                  {...f}
                  id="portal-developerName"
                  autoComplete="off"
                  disabled={readOnly}
                />
              )}
            </FormField>
          </SettingsRow>
          <SettingsRow
            label="Accent color"
            htmlFor="portal-tintColor"
            help="A six-digit color for light mode."
            align="stretch"
          >
            <FormField name="tintColor" label="Accent color" hideLabel>
              {(f) => (
                <div className="flex items-center gap-3">
                  <Input
                    {...f}
                    id="portal-tintColor"
                    mono
                    placeholder="#3a7bd5"
                    autoComplete="off"
                    disabled={readOnly}
                  />
                  <Swatch color={tint} />
                </div>
              )}
            </FormField>
          </SettingsRow>
          <SettingsRow
            label="Accent color, dark mode"
            htmlFor="portal-tintColorDark"
            help="A six-digit color for dark mode. Empty uses the light one."
            align="stretch"
          >
            <FormField
              name="tintColorDark"
              label="Accent color, dark mode"
              hideLabel
            >
              {(f) => (
                <div className="flex items-center gap-3">
                  <Input
                    {...f}
                    id="portal-tintColorDark"
                    mono
                    placeholder="#8fb4ff"
                    autoComplete="off"
                    disabled={readOnly}
                  />
                  <Swatch color={tintDark} />
                </div>
              )}
            </FormField>
          </SettingsRow>
          <SettingsRow label="Website" htmlFor="portal-website" align="stretch">
            <FormField name="website" label="Website" hideLabel>
              {(f) => (
                <Input
                  {...f}
                  id="portal-website"
                  type="url"
                  placeholder="https://"
                  autoComplete="off"
                  disabled={readOnly}
                />
              )}
            </FormField>
          </SettingsRow>
          <SettingsRow
            label="Support page"
            htmlFor="portal-supportUrl"
            align="stretch"
          >
            <FormField name="supportUrl" label="Support page" hideLabel>
              {(f) => (
                <Input
                  {...f}
                  id="portal-supportUrl"
                  type="url"
                  placeholder="https://"
                  autoComplete="off"
                  disabled={readOnly}
                />
              )}
            </FormField>
          </SettingsRow>
          <SettingsRow
            label="Support email"
            htmlFor="portal-supportEmail"
            align="stretch"
          >
            <FormField name="supportEmail" label="Support email" hideLabel>
              {(f) => (
                <Input
                  {...f}
                  id="portal-supportEmail"
                  type="email"
                  autoComplete="off"
                  disabled={readOnly}
                />
              )}
            </FormField>
          </SettingsRow>
        </SettingsSection>
        <SaveBar
          form={form}
          saveLabel="Save changes"
          section="Polaris Locker"
        />
      </Form>
      {guard.dialog}
    </div>
  );
}

/** A small color chip next to a color field; nothing while the value is not a color. */
function Swatch({
  color,
}: {
  color: string | null;
}): React.ReactElement | null {
  if (!color) return null;
  return (
    <span
      role="img"
      aria-label={`Preview of ${color}`}
      className="inline-block size-5 rounded-full border border-border-strong"
      style={{ backgroundColor: color }}
    />
  );
}
