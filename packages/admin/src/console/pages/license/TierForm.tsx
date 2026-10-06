/**
 * The tier fields, shared by the create drawer and the tier record's Overview form (ADMIN.md
 * §6.5.3): one pane, not three tabs (TIR-8). Numbers are nullable (blank = the product default,
 * sent as `null` on a patch: A-3, TIR-1), checked on the client with min ≤ max (TIR-3); "No
 * profile" is `null`, never `""` (TIR-4); the one-profile-per-tier rule is said (TIR-7).
 * Creating, the fields mark the surrounding drawer as unsaved once typed in, so Escape, Close and
 * Back ask before the draft goes (FLOWS.md C-29).
 */

import * as React from "react";
import type { TierBody, TierSummary } from "../../../api.js";
import { useProduct } from "../../data/hooks.js";
import { versionRangeError } from "../../../lib/version.js";
import { ChannelPicker } from "../../../ui/ChannelPicker.js";
import { useDismissGuard } from "../../../ui/Dialog.js";
import { diffValues, FormField, useFormContext } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { Select } from "../../../ui/Select.js";
import { VersionInput } from "../../../ui/VersionInput.js";
import { InlineFailure } from "./CreateLicenseDialog.js";
import { useManualChannels, useProfiles } from "./shared.js";

/** The manifest's tier id rule. */
export const TIER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface TierValues {
  [key: string]: unknown;
  id: string;
  label: string;
  profile: string | null;
  policyExpiryDays: number | null;
  policyDeviceLimit: number | null;
  channels: string[];
  minVersion: string;
  maxVersion: string;
}

export const EMPTY_TIER: TierValues = {
  id: "",
  label: "",
  profile: null,
  policyExpiryDays: null,
  policyDeviceLimit: null,
  channels: [],
  minVersion: "",
  maxVersion: "",
};

export function tierValues(t: TierSummary): TierValues {
  return {
    id: t.id,
    label: t.label,
    profile: t.profile,
    policyExpiryDays: t.policyExpiryDays,
    policyDeviceLimit: t.policyDeviceLimit,
    channels: t.channels,
    minVersion: t.minVersion ?? "",
    maxVersion: t.maxVersion ?? "",
  };
}

const positiveInt = (v: number | null): boolean =>
  v === null || (Number.isInteger(v) && v > 0);

export function validateTier(
  v: TierValues,
  opts: { existingIds?: readonly string[]; creating?: boolean } = {},
): Record<string, string> {
  const e: Record<string, string> = {};
  if (opts.creating) {
    const id = v.id.trim();
    if (!id) e.id = "Enter an id.";
    else if (!TIER_ID_RE.test(id))
      e.id =
        "Use lowercase letters, digits, “-” and “_”, starting with a letter or digit.";
    else if (opts.existingIds?.includes(id))
      e.id = "A tier with this id already exists.";
  }
  if (!positiveInt(v.policyExpiryDays))
    e.policyExpiryDays =
      "Use a whole number of days, 1 or more, or leave it blank.";
  if (!positiveInt(v.policyDeviceLimit))
    e.policyDeviceLimit =
      "Use a whole number of devices, 1 or more, or leave it blank for the product default.";
  const range = versionRangeError(v.minVersion, v.maxVersion);
  if (range)
    e[range.field === "min" ? "minVersion" : "maxVersion"] = range.message;
  return e;
}

/** The create body: blank fields omitted, so the product defaults apply. */
export function tierCreateBody(v: TierValues): TierBody {
  const body: TierBody = {
    id: v.id.trim(),
    label: v.label.trim() || v.id.trim(),
    channels: v.channels,
  };
  if (v.profile) body.profile = v.profile;
  if (v.policyExpiryDays !== null) body.policyExpiryDays = v.policyExpiryDays;
  if (v.policyDeviceLimit !== null)
    body.policyDeviceLimit = v.policyDeviceLimit;
  if (v.minVersion.trim()) body.minVersion = v.minVersion.trim();
  if (v.maxVersion.trim()) body.maxVersion = v.maxVersion.trim();
  return body;
}

/** The patch body: changed fields only; a cleared nullable field is `null` (TIR-1, TIR-4). */
export function tierPatchBody(server: TierValues, draft: TierValues): TierBody {
  const d = diffValues(server, draft, {
    nullable: [
      "profile",
      "policyExpiryDays",
      "policyDeviceLimit",
      "minVersion",
      "maxVersion",
    ],
  });
  const body: TierBody = {};
  if ("label" in d) body.label = String(d.label ?? "").trim();
  if ("profile" in d) body.profile = (d.profile as string | null) ?? null;
  if ("policyExpiryDays" in d)
    body.policyExpiryDays = (d.policyExpiryDays as number | null) ?? null;
  if ("policyDeviceLimit" in d)
    body.policyDeviceLimit = (d.policyDeviceLimit as number | null) ?? null;
  if ("channels" in d) body.channels = d.channels as string[];
  if ("minVersion" in d)
    body.minVersion = String(d.minVersion ?? "").trim() || null;
  if ("maxVersion" in d)
    body.maxVersion = String(d.maxVersion ?? "").trim() || null;
  return body;
}

/** The fields, inside a `Form` (the record) or controlled by a parent's `useAdminForm`. */
export function TierFields({
  slug,
  creating = false,
  heldChannels,
}: {
  slug: string;
  creating?: boolean;
  heldChannels?: readonly string[];
}): React.ReactElement {
  const profilesQ = useProfiles(slug);
  const manual = useManualChannels(slug);
  const product = useProduct(slug).data;
  const profiles = profilesQ.data?.profiles ?? [];
  const form = useFormContext<TierValues>();
  useDismissGuard(creating && !!form?.isDirty && !form.isSubmitting);
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {creating ? (
        <FormField
          name="id"
          label="Id"
          required
          help="The id licenses and the manifest refer to. It can't be changed later."
        >
          {(f) => <Input {...f} mono autoFocus placeholder="e.g. pro" />}
        </FormField>
      ) : null}
      <FormField name="label" label="Label">
        {(f) => <Input {...f} placeholder="e.g. Pro" />}
      </FormField>
      <FormField
        name="profile"
        label="Profile"
        help="A tier has one profile. A license can add more on top of it, in order."
        className="sm:col-span-2"
      >
        {(f) =>
          profilesQ.error ? (
            <InlineFailure
              what="profiles"
              error={profilesQ.error}
              onRetry={() => void profilesQ.refetch()}
            />
          ) : (
            <Select
              {...f}
              allowEmpty
              emptyLabel="No profile"
              placeholder={profilesQ.isPending ? "Loading…" : "No profile"}
              options={profiles.map((p) => ({
                value: p.id,
                label: p.name || p.id,
                description: p.id,
              }))}
            />
          )
        }
      </FormField>
      <FormField
        name="policyExpiryDays"
        label="Term"
        help="How long a license on this tier lasts from when it's issued. Blank: no expiry."
      >
        {(f) => <NumberInput {...f} nullable integer min={1} unit="days" />}
      </FormField>
      <FormField
        name="policyDeviceLimit"
        label="Device limit"
        help={`Devices per license. Blank uses the product default (${
          product?.defaultDeviceLimit && product.defaultDeviceLimit > 0
            ? product.defaultDeviceLimit
            : "unlimited"
        }).`}
      >
        {(f) => <NumberInput {...f} nullable integer min={1} unit="devices" />}
      </FormField>
      <FormField name="minVersion" label="Minimum version">
        {(f) => <VersionInput {...f} placeholder="None" />}
      </FormField>
      <FormField name="maxVersion" label="Maximum version">
        {(f) => <VersionInput {...f} placeholder="None" />}
      </FormField>
      <FormField
        name="channels"
        label="Release channels"
        help="Every license on this tier gets these, plus its own."
        group
        className="sm:col-span-2"
      >
        {(f) => <ChannelPicker {...f} manual={manual} held={heldChannels} />}
      </FormField>
    </div>
  );
}
