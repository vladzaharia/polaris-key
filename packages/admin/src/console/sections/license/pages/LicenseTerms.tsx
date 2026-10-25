/**
 * The license's own terms as one value set (tier, expiry, max offline days, channels, versions and
 * profiles) with the PATCH diff the record's dialogs share: Limits' override dialog, Duration's
 * Change and Profiles (LDT-1 to LDT-3). A cleared value is sent as `null` (A-3, LDT-2).
 */

import * as React from "react";
import type { LicenseDetail, PatchLicenseBody } from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ErrorDescription } from "../../../../ui/CopyDetails.js";
import { fromSeconds, toSeconds } from "../../../../lib/format.js";
import { versionRangeError } from "../../../../lib/version.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { DateInput } from "../../../../ui/DateInput.js";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  useDismissGuard,
} from "../../../../ui/Dialog.js";
import {
  diffValues,
  Form,
  FormField,
  useAdminForm,
} from "../../../../ui/form.js";
import { OrderedMultiSelect } from "../../../../ui/OrderedMultiSelect.js";
import { toast } from "../../../../ui/toast.js";
import { InlineFailure } from "../components/InlineFailure.js";
import { MAX_OFFLINE_DAYS, MIN_OFFLINE_DAYS } from "../components/shared.js";
import { useProfiles } from "../../config/data.js";

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

/** The date dialog behind Duration's **Change**: the expiry, or none. */
export function ExpiryDialog({
  slug,
  license,
  open,
  onOpenChange,
}: {
  slug: string;
  license: LicenseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change duration"
      description="When this license ends. Devices pick it up at their next license refresh."
    >
      {open ? (
        <ExpiryForm
          slug={slug}
          license={license}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function ExpiryForm({
  slug,
  license,
  onDone,
}: {
  slug: string;
  license: LicenseDetail;
  onDone: () => void;
}): React.ReactElement {
  const values = React.useMemo(() => termsOf(license), [license]);
  const form = useAdminForm<TermsValues>({
    values,
    onSubmit: async (draft, { server }) => {
      const body = termsPatch(server, draft);
      if (Object.keys(body).length) {
        await mutate("patchLicense", slug, license.id, body);
        toast.success("Duration saved");
      }
      onDone();
    },
  });
  useDismissGuard(form.isDirty && !form.isSubmitting);
  return (
    <Form form={form} aria-label="Duration" className="contents">
      <DialogBody className="space-y-4">
        <FormField
          name="expiresAt"
          label="Ends"
          help="Blank: the license never ends."
        >
          {(f) => <DateInput {...f} resolvedLabel="Ends" />}
        </FormField>
        {form.submitError && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="The duration wasn't saved" live>
            <ErrorDescription
              copy={errorCopy(form.submitError, { thing: "License" })}
            />
          </Callout>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={form.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.isSubmitting}>
          Save
        </Button>
      </DialogFooter>
    </Form>
  );
}

/** The ordered profile list (LDT-3): applied in order after the tier's profile. */
export function ProfilesDialog({
  slug,
  license,
  open,
  onOpenChange,
}: {
  slug: string;
  license: LicenseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Profiles"
      description="Applied in this order, after the tier's profile: a later profile overrides an earlier one."
    >
      {open ? (
        <ProfilesForm
          slug={slug}
          license={license}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function ProfilesForm({
  slug,
  license,
  onDone,
}: {
  slug: string;
  license: LicenseDetail;
  onDone: () => void;
}): React.ReactElement {
  const profilesQ = useProfiles(slug);
  const profiles = profilesQ.data?.profiles ?? [];
  const values = React.useMemo(() => termsOf(license), [license]);
  const form = useAdminForm<TermsValues>({
    values,
    mapServerErrors: (err) =>
      (err as { fields?: string[] })?.fields?.length
        ? { profiles: "A profile no longer exists." }
        : null,
    onSubmit: async (draft, { server }) => {
      const body = termsPatch(server, draft);
      if (Object.keys(body).length) {
        await mutate("patchLicense", slug, license.id, body);
        toast.success("Profiles saved");
      }
      onDone();
    },
  });
  useDismissGuard(form.isDirty && !form.isSubmitting);
  return (
    <Form form={form} aria-label="Profiles" className="contents">
      <DialogBody className="space-y-4">
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
        {form.submitError && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="The profiles weren't saved" live>
            <ErrorDescription
              copy={errorCopy(form.submitError, { thing: "License" })}
            />
          </Callout>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={form.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.isSubmitting}>
          Save
        </Button>
      </DialogFooter>
    </Form>
  );
}
