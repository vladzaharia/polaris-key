/**
 * Tiers (`/api/products/<slug>/tiers/...`): named policy bundles (a profile + expiry/device
 * limits) a license can be assigned. List/create, patch, and delete.
 */

import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { randomId } from "../../crypto.js";
import {
  countLicensesUsingTier,
  deleteTier,
  listProfiles,
  listTiers,
  upsertTier,
} from "../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";

/** Normalize a request-body `channels` field into a JSON string array column value, or null. */
function parseChannels(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  return JSON.stringify(raw.filter((c) => typeof c === "string") as string[]);
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
  req: Request,
  db: Db,
  session: AdminSession,
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
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
          channels: t.channels_json
            ? (JSON.parse(t.channels_json) as string[])
            : [],
          minVersion: t.min_version,
          maxVersion: t.max_version,
        })),
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const tierId = String(body.id ?? randomId("tier"));
      if (!(await profileExists(db, slug, body.profile)))
        return err(422, ErrorCode.BadRequest, "unknown profile", {
          fields: ["profile"],
        });
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
  if (!row) return notFound();
  if (req.method === "PATCH") {
    const body = await readBody(req);
    if ("profile" in body && !(await profileExists(db, slug, body.profile)))
      return err(422, ErrorCode.BadRequest, "unknown profile", {
        fields: ["profile"],
      });
    await upsertTier(db, {
      ...row,
      label: typeof body.label === "string" ? body.label : row.label,
      profile_id:
        typeof body.profile === "string" ? body.profile : row.profile_id,
      policy_expiry_days:
        typeof body.policyExpiryDays === "number"
          ? body.policyExpiryDays
          : row.policy_expiry_days,
      policy_device_limit:
        typeof body.policyDeviceLimit === "number"
          ? body.policyDeviceLimit
          : row.policy_device_limit,
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
