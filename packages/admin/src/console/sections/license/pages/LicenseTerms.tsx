/**
 * The license's Terms (ADMIN.md §6.5.2 Overview): ONE form for every policy field (tier, expiry,
 * max offline days, channels, versions and profiles), ending the split between the old Edit
 * dialog and Policy tab (LDT-1) and making profiles editable (LDT-3). A cleared value is sent as
 * `null` (A-3, LDT-2). The downgrade warning uses the server's `deviceCount` (LDT-12).
 */

import * as React from "react";
import type { LicenseDetail, PatchLicenseBody } from "../../../../api.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { r } from "../../../routes.js";
import { fromSeconds, toSeconds } from "../../../../lib/format.js";
import { versionRangeError } from "../../../../lib/version.js";
import { Callout } from "../../../../ui/Callout.js";
import { ChannelPicker } from "../../../../ui/ChannelPicker.js";
import { Combobox } from "../../../../ui/Combobox.js";
import { DateInput } from "../../../../ui/DateInput.js";
import {
  diffValues,
  Form,
  FormField,
  useAdminForm,
} from "../../../../ui/form.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { OrderedMultiSelect } from "../../../../ui/OrderedMultiSelect.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { toast } from "../../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import { VersionInput } from "../../../../ui/VersionInput.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { InlineFailure } from "../components/CreateLicenseDialog.js";
import {
  EffectivePolicy,
  MAX_OFFLINE_DAYS,
  MIN_OFFLINE_DAYS,
  effectivePolicy,
  resolvedDeviceLimit,
  tierSummary,
  useManualChannels,
  useProfiles,
  useTiers,
} from "../components/shared.js";

export interface TermsValues {
  [key: string]: unknown;
  tier: string | null;
  /** Epoch ms (the end of the chosen local day), or `null` for no expiry. */
  expiresAt: number | null;
  maxOfflineDays: number | null;
  channels: string[];
  minVersion: string;
  maxVersion: string;
  profiles: string[];
}

export function termsOf(l: LicenseDetail): TermsValues {
  return {
    tier: l.tier,
    expiresAt: l.expiresAt == null ? null : fromSeconds(l.expiresAt),
    maxOfflineDays: l.maxOfflineDays ?? null,
    channels: l.channels,
    minVersion: l.minVersion ?? "",
    maxVersion: l.maxVersion ?? "",
    profiles: l.profiles ?? (l.profile ? [l.profile] : []),
  };
}

export function validateTerms(v: TermsValues): Record<string, string> {
  const e: Record<string, string> = {};
  if (
    v.maxOfflineDays !== null &&
    (!Number.isInteger(v.maxOfflineDays) ||
      v.maxOfflineDays < MIN_OFFLINE_DAYS ||
      v.maxOfflineDays > MAX_OFFLINE_DAYS)
  )
    e.maxOfflineDays = `Use a whole number of days from ${MIN_OFFLINE_DAYS} to ${MAX_OFFLINE_DAYS}, or leave it blank.`;
  const range = versionRangeError(v.minVersion, v.maxVersion);
  if (range)
    e[range.field === "min" ? "minVersion" : "maxVersion"] = range.message;
  return e;
}

/** The PATCH body: the changed fields only, a cleared nullable field as `null`. */
export function termsPatch(
  server: TermsValues,
  draft: TermsValues,
): PatchLicenseBody {
  const d = diffValues(server, draft, {
    nullable: [
      "tier",
      "expiresAt",
      "maxOfflineDays",
      "minVersion",
      "maxVersion",
    ],
  });
  const body: PatchLicenseBody = {};
  if ("tier" in d) body.tier = (d.tier as string | null) ?? null;
  if ("expiresAt" in d)
    body.expiresAt =
      d.expiresAt == null ? null : toSeconds(d.expiresAt as number);
  if ("maxOfflineDays" in d)
    body.maxOfflineDays = (d.maxOfflineDays as number | null) ?? null;
  if ("channels" in d) body.channels = d.channels as string[];
  if ("minVersion" in d)
    body.minVersion = ((d.minVersion as string | null) ?? "").trim() || null;
  if ("maxVersion" in d)
    body.maxVersion = ((d.maxVersion as string | null) ?? "").trim() || null;
  if ("profiles" in d) body.profiles = d.profiles as string[];
  return body;
}

export function LicenseTerms({
  slug,
  license,
  onDirtyChange,
}: {
  slug: string;
  license: LicenseDetail;
  onDirtyChange?: (dirty: boolean) => void;
}): React.ReactElement {
  const tiersQ = useTiers(slug);
  const profilesQ = useProfiles(slug);
  const manual = useManualChannels(slug);
  const product = useProduct(slug).data;
  const tiers = React.useMemo(() => tiersQ.data?.tiers ?? [], [tiersQ.data]);
  const profiles = profilesQ.data?.profiles ?? [];
  const values = React.useMemo(() => termsOf(license), [license]);

  const form = useAdminForm<TermsValues>({
    values,
    validate: validateTerms,
    mapServerErrors: (err) => {
      const fields = (err as { fields?: string[] })?.fields;
      if (!fields?.length) return null;
      const out: Record<string, string> = {};
      for (const f of fields) {
        const name = f.startsWith("profiles") ? "profiles" : f;
        out[name] =
          name === "profiles"
            ? "A profile no longer exists."
            : "Check this value.";
      }
      return out;
    },
    onSubmit: async (draft, { server }) => {
      const body = termsPatch(server, draft);
      if (Object.keys(body).length === 0) return;
      const res = await mutate("patchLicense", slug, license.id, body);
      if (res.overLimit) {
        toast.warning("Terms saved: over the device limit", {
          description: `${res.overLimit.deviceCount} devices are authorized and the new limit is ${res.overLimit.deviceLimit}. They keep working; new devices can't activate until the count drops.`,
        });
      } else {
        toast.success("Terms saved");
      }
    },
  });

  React.useEffect(() => {
    onDirtyChange?.(form.isDirty);
  }, [form.isDirty, onDirtyChange]);

  // A tab of this record keeps the draft (its panel stays mounted); anything else asks first.
  const recordPrefix = r.license(slug, license.id);
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard unsaved changes to these terms?",
    consequences: [
      "Your changes to the terms are lost. Nothing has been saved.",
    ],
    onDiscard: form.discard,
    allow: (hash) => {
      const path = hash.split("?")[0]!;
      return path === recordPrefix || path.startsWith(`${recordPrefix}/`);
    },
  });

  const draft = form.rhf.watch();
  const tierChanged = (draft.tier ?? null) !== (license.tier ?? null);
  const expiryTouched = form.dirtyFields.includes("expiresAt");
  const nextTier = draft.tier
    ? tiers.find((t) => t.id === draft.tier)
    : undefined;
  // LX-14a: a limit set on this license beats any tier, so a tier change cannot move it.
  const entitlementDeviceLimit =
    license.inheritedDeviceLimitSource === "entitlement"
      ? (license.inheritedDeviceLimit ?? null)
      : null;
  const nextLimit = resolvedDeviceLimit(
    {
      tier: draft.tier ?? null,
      deviceLimit: license.deviceLimit ?? null,
      entitlementDeviceLimit,
      maxOfflineDays: null,
      channels: [],
      minVersion: null,
      maxVersion: null,
    },
    tiers,
    product,
  );
  const overLimit =
    tierChanged &&
    license.deviceLimit == null &&
    nextLimit !== null &&
    license.deviceCount > nextLimit;

  const policy = effectivePolicy(
    {
      tier: draft.tier ?? null,
      deviceLimit: license.deviceLimit ?? null,
      entitlementDeviceLimit,
      maxOfflineDays: draft.maxOfflineDays ?? null,
      channels: draft.channels ?? [],
      minVersion: (draft.minVersion ?? "").trim() || null,
      maxVersion: (draft.maxVersion ?? "").trim() || null,
    },
    tiers,
    product,
  );
  const currentTier = license.tier
    ? tiers.find((t) => t.id === license.tier)
    : undefined;

  return (
    <Form form={form} aria-label="Terms">
      <SettingsSection
        id="license-terms"
        title="Terms"
        description={
          currentTier
            ? `From tier “${currentTier.label || currentTier.id}”, plus what this license sets itself.`
            : "A blank field uses the tier's or the product's default."
        }
      >
        <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
          <FormField
            name="tier"
            label="Tier"
            help="Changing the tier re-licenses running clients at their next license refresh."
          >
            {(f) =>
              tiersQ.error ? (
                <InlineFailure
                  what="tiers"
                  error={tiersQ.error}
                  onRetry={() => void tiersQ.refetch()}
                />
              ) : (
                <Combobox
                  {...f}
                  clearable
                  placeholder="No tier"
                  searchPlaceholder="Search tiers"
                  emptyText="No tiers match."
                  options={tiers.map((t) => ({
                    value: t.id,
                    label: t.label || t.id,
                    secondary: tierSummary(t),
                    searchText: `${t.label} ${t.id}`,
                  }))}
                />
              )
            }
          </FormField>

          <FormField
            name="expiresAt"
            label="Expires"
            help={
              tierChanged && !expiryTouched
                ? nextTier?.policyExpiryDays != null
                  ? `Saving resets the expiry to the new tier's term: ${nextTier.policyExpiryDays} days from today. Set a date to keep your own.`
                  : "Saving clears the expiry: the new tier has no term. Set a date to keep one."
                : "Blank: the license never expires."
            }
          >
            {(f) => <DateInput {...f} resolvedLabel="Ends" />}
          </FormField>

          <FormField
            name="maxOfflineDays"
            label="Max offline days"
            help={`Blank uses the product default (${product?.defaultMaxOfflineDays ?? "—"} days).`}
          >
            {(f) => (
              <NumberInput
                {...f}
                nullable
                integer
                min={MIN_OFFLINE_DAYS}
                max={MAX_OFFLINE_DAYS}
                unit="days"
                className="sm:max-w-48"
              />
            )}
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="minVersion" label="Minimum version">
              {(f) => <VersionInput {...f} placeholder="None" />}
            </FormField>
            <FormField name="maxVersion" label="Maximum version">
              {(f) => <VersionInput {...f} placeholder="None" />}
            </FormField>
          </div>

          <FormField
            name="channels"
            label="Release channels"
            help="Added to the tier's channels."
            group
          >
            {(f) => (
              <ChannelPicker {...f} manual={manual} held={values.channels} />
            )}
          </FormField>

          <FormField name="profiles" label="Profiles" group>
            {(f) =>
              profilesQ.error ? (
                <InlineFailure
                  what="profiles"
                  error={profilesQ.error}
                  onRetry={() => void profilesQ.refetch()}
                />
              ) : (
                <OrderedMultiSelect
                  {...f}
                  addLabel="Add profile"
                  emptyText={
                    profiles.length === 0 && !profilesQ.isPending
                      ? "This product has no profiles."
                      : "No profiles: the tier's profile and catalog defaults apply."
                  }
                  orderHint="Applied in this order, after the tier's profile: a later profile overrides an earlier one."
                  options={[
                    ...profiles.map((p) => ({
                      value: p.id,
                      label: p.name || p.id,
                      secondary: p.id,
                      searchText: `${p.name} ${p.id}`,
                    })),
                    // A held profile the list no longer has stays visible (and removable).
                    ...values.profiles
                      .filter((id) => !profiles.some((p) => p.id === id))
                      .map((id) => ({
                        value: id,
                        label: id,
                        secondary: "not found",
                      })),
                  ]}
                />
              )
            }
          </FormField>
        </div>
        {overLimit ? (
          <div className="px-5 py-4">
            <Callout tone="warning" title={`Over the new device limit`}>
              {nextTier?.policyDeviceLimit != null
                ? `Tier “${nextTier.label || nextTier.id}”`
                : entitlementDeviceLimit !== null
                  ? "An entitlement"
                  : "The product default"}{" "}
              allows {nextLimit} {nextLimit === 1 ? "device" : "devices"} and
              this license has {license.deviceCount}. Existing devices are
              grandfathered and keep working; no new device can activate until
              the count drops under the limit.
            </Callout>
          </div>
        ) : null}
        <div className="px-5 py-4">
          <EffectivePolicy
            title="Effective policy"
            description="Includes your unsaved changes."
            lines={policy}
          />
        </div>
      </SettingsSection>
      <SaveBar form={form} saveLabel="Save terms" section="Terms" />
      {guard.dialog}
    </Form>
  );
}
