/**
 * Licence deletion on the console API (owner request, 2026-10-05).
 *
 *   DELETE …/license/licenses/<id>            `{ confirm: "delete <id>" }`
 *   POST   …/license/deletions                `{ ids: [...], confirm: "delete <n> licenses" }`
 *   GET    …/license/deletions/candidates     the "Clean up duplicates" list
 *
 * WHO MAY BE DELETED. A licence that is disabled, or one a sign-in or an auto-issue minted
 * (`origin` `oidc` or `enroll`) — never an active licence the developer issued, which is
 * disabled first. And never a licence with commerce history: store grants (License) or recorded
 * store purchases (Distribution), whatever their state. The owners answer through Core's
 * collector (`core/licenseDelete.ts`); a refusal names every reason and suggests disabling.
 *
 * WHAT GOES. Everything keyed by the licence, in ONE batch with the `license.delete` audit row:
 * the licence, its keys and profile stack, its devices and their facts and fingerprints, its
 * registry tokens, its purchase binding and the portal's links to it. The devices' bearer tokens
 * are purged from KV once the batch has committed, so a deleted licence's devices stop
 * authenticating at once. The licence's audit history stays.
 *
 * CONFIRMATION. Typed, and checked here as well as in the console (the platform-settings
 * pattern): a single deletion types `delete <id>`, a bulk one `delete <n> licenses`.
 */

import { ErrorCode } from "../../../core/errors.js";
import { deleteTokenRecord } from "../../../core/platform.js";
import {
  getLicense,
  listDevicesByLicense,
  type LicenseRow,
} from "../../../core/data.js";
import { licenseUsable } from "../../../core/devices.js";
import { existingSubjectFor } from "../../../core/accountSubjects.js";
import { forgetRegistryTokens } from "../../../core/registryTokens.js";
import type {
  LicenseDelete,
  LicenseDeleteBlocker,
} from "../../../core/licenseDelete.js";
import {
  adminJson,
  auditStatementFor,
  err,
  readBody,
} from "../../../core/adminApi.js";
import type { LicenseAdminContext } from "./index.js";

/** Origins a licence may be deleted from while still active: minted by a flow, not by a person. */
const FLOW_ORIGINS = new Set(["oidc", "enroll"]);

/** "No recent device use" for the cleanup helper. */
export const CLEANUP_RECENT_SECONDS = 30 * 86_400;

/** Most licences one bulk request deletes. */
export const MAX_BULK_DELETE = 100;

export interface DeletionVerdict {
  allowed: boolean;
  reasons: LicenseDeleteBlocker[];
}

/** The typed confirmation for one licence. */
export function deleteConfirmation(licenseId: string): string {
  return `delete ${licenseId}`;
}

/** The typed confirmation for a bulk deletion of `n` licences. */
export function bulkDeleteConfirmation(n: number): string {
  return `delete ${n} ${n === 1 ? "license" : "licenses"}`;
}

const UNAVAILABLE: LicenseDeleteBlocker = {
  code: "unavailable",
  message: "License deletion is not available on this route.",
};

/** Every licence's verdict, the owners' blockers read in one pass per owner. */
export async function deletionVerdicts(
  ctx: LicenseAdminContext,
  rows: readonly LicenseRow[],
): Promise<Map<string, DeletionVerdict>> {
  const out = new Map<string, DeletionVerdict>();
  const blockers = ctx.licenseDelete
    ? await ctx.licenseDelete.blockers(
        ctx.db,
        ctx.product.slug,
        rows.map((r) => r.id),
      )
    : null;
  for (const row of rows) {
    const reasons: LicenseDeleteBlocker[] = [];
    if (!blockers) reasons.push(UNAVAILABLE);
    if (row.status === "active" && !FLOW_ORIGINS.has(row.origin ?? "admin"))
      reasons.push({
        code: "issued_active",
        message:
          "It is active and was issued by the developer. Disable it first.",
      });
    reasons.push(...(blockers?.get(row.id) ?? []));
    out.set(row.id, { allowed: reasons.length === 0, reasons });
  }
  return out;
}

/** What one deletion removed, for the response and the audit summary. */
interface Deleted {
  id: string;
  devices: number;
}

/**
 * Delete one licence whose verdict allowed it: the batch, then the KV purge. `delete_` because
 * the collector is required; the caller has checked it.
 */
async function deleteOne(
  ctx: LicenseAdminContext,
  collector: LicenseDelete,
  row: LicenseRow,
): Promise<Deleted> {
  const { db, env, product, session, now } = ctx;
  const slug = product.slug;
  const devices = await listDevicesByLicense(db, slug, row.id);
  const authorized = devices.filter((d) => d.status === "authorized").length;
  // The pairwise subject, never the global account id (S-16 §5.1): the audit log is
  // developer-facing. Read-only: a deletion never creates a subject.
  const subject = row.account_id
    ? await existingSubjectFor(db, row.account_id, slug)
    : null;
  const account = row.account_id ? (subject ?? "an account") : "none";
  const summary =
    `Deleted license ${row.id} (tier ${row.tier_id ?? "none"}, origin ${row.origin ?? "admin"}, ` +
    `account ${account}, ${devices.length} ${devices.length === 1 ? "device" : "devices"}` +
    `${devices.length ? `, ${authorized} authorized` : ""})`;
  await db.batch([
    ...collector.statements({ product: slug, licenseId: row.id, now }),
    auditStatementFor(
      slug,
      session,
      now,
      "license.delete",
      { kind: "license", id: row.id },
      summary,
    ),
  ]);
  for (const d of devices)
    if (d.token_hash) await deleteTokenRecord(env, slug, d.token_hash);
  forgetRegistryTokens();
  return { id: row.id, devices: devices.length };
}

function refusal(id: string, verdict: DeletionVerdict): Response {
  return err(
    409,
    "license_not_deletable",
    `License ${id} can't be deleted: ${verdict.reasons.map((r) => r.message).join(" ")}`,
    {
      reasons: verdict.reasons,
      // Disabling stops the licence's devices at once and keeps its history.
      suggestion: "disable",
    },
  );
}

/** `DELETE …/license/licenses/<id>`. */
export async function handleDeleteLicense(
  ctx: LicenseAdminContext,
  row: LicenseRow,
): Promise<Response> {
  const body = await readBody(ctx.req);
  const expected = deleteConfirmation(row.id);
  if (body.confirm !== expected)
    return err(400, ErrorCode.BadRequest, `type "${expected}" to confirm`, {
      reason: "confirm_required",
      fields: ["confirm"],
    });
  const verdict = (await deletionVerdicts(ctx, [row])).get(row.id)!;
  if (!verdict.allowed || !ctx.licenseDelete) return refusal(row.id, verdict);
  const deleted = await deleteOne(ctx, ctx.licenseDelete, row);
  return adminJson({ ok: true, ...deleted });
}

/** `…/license/deletions[/candidates]`. */
export async function handleDeletions(
  ctx: LicenseAdminContext,
  sub: string | undefined,
): Promise<Response> {
  if (sub === "candidates") {
    if (ctx.req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson(await cleanupCandidates(ctx));
  }
  if (sub !== undefined) return err(404, ErrorCode.NotFound);
  if (ctx.req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(ctx.req);
  const ids = Array.isArray(body.ids)
    ? [
        ...new Set(
          body.ids.filter((x): x is string => typeof x === "string" && !!x),
        ),
      ]
    : [];
  if (ids.length === 0)
    return err(422, ErrorCode.BadRequest, "ids must name a license", {
      fields: ["ids"],
    });
  if (ids.length > MAX_BULK_DELETE)
    return err(
      422,
      ErrorCode.BadRequest,
      `at most ${MAX_BULK_DELETE} licenses at once`,
      { fields: ["ids"] },
    );
  const expected = bulkDeleteConfirmation(ids.length);
  if (body.confirm !== expected)
    return err(400, ErrorCode.BadRequest, `type "${expected}" to confirm`, {
      reason: "confirm_required",
      fields: ["confirm"],
    });

  const rows: LicenseRow[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const row = await getLicense(ctx.db, ctx.product.slug, id);
    if (row) rows.push(row);
    else notFound.push(id);
  }
  const verdicts = await deletionVerdicts(ctx, rows);
  const deleted: Deleted[] = [];
  const refused: { id: string; reasons: LicenseDeleteBlocker[] }[] = [];
  for (const row of rows) {
    const verdict = verdicts.get(row.id)!;
    if (!verdict.allowed || !ctx.licenseDelete) {
      refused.push({ id: row.id, reasons: verdict.reasons });
      continue;
    }
    // One batch per licence: each deletion is all-or-nothing on its own, and one licence's
    // failure does not hold the others back.
    deleted.push(await deleteOne(ctx, ctx.licenseDelete, row));
  }
  return adminJson({ ok: refused.length === 0, deleted, refused, notFound });
}

/** One row of the cleanup list. */
interface Candidate {
  id: string;
  name: string;
  email: string;
  status: string;
  tier: string | null;
  /** The owner's pairwise subject, when it has one (never the account id). */
  accountSubject: string | null;
  deviceCount: number;
  lastSeen: number | null;
  /** `duplicate`: the account holds another usable licence. `dormant`: disabled, no recent use. */
  reason: "duplicate" | "dormant";
  /** For a duplicate: the account's usable licence that stays. */
  keeps: string | null;
  deletion: DeletionVerdict;
}

/**
 * The "Clean up duplicates" list: sign-in (`oidc`) licences whose account also holds another
 * usable licence of the product, and disabled sign-in licences no device has used in
 * {@link CLEANUP_RECENT_SECONDS}. Each carries its verdict; the console deletes only the allowed.
 */
async function cleanupCandidates(
  ctx: LicenseAdminContext,
): Promise<{ candidates: Candidate[]; recentDays: number }> {
  const { db, product, now } = ctx;
  const slug = product.slug;
  const oidc = await db.all<LicenseRow>(
    "SELECT * FROM licenses WHERE product = ? AND origin = 'oidc' ORDER BY activated_at DESC, id DESC",
    slug,
  );
  const accounts = [
    ...new Set(oidc.map((r) => r.account_id).filter((a): a is string => !!a)),
  ];
  // Per account, the usable licence that STAYS: one it did not get from a sign-in first (a
  // developer-issued or purchased licence is the one the duplicate shadowed), then the oldest.
  // Picking one keeper is what stops two sign-in duplicates from each listing the other.
  const keeper = new Map<string, LicenseRow>();
  for (const account of accounts) {
    const usable = (
      await db.all<LicenseRow>(
        "SELECT * FROM licenses WHERE product = ? AND account_id = ? ORDER BY activated_at ASC, id ASC",
        slug,
        account,
      )
    ).filter((o) => licenseUsable(o, now));
    const pick = usable.find((o) => o.origin !== "oidc") ?? usable[0];
    if (pick) keeper.set(account, pick);
  }
  const picked: {
    row: LicenseRow;
    reason: Candidate["reason"];
    keeps: string | null;
  }[] = [];
  const usage = new Map<string, { n: number; lastSeen: number | null }>();
  for (const row of oidc) {
    const devices = await listDevicesByLicense(db, slug, row.id);
    const lastSeen = devices.reduce<number | null>(
      (m, d) => (m === null || d.last_seen > m ? d.last_seen : m),
      null,
    );
    usage.set(row.id, { n: devices.length, lastSeen });
    const kept = row.account_id ? keeper.get(row.account_id) : undefined;
    const other = kept && kept.id !== row.id ? kept : undefined;
    if (other) {
      picked.push({ row, reason: "duplicate", keeps: other.id });
      continue;
    }
    if (
      row.status === "disabled" &&
      (lastSeen === null || lastSeen < now - CLEANUP_RECENT_SECONDS)
    )
      picked.push({ row, reason: "dormant", keeps: null });
  }
  const verdicts = await deletionVerdicts(
    ctx,
    picked.map((p) => p.row),
  );
  const candidates: Candidate[] = [];
  for (const { row, reason, keeps } of picked) {
    const use = usage.get(row.id)!;
    candidates.push({
      id: row.id,
      name: row.name ?? "",
      email: row.email ?? "",
      status: row.status,
      tier: row.tier_id,
      accountSubject: row.account_id
        ? await existingSubjectFor(db, row.account_id, slug)
        : null,
      deviceCount: use.n,
      lastSeen: use.lastSeen,
      reason,
      keeps,
      deletion: verdicts.get(row.id)!,
    });
  }
  return { candidates, recentDays: CLEANUP_RECENT_SECONDS / 86_400 };
}
