/**
 * Deleting licenses (owner request, 2026-10-05): the record's "Delete license…", the list's bulk
 * "Delete…" and the Licenses page's "Clean up duplicates" helper.
 *
 * The Worker decides (`services/license/admin/deletion.ts`): a license may be deleted when it is
 * disabled or was minted by a sign-in or an auto-issue, and never when it carries store grants or
 * recorded store purchases. Every summary carries that verdict (`deletion`), so the console
 * disables the action with the reason instead of letting the operator find out at the confirm.
 *
 * Confirmation is L3 (`confirmFor("license.delete")`): one license types `delete <id>`, a bulk
 * deletion `delete <n> licenses`; the Worker compares the same strings. The cleanup helper is the
 * one exception the owner asked for: one confirm that states the count.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type LicenseCleanupCandidate,
  type LicenseDeletion,
  type LicenseDetail,
  type LicenseSummary,
} from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { r } from "../../routes.js";
import { navigate } from "../../router.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatRelative, fromSeconds } from "../../../lib/format.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Spinner } from "../../../ui/Spinner.js";
import { toast } from "../../../ui/toast.js";

/** The typed confirmation for one license; the Worker compares the same string. */
export function deleteConfirmation(id: string): string {
  return `delete ${id}`;
}

/** The typed confirmation for `n` licenses at once. */
export function bulkDeleteConfirmation(n: number): string {
  return `delete ${n} ${n === 1 ? "license" : "licenses"}`;
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** Why "Delete license…" is unavailable, or `undefined` when it is (or the server did not say). */
export function deletionBlockedReason(
  deletion: LicenseDeletion | undefined,
): string | undefined {
  if (!deletion || deletion.allowed) return undefined;
  return (
    deletion.reasons.map((r) => r.message).join(" ") ||
    "This license can't be deleted."
  );
}

/** Whether a summary may be deleted (an older Worker that sends no verdict: let it decide). */
export function deletable(l: Pick<LicenseSummary, "deletion">): boolean {
  return l.deletion?.allowed ?? true;
}

/** The Worker's refusal names every reason; anything else gets the console's usual copy. */
function describeDelete(e: unknown): { title: string; description?: string } {
  if (e instanceof ApiError && e.code === "license_not_deletable")
    return { title: "This license can't be deleted", description: e.message };
  return errorCopy(e, { thing: "License" });
}

// ── one license ────────────────────────────────────────────────────────────────────────────

export function DeleteLicenseDialog({
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
  const policy = confirmFor("license.delete");
  const devices = license.devices.length;
  const keys = license.keys.length;
  const confirm = deleteConfirmation(license.id);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent={policy.intent as "danger"}
      title={`Delete ${license.name || license.id}?`}
      description="The license and everything bound to it are removed for good."
      consequences={[
        devices
          ? `Its ${plural(devices, "device")} stop authenticating right away and are removed.`
          : "No device is bound to it.",
        `Its ${plural(keys, "key")}, registry tokens, purchase binding and portal links are removed.`,
        "Its activity history is kept, with a “license deleted” entry.",
        "This can't be undone. To keep the record, disable the license instead.",
      ]}
      typedConfirmation={
        policy.typedConfirmation ? { value: confirm, label: "Type" } : undefined
      }
      confirmLabel="Delete license"
      describeError={describeDelete}
      onConfirm={async () => {
        const res = await mutate("deleteLicense", slug, license.id, confirm);
        toast.success(
          res.devices
            ? `License deleted with ${plural(res.devices, "device")}`
            : "License deleted",
        );
        queryClient.removeQueries({ queryKey: qk.license(slug, license.id) });
        navigate(r.licenses(slug));
      }}
    />
  );
}

// ── several, from the list's selection ───────────────────────────────────────────────────────

export function BulkDeleteDialog({
  slug,
  rows,
  onOpenChange,
}: {
  slug: string;
  /** The selection; `null` = closed. */
  rows: LicenseSummary[] | null;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const policy = confirmFor("license.delete");
  const allowed = (rows ?? []).filter(deletable);
  const refused = (rows ?? []).filter((l) => !deletable(l));
  const n = allowed.length;
  const confirm = bulkDeleteConfirmation(n);
  return (
    <ConfirmDialog
      open={rows !== null}
      onOpenChange={onOpenChange}
      intent={policy.intent as "danger"}
      title={`Delete ${plural(n, "license")}?`}
      consequences={[
        "Their devices stop authenticating right away and are removed, with their keys, registry tokens, purchase bindings and portal links.",
        "Their activity history is kept.",
        "This can't be undone.",
      ]}
      typedConfirmation={
        policy.typedConfirmation && n > 0
          ? { value: confirm, label: "Type" }
          : undefined
      }
      confirmLabel={`Delete ${plural(n, "license")}`}
      confirmDisabled={n === 0}
      describeError={describeDelete}
      onConfirm={async () => {
        const res = await mutate(
          "deleteLicenses",
          slug,
          allowed.map((l) => l.id),
          confirm,
        );
        const done = res.deleted.length;
        if (res.refused.length || res.notFound.length) {
          throw new Error(
            `${done} of ${n} deleted. ` +
              res.refused
                .map(
                  (f) =>
                    `${f.id}: ${f.reasons.map((x) => x.message).join(" ")}`,
                )
                .concat(res.notFound.map((id) => `${id}: not found.`))
                .join(" "),
          );
        }
        toast.success(`${plural(done, "license")} deleted`);
      }}
    >
      {refused.length ? (
        <div className="space-y-1.5">
          <p className="text-fg">
            {plural(refused.length, "selected license")}{" "}
            {refused.length === 1 ? "is" : "are"} skipped:
          </p>
          <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-surface-sunken p-2 text-xs">
            {refused.map((l) => (
              <li key={l.id}>
                <span className="font-bold text-fg-strong">
                  {l.name || l.id}
                </span>{" "}
                <span className="text-fg-muted">
                  — {deletionBlockedReason(l.deletion)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

// ── the cleanup helper ───────────────────────────────────────────────────────────────────────

const REASON_LABEL: Record<LicenseCleanupCandidate["reason"], string> = {
  duplicate: "Duplicate",
  dormant: "Dormant",
};

function candidateWhy(c: LicenseCleanupCandidate, recentDays: number): string {
  if (c.reason === "duplicate")
    return `Sign-in license; the account also holds ${c.keeps ?? "another license"}.`;
  return c.lastSeen
    ? `Disabled; last used ${formatRelative(fromSeconds(c.lastSeen))}.`
    : `Disabled; no device in the last ${recentDays} days.`;
}

export function useLicenseCleanup(slug: string, enabled: boolean) {
  return useQuery(
    {
      queryKey: qk.licenseCleanup(slug),
      queryFn: () => api.licenseCleanupCandidates(slug),
      enabled,
    },
    queryClient,
  );
}

/**
 * "Clean up duplicates": sign-in licenses whose account also holds another usable license, and
 * disabled sign-in licenses no device has used recently. One confirm deletes every candidate the
 * Worker allows; the rest are listed with their reason.
 */
export function CleanupDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const q = useLicenseCleanup(slug, open);
  const candidates = q.data?.candidates ?? [];
  const recentDays = q.data?.recentDays ?? 30;
  const allowed = candidates.filter((c) => c.deletion.allowed);
  const skipped = candidates.filter((c) => !c.deletion.allowed);
  const n = allowed.length;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent="danger"
      title="Clean up duplicate licenses"
      description={`Sign-in licenses whose account also holds another usable license, and disabled sign-in licenses no device has used in ${recentDays} days.`}
      confirmLabel={n ? `Delete ${plural(n, "license")}` : "Delete"}
      confirmDisabled={q.isPending || n === 0}
      describeError={describeDelete}
      onConfirm={async () => {
        const res = await mutate(
          "deleteLicenses",
          slug,
          allowed.map((c) => c.id),
          bulkDeleteConfirmation(n),
        );
        const done = res.deleted.length;
        if (res.refused.length || res.notFound.length)
          throw new Error(
            `${done} of ${n} deleted; the rest changed since the list loaded. Reopen it to see why.`,
          );
        toast.success(`${plural(done, "license")} deleted`);
      }}
    >
      {q.isPending ? (
        <p className="flex items-center gap-2 text-fg-muted">
          <Spinner className="size-4" /> Looking for duplicates…
        </p>
      ) : q.error ? (
        <p className="text-danger">{errorCopy(q.error).title}</p>
      ) : candidates.length === 0 ? (
        <p className="text-fg-muted">Nothing to clean up.</p>
      ) : (
        <div className="space-y-3">
          {n ? (
            <CandidateList
              heading={`${plural(n, "license")} will be deleted, with their devices and keys. Their activity history is kept; this can't be undone.`}
              items={allowed}
              recentDays={recentDays}
            />
          ) : null}
          {skipped.length ? (
            <CandidateList
              heading={`${plural(skipped.length, "license")} can't be deleted:`}
              items={skipped}
              recentDays={recentDays}
              skipped
            />
          ) : null}
        </div>
      )}
    </ConfirmDialog>
  );
}

function CandidateList({
  heading,
  items,
  recentDays,
  skipped = false,
}: {
  heading: string;
  items: LicenseCleanupCandidate[];
  recentDays: number;
  skipped?: boolean;
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <p className="text-fg">{heading}</p>
      <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border bg-surface-sunken text-xs">
        {items.map((c) => (
          <li key={c.id} className="flex items-start gap-2 px-2.5 py-2">
            <StatusPill
              tone={skipped ? "neutral" : "warning"}
              icon={false}
              size="sm"
            >
              {REASON_LABEL[c.reason]}
            </StatusPill>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-bold text-fg-strong">
                {c.name || c.email || c.id}{" "}
                <span className="font-mono font-normal text-fg-muted">
                  {c.id}
                </span>
              </span>
              <span className="text-fg-muted">
                {skipped
                  ? deletionBlockedReason(c.deletion)
                  : `${candidateWhy(c, recentDays)} ${plural(c.deviceCount, "device")}.`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
