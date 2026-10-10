/**
 * Licence batches (`/manage/api/products/<slug>/license/batches/...`, LX-28; notes/S-24 §5.6,
 * §6.3, §7.1, D10):
 *
 *   POST /batches                          create up to 500 floating licences in one labelled
 *                                          batch; the answer carries every key ONCE (`no-store`)
 *   GET  /batches[?limit&cursor]           the batches, newest first, with their used counts,
 *                                          a page at a time (LX-30: `nextCursor`)
 *   GET  /batches/<id>                     one batch
 *   POST /batches/<id>/disable-unused      disable every licence of the batch never used;
 *                                          `{ confirm? }`, the batch label when given (LX-30)
 *
 * The data and the SQL are `../batches.ts`. Every licence of a batch is floating (no name, no
 * email, no account: the holder rule's `isFloatingLicense`), `origin = 'admin'`, and carries its
 * `batch_id`; the batch row, the licences, their keys and the audit row commit in one D1 batch or
 * not at all. The plaintext keys are in the create answer only: the Worker keeps their peppered
 * hashes and never answers them again. The console builds the CSV from that answer (LX-29).
 */

import { ErrorCode } from "../../../core/errors.js";
import { deleteTokenRecord } from "../../../kv.js";
import { hashKey, mintLicenseKey, randomId } from "../../../crypto.js";
import { getTier } from "../../../repo.js";
import {
  adminJson,
  notFound as adminNotFound,
  err,
  readBody,
} from "../../../admin/lib/respond.js";
import { auditStatementFor } from "../../../admin/audit.js";
import { WriteChecks } from "../../../admin/lib/writeChecks.js";
import type { AdminSession } from "../../../admin/session.js";
import type { Db, DbStatement } from "../../../db/types.js";
import { describeHolder, licenseHolder } from "../../../core/licenseHolders.js";
import { tierExpiresAt } from "../../../core/authz.js";
import {
  BATCH_PAGE_MAX,
  batchDisabledDeviceTokens,
  decodeBatchCursor,
  countUnusedBatchLicenses,
  createBatchStatements,
  disableUnusedAfterAuditStatement,
  getLicenseBatch,
  listLicenseBatches,
  MAX_BATCH_COUNT,
  MAX_BATCH_LABEL,
  type BatchLicenseKey,
  type LicenseBatchRow,
  type LicenseBatchView,
  unusedCountIs,
} from "../batches.js";
import type { LicenseAdminContext } from "./index.js";
import { invalidLicenseDeviceLimit, parseChannels } from "./licenses.js";

/** Holder fields a batch refuses: its licences are floating (S-24 D1, D10). */
const HOLDER_FIELDS = ["name", "email", "profiles", "profile"] as const;

/**
 * What a one-line label may not hold: C0 and C1 controls, the line and paragraph separators
 * (U+2028, U+2029), and the bidi embedding, override and isolate controls (U+202A to U+202E,
 * U+2066 to U+2069), which would reorder the label, the audit summary or a CSV row around it.
 */
const NOT_ONE_LINE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** The trimmed label, or `null` when it is not 1 to 80 characters of one-line text. */
function batchLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  const length = [...label].length;
  if (length < 1 || length > MAX_BATCH_LABEL || NOT_ONE_LINE.test(label))
    return null;
  return label;
}

/** `count`: an integer from 1 to {@link MAX_BATCH_COUNT}. */
function batchCount(raw: unknown): number | null {
  return typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    raw <= MAX_BATCH_COUNT
    ? raw
    : null;
}

/** `expiresAt` as the single create reads it, but refused when it is neither a number nor `null`. */
function invalidExpiresAt(body: Record<string, unknown>): boolean {
  if (!("expiresAt" in body) || body.expiresAt === null) return false;
  return (
    typeof body.expiresAt !== "number" || !Number.isInteger(body.expiresAt)
  );
}

export async function handleBatches(
  ctx: LicenseAdminContext,
  rest: string[],
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;
  const [id, action, ...extra] = rest;
  if (extra.length > 0) return adminNotFound();

  // /batches
  if (!id) {
    if (req.method === "GET") return listBatches(ctx);
    if (req.method === "POST") return createBatch(ctx);
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  const batch = await getLicenseBatch(db, slug, id);
  if (!batch) return adminNotFound();

  // /batches/<id>
  if (!action) {
    if (req.method === "GET") return adminJson(batch);
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  // /batches/<id>/disable-unused
  if (action === "disable-unused") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    // LX-30: the console's typed confirmation, checked here when it is sent (an older caller may
    // send no body; a stated value must be the label, exactly).
    const body = await readBody(req);
    if ("confirm" in body && body.confirm !== batch.label)
      return err(400, ErrorCode.BadRequest, "type the batch label to confirm", {
        reason: "confirm_required",
        fields: ["confirm"],
      });
    const disabled = await disableUnused(db, slug, batch, session, now);
    // An unused licence has no device, so this is normally nothing. It purges a device bound in
    // the instant around the UPDATE, as the single disable purges its licence's devices.
    for (const tokenHash of await batchDisabledDeviceTokens(
      db,
      slug,
      id,
      session.sub,
      now,
    ))
      await deleteTokenRecord(ctx.env, slug, tokenHash);
    return adminJson({ disabled });
  }

  return adminNotFound();
}

/** `GET /batches?limit=&cursor=`: a page of the list (LX-30). */
async function listBatches(ctx: LicenseAdminContext): Promise<Response> {
  const url = new URL(ctx.req.url);
  const rawLimit = url.searchParams.get("limit");
  const rawCursor = url.searchParams.get("cursor");
  let limit: number | undefined;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || n < 1 || n > BATCH_PAGE_MAX)
      return err(
        400,
        ErrorCode.BadRequest,
        `limit must be an integer from 1 to ${BATCH_PAGE_MAX}`,
        { fields: ["limit"] },
      );
    limit = n;
  }
  let after: { createdAt: number; id: string } | undefined;
  if (rawCursor !== null && rawCursor !== "") {
    const decoded = decodeBatchCursor(rawCursor);
    if (!decoded)
      return err(400, ErrorCode.BadRequest, "cursor is not valid", {
        fields: ["cursor"],
      });
    after = decoded;
  }
  return adminJson(
    await listLicenseBatches(ctx.db, ctx.product.slug, {
      ...(limit !== undefined ? { limit } : {}),
      ...(after ? { after } : {}),
    }),
  );
}

/** Attempts at a Disable unused keys whose count moved between the read and the batch. */
const DISABLE_ATTEMPTS = 3;

/**
 * Disable unused keys: the audit row (`license.batch.disable_unused`, with the count) and the
 * UPDATE commit in ONE batch. The audit row is written only while the batch still has the count
 * just read (`unusedCountIs`), and the UPDATE runs only after it (`changes()`), so the row always
 * records what the UPDATE did. A device bound between the read and the batch moves the count:
 * nothing is written and the count is read again.
 */
async function disableUnused(
  db: Db,
  slug: string,
  batch: LicenseBatchView,
  session: AdminSession,
  now: number,
): Promise<number> {
  for (let attempt = 0; attempt < DISABLE_ATTEMPTS; attempt++) {
    const expected = await countUnusedBatchLicenses(db, slug, batch.id);
    const statements: DbStatement[] = [
      auditStatementFor(
        slug,
        session,
        now,
        "license.batch.disable_unused",
        { kind: "license_batch", id: batch.id },
        `Disabled ${expected} unused ${expected === 1 ? "license" : "licenses"} of batch ${JSON.stringify(batch.label)}`,
        unusedCountIs(slug, batch.id, expected),
      ),
      disableUnusedAfterAuditStatement(slug, batch.id, session.sub, now),
    ];
    const [audited, disabled] = await batchChanges(db, statements);
    if (audited === 1) return disabled ?? 0;
  }
  throw new Error(
    "disable-unused: the batch's unused count kept changing; try again",
  );
}

/** `db.batchChanges` (both real engines); a test double without it runs the statements in turn. */
async function batchChanges(
  db: Db,
  statements: DbStatement[],
): Promise<number[]> {
  if (db.batchChanges) return db.batchChanges(statements);
  const out: number[] = [];
  for (const st of statements)
    out.push(await db.runChanges(st.sql, ...st.params));
  return out;
}

async function createBatch(ctx: LicenseAdminContext): Promise<Response> {
  const { req, env, db, product, session, now } = ctx;
  const slug = product.slug;
  const body = await readBody(req);

  const holderFields = HOLDER_FIELDS.filter((f) => f in body);
  if (holderFields.length > 0)
    return err(
      422,
      ErrorCode.BadRequest,
      "a batch creates floating licenses: name, email and profiles cannot be set",
      { fields: holderFields },
    );
  const refused = new WriteChecks()
    .text("label", body.label)
    .channels("channels", body.channels)
    .semver("minVersion", body.minVersion)
    .semver("maxVersion", body.maxVersion)
    .offlineDays("maxOfflineDays", body.maxOfflineDays)
    .wireInteger("deviceLimit", body.deviceLimit)
    .wireInteger("expiresAt", body.expiresAt)
    .response();
  if (refused) return refused;
  const label = batchLabel(body.label);
  if (label === null)
    return err(
      422,
      ErrorCode.BadRequest,
      `label must be 1 to ${MAX_BATCH_LABEL} characters on one line`,
      { fields: ["label"] },
    );
  const count = batchCount(body.count);
  if (count === null)
    return err(
      422,
      ErrorCode.BadRequest,
      `count must be an integer from 1 to ${MAX_BATCH_COUNT}`,
      { fields: ["count"] },
    );
  if (invalidLicenseDeviceLimit(body))
    return err(
      422,
      ErrorCode.BadRequest,
      "deviceLimit must be a positive integer or null",
      { fields: ["deviceLimit"] },
    );
  if (invalidExpiresAt(body))
    return err(
      422,
      ErrorCode.BadRequest,
      "expiresAt must be epoch seconds or null",
      { fields: ["expiresAt"] },
    );
  const tier =
    typeof body.tier === "string" && body.tier !== ""
      ? await getTier(db, slug, body.tier)
      : null;
  if (!tier)
    return err(
      422,
      ErrorCode.BadRequest,
      typeof body.tier === "string" && body.tier !== ""
        ? "unknown reference"
        : "tier is required",
      { fields: ["tier"] },
    );

  // As the single create (R3-06): a stated `expiresAt` (a number, or `null` for never) is obeyed;
  // none takes the tier's policy.
  const expiresAt =
    "expiresAt" in body
      ? typeof body.expiresAt === "number"
        ? body.expiresAt
        : null
      : tierExpiresAt(tier, now);
  const batchRow: LicenseBatchRow = {
    product: slug,
    id: randomId("batch"),
    label,
    count,
    tier_id: tier.id,
    created_by: session.sub,
    created_at: now,
  };
  // Every key minted here is answered once, below, and stored only as its peppered hash.
  const minted = await Promise.all(
    Array.from({ length: count }, async () => {
      const key = mintLicenseKey(slug);
      return {
        licenseId: randomId("lic"),
        key,
        keyHash: await hashKey(key, env.KEY_HASH_PEPPER),
      };
    }),
  );
  const rows: BatchLicenseKey[] = minted.map(({ licenseId, keyHash }) => ({
    licenseId,
    keyHash,
  }));
  // The holder the statements write (no account, no email), read through the one holder rule.
  const holder = describeHolder(
    licenseHolder({ account_id: null, email: null }),
  );

  await db.batch([
    ...createBatchStatements(
      batchRow,
      {
        tierId: tier.id,
        expiresAt,
        maxOfflineDays:
          typeof body.maxOfflineDays === "number" ? body.maxOfflineDays : null,
        channelsJson: parseChannels(body.channels),
        minVersion:
          typeof body.minVersion === "string" ? body.minVersion : null,
        maxVersion:
          typeof body.maxVersion === "string" ? body.maxVersion : null,
        deviceLimit:
          typeof body.deviceLimit === "number" ? body.deviceLimit : null,
      },
      rows,
    ),
    auditStatementFor(
      slug,
      session,
      now,
      "license.batch.create",
      { kind: "license_batch", id: batchRow.id },
      `Created batch ${JSON.stringify(label)} of ${count} ${count === 1 ? "license" : "licenses"} (tier: ${tier.id}, holder: ${holder})`,
    ),
  ]);

  return adminJson(
    {
      batchId: batchRow.id,
      licenses: minted.map(({ licenseId, key }) => ({ licenseId, key })),
      batch: await getLicenseBatch(db, slug, batchRow.id),
      expiresAt,
    },
    201,
  );
}
