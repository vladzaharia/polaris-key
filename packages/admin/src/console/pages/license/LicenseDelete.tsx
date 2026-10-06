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
 * deletion `delete <n> licenses`; the Worker compares the same strings. The cleanup helper types
 * the count the same way. A selection larger than the Worker's per-request limit is sent in
 * chunks of {@link MAX_BULK_DELETE}, each with its own count, and the results are summed.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type LicenseBulkDeleteResult,
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

/** The Worker's per-request limit (`MAX_BULK_DELETE` in `services/license/admin/deletion.ts`). */
export const MAX_BULK_DELETE = 100;

/** A disabled sign-in license: deleting it lifts the refusal, since signing in mints a new one. */
export function reissuedOnSignIn(
  l: Pick<LicenseSummary, "status" | "origin">,
): boolean {
  return l.status === "disabled" && l.origin === "oidc";
}

export const REISSUE_WARNING =
  "If its holder signs in again, they get a new license.";

/** Delete `ids` in chunks the Worker accepts, summing the results. */
export async function deleteInChunks(
  slug: string,
  ids: readonly string[],
): Promise<LicenseBulkDeleteResult> {
  const total: LicenseBulkDeleteResult = {
    ok: true,
    deleted: [],
    refused: [],
    notFound: [],
  };
  for (let i = 0; i < ids.length; i += MAX_BULK_DELETE) {
    const chunk = ids.slice(i, i + MAX_BULK_DELETE);
    const res = await mutate(
      "deleteLicenses",
      slug,
      chunk,
      bulkDeleteConfirmation(chunk.length),
    );
    total.deleted.push(...res.deleted);
    total.refused.push(...res.refused);
    total.notFound.push(...res.notFound);
    total.ok &&= res.ok;
  }
  return total;
}

/** Throws the partial-result error when anything was refused or missing. */
function assertAllDeleted(res: LicenseBulkDeleteResult, n: number): void {
  if (!res.refused.length && !res.notFound.length) return;
  throw new Error(
    `${res.deleted.length} of ${n} deleted. ` +
      res.refused
        .map((f) => `${f.id}: ${f.reasons.map((x) => x.message).join(" ")}`)
        .concat(res.notFound.map((id) => `${id}: not found.`))
        .join(" "),
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
        devices === 0
          ? "No device is bound to it."
          : devices === 1
            ? "Its device stops authenticating right away and is removed."
            : `Its ${devices} devices stop authenticating right away and are removed.`,
        `${keys === 1 ? "Its key" : keys ? `Its ${keys} keys` : "Its keys"}, registry tokens, purchase binding and portal links are removed.`,
        ...(reissuedOnSignIn(license) ? [REISSUE_WARNING] : []),
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
  const reissued = allowed.filter(reissuedOnSignIn).length;
  return (
    <ConfirmDialog
      open={rows !== null}
      onOpenChange={onOpenChange}
      intent={policy.intent as "danger"}
      title={`Delete ${plural(n, "license")}?`}
      consequences={[
        "Their devices stop authenticating right away and are removed, with their keys, registry tokens, purchase bindings and portal links.",
        ...(reissued
          ? [
              `${plural(reissued, "of them is a disabled sign-in license", "of them are disabled sign-in licenses")}: if a holder signs in again, they get a new license.`,
            ]
          : []),
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
        const res = await deleteInChunks(
          slug,
          allowed.map((l) => l.id),
        );
        const done = res.deleted.length;
        assertAllDeleted(res, n);
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
 * "Clean up duplicates": sign-in licenses whose account also holds another usable license. It
 * never lists a license only because it is disabled: that is often a deliberate refusal, decided
 * on the license's own record. One typed confirm (`delete <n> licenses`) deletes every candidate
 * the Worker allows; the rest are listed with their reason.
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
  const policy = confirmFor("license.delete");
  const q = useLicenseCleanup(slug, open);
  const candidates = q.data?.candidates ?? [];
  const allowed = candidates.filter((c) => c.deletion.allowed);
  const skipped = candidates.filter((c) => !c.deletion.allowed);
  const n = allowed.length;
  // Every candidate is a sign-in license, so a disabled one is reissued on its next sign-in.
  const reissued = allowed.filter((c) => c.status === "disabled").length;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent={policy.intent as "danger"}
      title="Clean up duplicate licenses"
      description="Sign-in licenses whose account also holds another usable license for this product. The account keeps that license."
      typedConfirmation={
        policy.typedConfirmation && n > 0
          ? { value: bulkDeleteConfirmation(n), label: "Type" }
          : undefined
      }
      confirmLabel={n ? `Delete ${plural(n, "license")}` : "Delete"}
      confirmDisabled={q.isPending || n === 0}
      describeError={describeDelete}
      onConfirm={async () => {
        const res = await deleteInChunks(
          slug,
          allowed.map((c) => c.id),
        );
        const done = res.deleted.length;
        assertAllDeleted(res, n);
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
              heading={`${plural(n, "license")} will be deleted, with their devices and keys. Their activity history is kept; this can't be undone.${reissued ? ` ${REISSUE_WARNING.replace("its holder", "a disabled one's holder")}` : ""}`}
              items={allowed}
            />
          ) : null}
          {skipped.length ? (
            <CandidateList
              heading={`${plural(skipped.length, "license")} can't be deleted:`}
              items={skipped}
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
  skipped = false,
}: {
  heading: string;
  items: LicenseCleanupCandidate[];
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
              Duplicate
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
                  : `Sign-in license; the account keeps ${c.keeps}. ${plural(c.deviceCount, "device")}${c.lastSeen ? `, last used ${formatRelative(fromSeconds(c.lastSeen))}` : ""}.`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
