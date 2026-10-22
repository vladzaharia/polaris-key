/**
 * The license record's **Change tier** dialog (licenses.change-tier; LX-33). Pick the tier to move
 * to and it lists each limit that changes, old → new, computed from the tier list and the
 * license's own values with the Worker's one resolver (`termsOnTier`); what a license sets itself
 * stays, and is named under the list. Saving sends `tier` alone, so the expiry follows the new
 * tier's term and running clients are re-licensed at their next refresh.
 *
 * The access-rule warning ("her next sign-in moves it back") waits for LX-38 (CONSOLE-UX D1).
 */

import * as React from "react";
import { Check, Clock } from "lucide-react";
import type {
  LicenseDetail,
  ProductDetail,
  TierSummary,
} from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ErrorDescription } from "../../../../ui/CopyDetails.js";
import { formatDate, fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Combobox } from "../../../../ui/Combobox.js";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  useDismissGuard,
} from "../../../../ui/Dialog.js";
import { Form, FormField, useAdminForm } from "../../../../ui/form.js";
import { toast } from "../../../../ui/toast.js";
import { licenseTitle } from "./holders.js";
import { termsOnTier, tierSummary } from "./shared.js";

const DAY_MS = 86_400_000;

export interface TierChange {
  key: "devices" | "tracks" | "versions" | "duration";
  label: string;
  from: string;
  to: string;
  /** Under the new value: "She has 3, so none is signed out". */
  note?: string;
}

export interface TierDiff {
  changes: TierChange[];
  /** What stays, in words: "offline days 14". */
  unchanged: string[];
}

function versions(min: string | null, max: string | null): string {
  if (!min && !max) return "Any";
  return [min ? `≥ ${min}` : null, max ? `≤ ${max}` : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What moving `license` to `toTier` changes: the limits the resolver gives on each tier, and the
 * duration (a tier change restarts the expiry from the new tier's term, as the old Terms form
 * said). Pure, so it is tested without the dialog.
 */
export function tierDiff(
  license: LicenseDetail,
  toTier: string | null,
  tiers: readonly TierSummary[],
  product: Pick<
    ProductDetail,
    "defaultDeviceLimit" | "defaultMaxOfflineDays"
  > | null,
  nowMs: number,
): TierDiff {
  const p = product ?? undefined;
  const before = termsOnTier(license, license.tier ?? null, tiers, p);
  const after = termsOnTier(license, toTier, tiers, p);
  const next = toTier ? tiers.find((t) => t.id === toTier) : undefined;
  const changes: TierChange[] = [];
  const unchanged: string[] = [];

  const dev = (n: number) => (n > 0 ? String(n) : "Unlimited");
  if (before.deviceLimit.value !== after.deviceLimit.value) {
    const limit = after.deviceLimit.value;
    const count = license.seatDeviceCount ?? license.deviceCount;
    changes.push({
      key: "devices",
      label: "Devices",
      from: dev(before.deviceLimit.value),
      to: dev(limit),
      ...(limit > 0 && count > limit
        ? {
            note: `${count} ${count === 1 ? "device is" : "devices are"} signed in; none is signed out, but no new one can activate until the count is under ${limit}`,
          }
        : limit > 0 && count === limit
          ? { note: `${count} signed in, so none is signed out` }
          : {}),
    });
  } else unchanged.push(`devices ${dev(after.deviceLimit.value)}`);

  const tracks = (v: readonly string[]) => (v.length ? v.join(", ") : "stable");
  if (tracks(before.channels.value) !== tracks(after.channels.value))
    changes.push({
      key: "tracks",
      label: "Release tracks",
      from: tracks(before.channels.value),
      to: tracks(after.channels.value),
    });
  const v0 = versions(before.minVersion.value, before.maxVersion.value);
  const v1 = versions(after.minVersion.value, after.maxVersion.value);
  if (v0 !== v1)
    changes.push({ key: "versions", label: "Versions", from: v0, to: v1 });

  const ends = (ms: number | null) =>
    ms === null ? "Lifetime" : `Ends ${formatDate(ms)}`;
  const was = license.expiresAt == null ? null : fromSeconds(license.expiresAt);
  const will =
    next?.policyExpiryDays != null
      ? nowMs + next.policyExpiryDays * DAY_MS
      : null;
  if (ends(was) !== ends(will))
    changes.push({
      key: "duration",
      label: "Duration",
      from: ends(was),
      to: ends(will),
    });

  unchanged.push(`offline days ${after.maxOfflineDays.value}`);
  return { changes, unchanged };
}

interface TierValues {
  [key: string]: unknown;
  tier: string | null;
}

export function ChangeTierDialog({
  slug,
  license,
  tiers,
  product,
  open,
  onOpenChange,
}: {
  slug: string;
  license: LicenseDetail;
  tiers: readonly TierSummary[];
  product: ProductDetail | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        license.name ? `Change ${licenseTitle(license)}'s tier` : "Change tier"
      }
    >
      {open ? (
        <ChangeTierForm
          slug={slug}
          license={license}
          tiers={tiers}
          product={product}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function ChangeTierForm({
  slug,
  license,
  tiers,
  product,
  onDone,
}: {
  slug: string;
  license: LicenseDetail;
  tiers: readonly TierSummary[];
  product: ProductDetail | undefined;
  onDone: () => void;
}): React.ReactElement {
  const [now] = React.useState(() => Date.now());
  const form = useAdminForm<TierValues>({
    values: { tier: license.tier ?? null },
    onSubmit: async (draft) => {
      const res = await mutate("patchLicense", slug, license.id, {
        tier: draft.tier ?? null,
      });
      const target = tiers.find((t) => t.id === draft.tier);
      if (res.overLimit) {
        toast.warning("Tier changed: over the device limit", {
          description: `${res.overLimit.deviceCount} devices are authorized and the new limit is ${res.overLimit.deviceLimit}. They keep working; new devices can't activate until the count drops.`,
        });
      } else {
        toast.success(
          target ? `Moved to ${target.label || target.id}` : "Tier removed",
        );
      }
      onDone();
    },
  });
  useDismissGuard(form.isDirty && !form.isSubmitting);
  const draft = form.rhf.watch("tier") as string | null | undefined;
  const to = draft ?? null;
  const same = to === (license.tier ?? null);
  const target = to ? tiers.find((t) => t.id === to) : undefined;
  const diff = React.useMemo(
    () => tierDiff(license, to, tiers, product ?? null, now),
    [license, to, tiers, product, now],
  );

  return (
    <Form form={form} aria-label="Change tier" className="contents">
      <DialogBody className="space-y-4">
        <FormField name="tier" label="Tier">
          {(f) => (
            <Combobox
              {...f}
              clearable
              placeholder="No tier"
              searchPlaceholder="Search tiers"
              emptyText="No tiers match."
              options={tiers.map((t, i) => ({
                value: t.id,
                label: t.label || t.id,
                secondary: `${tierSummary(t)} · ${i + 1} of ${tiers.length}`,
                searchText: `${t.label} ${t.id}`,
              }))}
            />
          )}
        </FormField>
        {same ? (
          <p className="text-sm text-fg-muted">
            Pick another tier to see what changes.
          </p>
        ) : (
          <>
            <section
              aria-labelledby="tier-diff"
              className="rounded-lg border border-border"
            >
              <h3
                id="tier-diff"
                className="border-b border-border px-4 py-2.5 text-sm font-semibold text-fg-strong"
              >
                What changes
              </h3>
              {diff.changes.length ? (
                <dl className="divide-y divide-border text-sm">
                  {diff.changes.map((c) => (
                    <div
                      key={c.key}
                      data-service={c.key === "tracks" ? "release" : undefined}
                      className="grid gap-x-4 gap-y-0.5 px-4 py-2.5 sm:grid-cols-[9rem_1fr]"
                    >
                      <dt className="text-fg-muted">{c.label}</dt>
                      <dd className="min-w-0">
                        <del className="text-fg-muted">{c.from}</del>
                        <span aria-hidden className="mx-1.5 text-fg-subtle">
                          →
                        </span>
                        <ins className="font-medium text-fg-strong no-underline">
                          {c.to}
                        </ins>
                        {c.note ? (
                          <span className="mt-0.5 block text-xs text-fg-muted">
                            {c.note}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="px-4 py-3 text-sm text-fg-muted">
                  No limit changes.
                </p>
              )}
            </section>
            <ul className="space-y-1.5 text-sm text-fg-muted">
              <li className="flex items-start gap-2">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>Unchanged: {diff.unchanged.join(", ")}</span>
              </li>
              <li className="flex items-start gap-2">
                <Clock aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>Devices get the new limits at their next check</span>
              </li>
            </ul>
          </>
        )}
        {form.submitError && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="The tier wasn't changed" live>
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
        <Button type="submit" loading={form.isSubmitting} disabled={same}>
          {target
            ? `Move to ${target.label || target.id}`
            : same
              ? "Move"
              : "Remove tier"}
        </Button>
      </DialogFooter>
    </Form>
  );
}
