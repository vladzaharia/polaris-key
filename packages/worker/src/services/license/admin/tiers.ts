/**
 * Tiers (`/manage/api/products/<slug>/license/tiers/...`): named policy bundles (a profile +
 * expiry/device limits) a license can be assigned. List/create, patch, and delete.
 *
 * ST-01b: every console create or edit owns the row (`source = 'console'`, `upsertTier`), so a
 * resync never overwrites or deletes it; a manifest tier edited here is claimed.
 */

import type { Db } from "../../../core/platform.js";
import { ErrorCode } from "../../../core/errors.js";
import { randomId } from "../../../core/platform.js";
import {
  adminJson,
  adminNotFound,
  audit,
  countLicensesUsingTier,
  deleteTier,
  err,
  listProfiles,
  listTiers,
  parseJsonList,
  readBody,
  upsertTier,
  WriteChecks,
} from "../../../core/adminApi.js";
import type { LicenseAdminContext } from "./index.js";

/** Normalize a request-body `channels` field into a JSON string array column value, or null. */
function parseChannels(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  return JSON.stringify(raw.filter((c) => typeof c === "string") as string[]);
}

/**
 * R11-02 part 2 — a tier's device limit must be a real seat count.
 *
 * `licenseCore.ts` gates the whole seat check on `limit > 0`, so `PATCH {"policyDeviceLimit":
 * 0}` (or `-1`) did not mean "zero seats", it meant "UNLIMITED seats" for every license on the
 * tier — the core commercial control removed by one mistyped or fuzzed admin field. NULL still
 * means "inherit the product default". 0015_data_integrity.sql enforces the same rule at the
 * database; this returns 422 instead of letting an operator hit a constraint error.
 */
function invalidDeviceLimit(raw: unknown): boolean {
  return typeof raw === "number" && (!Number.isInteger(raw) || raw <= 0);
}

/**
 * The write checks a tier body's signed values take (plans/P3-01.md §2.2's inventory): the
 * label is free text, the channels and version bounds the manifest's patterns, the device limit
 * at most `MAX_WIRE_INTEGER` (the positive-integer rule is `invalidDeviceLimit`'s).
 */
function tierWriteChecks(body: Record<string, unknown>): WriteChecks {
  return new WriteChecks()
    .text("label", body.label)
    .channels("channels", body.channels)
    .semver("minVersion", body.minVersion)
    .semver("maxVersion", body.maxVersion)
    .wireInteger("policyDeviceLimit", body.policyDeviceLimit);
}

/** A PATCH field: `null` clears it, a value of `type` replaces it, anything else keeps it. */
function nullable<T>(
  raw: unknown,
  type: "string" | "number",
  stored: T | null,
): T | null {
  if (raw === null) return null;
  return typeof raw === type ? (raw as T) : stored;
}

async function profileExists(
  db: Db,
  slug: string,
  profile: unknown,
): Promise<boolean> {
  if (profile === null || profile === undefined) return true;
  if (typeof profile !== "string") return false;
  const profiles = await listProfiles(db, slug);
  return profiles.some((p) => p.id === profile);
}

export async function handleTiers(
  ctx: LicenseAdminContext,
  id: string | undefined,
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;
  if (!id) {
    if (req.method === "GET") {
      const rows = await listTiers(db, slug);
      return adminJson({
        tiers: rows.map((t) => ({
          id: t.id,
          label: t.label,
          profile: t.profile_id,
          policyExpiryDays: t.policy_expiry_days,
          policyDeviceLimit: t.policy_device_limit,
          // R11-06: guarded — a corrupt tiers.channels_json must not 500 the tier list.
          channels: parseJsonList(t.channels_json),
          minVersion: t.min_version,
          maxVersion: t.max_version,
          // ST-01b: who owns the row; a resync leaves `console` rows alone.
          source: t.source ?? "manifest",
        })),
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      // plans/P3-01.md §2.2: the tier id is the signed `license.tier`, its label
      // `license.tierLabel`, its channels and version bounds signed entitlements — each takes
      // the manifest's own rule. A generated id needs no check.
      const refused = tierWriteChecks(body).id("id", body.id).response();
      if (refused) return refused;
      const tierId = String(body.id ?? randomId("tier"));
      if (!(await profileExists(db, slug, body.profile)))
        return err(422, ErrorCode.BadRequest, "unknown profile", {
          fields: ["profile"],
        });
      if (invalidDeviceLimit(body.policyDeviceLimit))
        return err(
          422,
          ErrorCode.BadRequest,
          "policyDeviceLimit must be a positive integer",
          { fields: ["policyDeviceLimit"] },
        );
      await upsertTier(db, {
        product: slug,
        id: tierId,
        label: String(body.label ?? tierId),
        profile_id: typeof body.profile === "string" ? body.profile : null,
        policy_expiry_days:
          typeof body.policyExpiryDays === "number"
            ? body.policyExpiryDays
            : null,
        policy_device_limit:
          typeof body.policyDeviceLimit === "number"
            ? body.policyDeviceLimit
            : null,
        channels_json: parseChannels(body.channels),
        min_version:
          typeof body.minVersion === "string" ? body.minVersion : null,
        max_version:
          typeof body.maxVersion === "string" ? body.maxVersion : null,
        modified_by: session.sub,
        modified_at: now,
      });
      await audit(
        db,
        slug,
        session,
        now,
        "tier.create",
        { kind: "tier", id: tierId },
        `Created tier ${tierId}`,
      );
      return adminJson({ ok: true, id: tierId }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const row = await listTiers(db, slug).then(
    (rows) => rows.find((t) => t.id === id) ?? null,
  );
  if (!row) return adminNotFound();
  if (req.method === "PATCH") {
    const body = await readBody(req);
    const refused = tierWriteChecks(body).response();
    if (refused) return refused;
    if ("profile" in body && !(await profileExists(db, slug, body.profile)))
      return err(422, ErrorCode.BadRequest, "unknown profile", {
        fields: ["profile"],
      });
    if (invalidDeviceLimit(body.policyDeviceLimit))
      return err(
        422,
        ErrorCode.BadRequest,
        "policyDeviceLimit must be a positive integer",
        { fields: ["policyDeviceLimit"] },
      );
    // A-3: `null` clears a nullable field (no profile; the product's expiry and device-limit
    // defaults apply), an absent field keeps the stored value.
    await upsertTier(db, {
      ...row,
      label: typeof body.label === "string" ? body.label : row.label,
      profile_id: nullable(body.profile, "string", row.profile_id),
      policy_expiry_days: nullable(
        body.policyExpiryDays,
        "number",
        row.policy_expiry_days,
      ),
      policy_device_limit: nullable(
        body.policyDeviceLimit,
        "number",
        row.policy_device_limit,
      ),
      channels_json:
        "channels" in body ? parseChannels(body.channels) : row.channels_json,
      min_version:
        body.minVersion === null
          ? null
          : typeof body.minVersion === "string"
            ? body.minVersion
            : row.min_version,
      max_version:
        body.maxVersion === null
          ? null
          : typeof body.maxVersion === "string"
            ? body.maxVersion
            : row.max_version,
      modified_by: session.sub,
      modified_at: now,
    });
    await audit(
      db,
      slug,
      session,
      now,
      "tier.update",
      { kind: "tier", id },
      `Updated tier ${id}`,
    );
    return adminJson({ ok: true, id });
  }
  if (req.method === "DELETE") {
    const refs = await countLicensesUsingTier(db, slug, id);
    if (refs > 0)
      return err(409, ErrorCode.BadRequest, "tier is still referenced", {
        references: refs,
      });
    await deleteTier(db, slug, id);
    await audit(
      db,
      slug,
      session,
      now,
      "tier.delete",
      { kind: "tier", id },
      `Deleted tier ${id}`,
    );
    return adminJson({ ok: true, id });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}
