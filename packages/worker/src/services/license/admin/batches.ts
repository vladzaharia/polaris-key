/**
 * Licence batches (`/manage/api/products/<slug>/license/batches/...`, LX-28; notes/S-24 §5.6,
 * §6.3, §7.1, D10):
 *
 *   POST /batches                          create up to 500 floating licences in one labelled
 *                                          batch; the answer carries every key ONCE (`no-store`)
 *   GET  /batches                          every batch, newest first, with its used counts
 *   GET  /batches/<id>                     one batch
 *   POST /batches/<id>/disable-unused      disable every licence of the batch never used
 *
 * The data and the SQL are `../batches.ts`. Every licence of a batch is floating (no name, no
 * email, no account: the holder rule's `isFloatingLicense`), `origin = 'admin'`, and carries its
 * `batch_id`; the batch row, the licences, their keys and the audit row commit in one D1 batch or
 * not at all. The plaintext keys are in the create answer only: the Worker keeps their peppered
 * hashes and never answers them again. The console builds the CSV from that answer (LX-29).
 */

import { ErrorCode } from "../../../core/errors.js";
import {
  deleteTokenRecord,
  hashKey,
  mintLicenseKey,
  randomId,
} from "../../../core/platform.js";
import { getTier } from "../../../core/data.js";
import {
  adminJson,
  adminNotFound,
  audit,
  auditStatementFor,
  err,
  readBody,
  WriteChecks,
} from "../../../core/adminApi.js";
import { describeHolder, licenseHolder } from "../../../core/licenseHolders.js";
import { tierExpiresAt } from "../authz.js";
import {
  batchDisabledDeviceTokens,
  createBatchStatements,
  disableUnusedBatchLicenses,
  getLicenseBatch,
  listLicenseBatches,
  MAX_BATCH_COUNT,
  MAX_BATCH_LABEL,
  type BatchLicenseKey,
  type LicenseBatchRow,
} from "../batches.js";
import type { LicenseAdminContext } from "./index.js";
import { invalidLicenseDeviceLimit, parseChannels } from "./licenses.js";

/** Holder fields a batch refuses: its licences are floating (S-24 D1, D10). */
const HOLDER_FIELDS = ["name", "email", "profiles", "profile"] as const;

/** C0 and C1 control characters: a label is one line of display text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The trimmed label, or `null` when it is not 1 to 80 characters of one-line text. */
function batchLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  const length = [...label].length;
  if (length < 1 || length > MAX_BATCH_LABEL || CONTROL.test(label))
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
    if (req.method === "GET")
      return adminJson({ batches: await listLicenseBatches(db, slug) });
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
    const disabled = await disableUnusedBatchLicenses(
      db,
      slug,
      id,
      session.sub,
      now,
    );
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
    await audit(
      db,
      slug,
      session,
      now,
      "license.batch.disable_unused",
      { kind: "license_batch", id },
      `Disabled ${disabled} unused ${disabled === 1 ? "license" : "licenses"} of batch ${JSON.stringify(batch.label)}`,
    );
    return adminJson({ disabled });
  }

  return adminNotFound();
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
