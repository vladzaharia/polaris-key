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
 * collector (`core/licensing/licenseDelete.ts`); a refusal names every reason and suggests disabling.
 *
 * WHAT GOES. Everything keyed by the licence, in ONE batch with the `license.delete` audit row:
 * the licence, its keys and profile stack, its devices and their facts and fingerprints, its
 * registry tokens, its purchase binding and the portal's links to it. The devices' bearer tokens
 * are purged from KV once the batch has committed, so a deleted licence's devices stop
 * authenticating at once. The licence's audit history stays.
 *
 * Also refused: a disabled auto-issued licence still bound to its machine (`enroll_guard`) —
 * it is what stops that machine enrolling again.
 *
 * CONFIRMATION. Typed, and checked here as well as in the console (the platform-settings
 * pattern): a single deletion types `delete <id>`, a bulk one `delete <n> licenses` (the console
 * sends at most {@link MAX_BULK_DELETE} per request).
 *
 * The cleanup list names sign-in duplicates only (an account that also holds a usable licence);
 * it never lists a licence just because it is disabled.
 */

import { ErrorCode } from "../../../core/errors.js";
import { deleteTokenRecord } from "../../../platform/kv.js";
import {
  getLicense,
  listDevicesByLicense,
  type LicenseRow,
} from "../../../core/repo.js";
import { licenseUsable } from "../../../core/devices.js";
import {
  existingSubjectFor,
  existingSubjectsFor,
} from "../../../core/accounts/accountSubjects.js";
import { forgetRegistryTokens } from "../../../core/registry/registryTokens.js";
import {
  idChunks,
  LicenseDeleteReason,
  type LicenseDelete,
  type LicenseDeleteBlocker,
} from "../../../core/licensing/licenseDelete.js";
import {
  adminJson,
  notFound as adminNotFound,
  err,
  readBody,
} from "../../../core/console/respond.js";
import { auditStatementFor } from "../../../core/console/audit.js";
import type { LicenseAdminContext } from "./index.js";

/** Origins a licence may be deleted from while still active: minted by a flow, not by a person. */
const FLOW_ORIGINS = new Set(["oidc", "enroll"]);

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
  code: LicenseDeleteReason.Unavailable,
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
        code: LicenseDeleteReason.IssuedActive,
        message:
          "It is active and was issued by the developer. Disable it first.",
      });
    // A disabled auto-issued licence still bound to its machine is what stops that machine from
    // enrolling for another free licence (`idx_licenses_enroll_hwid`): deleting it would lift
    // the refusal the operator chose.
    if (row.status === "disabled" && row.origin === "enroll" && row.enroll_hwid)
      reasons.push({
        code: LicenseDeleteReason.EnrollGuard,
        message:
          "It is the machine's free-license record; deleting it would let the machine enroll again.",
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
 * Delete one licence whose verdict allowed it: the guarded batch, then the KV purge. `null` when
 * the guard held the batch back (a store purchase landed since the verdict was read): nothing was
 * written, and the caller refuses with a fresh verdict.
 */
async function deleteOne(
  ctx: LicenseAdminContext,
  collector: LicenseDelete,
  row: LicenseRow,
): Promise<Deleted | null> {
  const { db, env, product, session, now } = ctx;
  const slug = product.slug;
  const target = { product: slug, licenseId: row.id, now };
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
  const guard = collector.guard(target);
  await db.batch([
    // The audit row FIRST, while the licence still exists: guarded by the owners' checks and by
    // the row's existence, so a concurrent second deletion of the same licence audits nothing.
    auditStatementFor(
      slug,
      session,
      now,
      "license.delete",
      { kind: "license", id: row.id },
      summary,
      {
        sql: `${guard.sql} AND EXISTS (SELECT 1 FROM licenses WHERE product = ? AND id = ?)`,
        params: [...guard.params, slug, row.id],
      },
    ),
    ...collector.statements(target),
  ]);
  if (await getLicense(db, slug, row.id)) return null;
  for (const d of devices)
    if (d.token_hash) await deleteTokenRecord(env, slug, d.token_hash);
  forgetRegistryTokens();
  return { id: row.id, devices: devices.length };
}

/** A fresh verdict for a licence the guard held back. */
async function freshVerdict(
  ctx: LicenseAdminContext,
  row: LicenseRow,
): Promise<DeletionVerdict> {
  const verdict = (await deletionVerdicts(ctx, [row])).get(row.id)!;
  return verdict.allowed
    ? {
        allowed: false,
        reasons: [
          {
            code: LicenseDeleteReason.Changed,
            message: "It changed while it was being deleted. Try again.",
          },
        ],
      }
    : verdict;
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
  if (!deleted) return refusal(row.id, await freshVerdict(ctx, row));
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
  if (sub !== undefined) return adminNotFound();
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
    const done = await deleteOne(ctx, ctx.licenseDelete, row);
    if (done) deleted.push(done);
    else
      refused.push({
        id: row.id,
        reasons: (await freshVerdict(ctx, row)).reasons,
      });
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
  /** Always `duplicate`: the account holds another usable licence (`keeps`). */
  reason: "duplicate";
  /** The account's usable licence that stays. */
  keeps: string;
  deletion: DeletionVerdict;
}

/**
 * The "Clean up duplicates" list: sign-in (`oidc`) licences whose account also holds another
 * usable licence of the product. Each carries its verdict; the console deletes only the allowed.
 *
 * Disabled licences on their own are NOT listed: a disabled licence is often a deliberate
 * refusal (a sign-in licence whose holder would simply get a new one by signing in again once
 * it is gone), so deleting it is a decision made on its record, never in bulk.
 *
 * A constant number of queries whatever the product's size: every licence held by an account
 * that holds a sign-in licence (one query), the devices aggregated per licence (one per id
 * chunk), and the pairwise subjects (one per account chunk).
 */
async function cleanupCandidates(
  ctx: LicenseAdminContext,
): Promise<{ candidates: Candidate[] }> {
  const { db, product, now } = ctx;
  const slug = product.slug;
  const held = await db.all<LicenseRow>(
    `SELECT * FROM licenses
      WHERE product = ? AND account_id IN (
        SELECT account_id FROM licenses
         WHERE product = ? AND origin = 'oidc' AND account_id IS NOT NULL)
      ORDER BY activated_at ASC, id ASC`,
    slug,
    slug,
  );
  const byAccount = new Map<string, LicenseRow[]>();
  for (const row of held) {
    const list = byAccount.get(row.account_id!) ?? [];
    list.push(row);
    byAccount.set(row.account_id!, list);
  }
  // Per account, the usable licence that STAYS: one it did not get from a sign-in first (a
  // developer-issued or purchased licence is the one the duplicate shadowed), then the oldest.
  // Picking one keeper is what stops two sign-in duplicates from each listing the other.
  const picked: { row: LicenseRow; keeps: string }[] = [];
  for (const rows of byAccount.values()) {
    const usable = rows.filter((o) => licenseUsable(o, now));
    const keeper = usable.find((o) => o.origin !== "oidc") ?? usable[0];
    if (!keeper) continue;
    for (const row of rows)
      if (row.origin === "oidc" && row.id !== keeper.id)
        picked.push({ row, keeps: keeper.id });
  }
  // Newest first, as the licence list reads.
  picked.sort(
    (a, b) =>
      b.row.activated_at - a.row.activated_at || (a.row.id < b.row.id ? 1 : -1),
  );

  const usage = new Map<string, { n: number; lastSeen: number | null }>();
  for (const batch of idChunks(picked.map((p) => p.row.id))) {
    const marks = batch.map(() => "?").join(", ");
    for (const r of await db.all<{
      license_id: string;
      n: number;
      last_seen: number | null;
    }>(
      `SELECT license_id, COUNT(*) AS n, MAX(last_seen) AS last_seen FROM devices
        WHERE product = ? AND license_id IN (${marks})
        GROUP BY license_id`,
      slug,
      ...batch,
    ))
      usage.set(r.license_id, { n: r.n, lastSeen: r.last_seen });
  }
  const subjects = await existingSubjectsFor(
    db,
    picked.map((p) => p.row.account_id!),
    slug,
  );
  const verdicts = await deletionVerdicts(
    ctx,
    picked.map((p) => p.row),
  );
  return {
    candidates: picked.map(({ row, keeps }) => ({
      id: row.id,
      name: row.name ?? "",
      email: row.email ?? "",
      status: row.status,
      tier: row.tier_id,
      accountSubject: subjects.get(row.account_id!) ?? null,
      deviceCount: usage.get(row.id)?.n ?? 0,
      lastSeen: usage.get(row.id)?.lastSeen ?? null,
      reason: "duplicate" as const,
      keeps,
      deletion: verdicts.get(row.id)!,
    })),
  };
}
