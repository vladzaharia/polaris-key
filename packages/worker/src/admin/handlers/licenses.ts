/**
 * Licenses (`/api/products/<slug>/licenses/...`): list/create, detail/patch, enable/disable,
 * catalog-validated override batches, and the keys/devices sub-resources. Creating a license
 * mints its first key (returned ONCE). Override values validate against the active catalog.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import { hashKey, mintLicenseKey, randomId } from "../../crypto.js";
import { deleteTokenRecord } from "../../kv.js";
import {
  countActiveDevices,
  getDeviceFacts,
  getFingerprint,
  getLicense,
  getTier,
  insertLicense,
  insertKey,
  listKeysByLicense,
  listLicenseProfiles,
  listDevicesByLicense,
  setLicenseProfiles,
} from "../../repo.js";
import {
  listLicenses,
  listProfiles,
  listTiers,
  patchLicense,
  setLicenseStatus,
} from "../repo.js";
import { tierExpiresAt } from "../../licenseCore.js";
import { shapeFacts, shapeFingerprint } from "../lib/deviceShape.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";
import { redactPayload, parsePayload } from "../lib/redact.js";
import { applyOverrides, type OverrideUpdate } from "../lib/overrides.js";
import {
  licenseSummary,
  loadCatalog,
  parseJsonColumn,
  parseJsonList,
} from "../lib/shape.js";
import { handleKeys } from "./keys.js";
import { handleAdminDevices } from "./devices.js";

/** Normalize a request-body `channels` field into a JSON string array column value.
 *  An array (even empty) is stored as JSON; anything else (absent/null) clears the column. */
function parseChannels(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const channels = raw.filter((c) => typeof c === "string") as string[];
  return JSON.stringify(channels);
}

function parseProfiles(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.profiles)) {
    return body.profiles.filter((p) => typeof p === "string") as string[];
  }
  return typeof body.profile === "string" && body.profile ? [body.profile] : [];
}

async function validateRefs(
  db: Db,
  slug: string,
  refs: { tier?: unknown; profiles?: string[] },
): Promise<string[]> {
  const fields: string[] = [];
  if (typeof refs.tier === "string") {
    const tiers = await listTiers(db, slug);
    if (!tiers.some((t) => t.id === refs.tier)) fields.push("tier");
  }
  if (refs.profiles && refs.profiles.length > 0) {
    const profiles = new Set((await listProfiles(db, slug)).map((p) => p.id));
    refs.profiles.forEach((p, i) => {
      if (!profiles.has(p)) fields.push(`profiles.${i}`);
    });
  }
  return fields;
}

export async function handleLicenses(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  const [id, sub, subId, action] = rest;

  // /licenses
  if (!id) {
    if (req.method === "GET") {
      const rows = await listLicenses(db, slug);
      const licenses = await Promise.all(
        rows.map((r) => licenseSummary(db, slug, r)),
      );
      return adminJson({ licenses });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const licenseId = randomId("lic");
      const profiles = parseProfiles(body);
      const badRefs = await validateRefs(db, slug, {
        tier: body.tier,
        profiles,
      });
      if (badRefs.length)
        return err(422, ErrorCode.BadRequest, "unknown reference", {
          fields: badRefs,
        });
      // R3-06: an operator who states `expiresAt` (a number, or an explicit `null` for "never")
      // is obeyed; an operator who says nothing gets the tier's policy, exactly as `/enroll`
      // and the OIDC path already do. Previously an omitted field meant PERMANENT, so a trial
      // tier minted through the admin API was never time boxed.
      const tierRow =
        typeof body.tier === "string"
          ? await getTier(db, slug, body.tier)
          : null;
      await insertLicense(db, {
        product: slug,
        id: licenseId,
        status: "active",
        sub: null,
        name: typeof body.name === "string" ? body.name : null,
        email: typeof body.email === "string" ? body.email : null,
        groups_json: null,
        tier_id: typeof body.tier === "string" ? body.tier : null,
        activated_at: now,
        expires_at:
          "expiresAt" in body
            ? typeof body.expiresAt === "number"
              ? body.expiresAt
              : null
            : tierExpiresAt(tierRow, now),
        max_offline_days:
          typeof body.maxOfflineDays === "number" ? body.maxOfflineDays : null,
        overrides_json: JSON.stringify({
          config: {},
          secrets: {},
          entitlements: {},
        }),
        channels_json: parseChannels(body.channels),
        min_version:
          typeof body.minVersion === "string" ? body.minVersion : null,
        max_version:
          typeof body.maxVersion === "string" ? body.maxVersion : null,
        modified_by: session.sub,
        modified_at: now,
      });
      if (profiles.length > 0)
        await setLicenseProfiles(db, slug, licenseId, profiles);
      // Mint the first key — returned ONCE, only here.
      const key = mintLicenseKey(slug);
      const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
      await insertKey(db, {
        product: slug,
        key_hash: keyHash,
        license_id: licenseId,
        status: "active",
        label: "Initial key",
        created_at: now,
        created_by: session.sub,
        last_used_at: null,
      });
      await audit(
        db,
        slug,
        session,
        now,
        "license.create",
        { kind: "license", id: licenseId },
        `Created license for ${body.email ?? body.name ?? licenseId}`,
      );
      const row = await getLicense(db, slug, licenseId);
      return adminJson(
        {
          licenseId,
          key,
          license: row ? await licenseSummary(db, slug, row) : null,
        },
        201,
      );
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  const license = await getLicense(db, slug, id);
  if (!license) return notFound();
  const catalog = await loadCatalog(db, slug);

  // /licenses/<id>
  if (!sub) {
    if (req.method === "GET") {
      const keys = await listKeysByLicense(db, slug, id);
      const devices = await listDevicesByLicense(db, slug, id);
      const profiles = await listLicenseProfiles(db, slug, id);
      const overrides = parsePayload(license.overrides_json);
      return adminJson({
        ...(await licenseSummary(db, slug, license)),
        // R11-06: guarded reads — a corrupt column degrades to empty/undefined, never a 500.
        groups: parseJsonList(license.groups_json),
        profiles: profiles.map((p) => p.profile_id),
        maxOfflineDays: license.max_offline_days,
        overrides: redactPayload(overrides, catalog),
        keys: keys.map((k) => ({
          hash: k.key_hash,
          status: k.status,
          label: k.label ?? undefined,
          createdAt: k.created_at,
          createdBy: k.created_by ?? "",
          lastUsedAt: k.last_used_at ?? undefined,
        })),
        devices: await Promise.all(
          devices.map(async (m) => ({
            deviceId: m.device_id,
            status: m.status,
            firstSeen: m.first_seen,
            lastSeen: m.last_seen,
            ua: m.ua ?? undefined,
            label: m.label ?? undefined,
            platform: m.platform ?? undefined,
            arch: m.arch ?? undefined,
            appVersion: m.app_version ?? undefined,
            sdkName: m.sdk_name ?? undefined,
            sdkVersion: m.sdk_version ?? undefined,
            reported: parseJsonColumn<unknown>(m.reported_json) ?? undefined,
            fingerprint: shapeFingerprint(
              await getFingerprint(db, slug, m.device_id),
            ),
            facts: shapeFacts(await getDeviceFacts(db, slug, m.device_id)),
          })),
        ),
      });
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const profiles = parseProfiles(body);
      const badRefs = await validateRefs(db, slug, {
        tier: body.tier,
        profiles,
      });
      if (badRefs.length)
        return err(422, ErrorCode.BadRequest, "unknown reference", {
          fields: badRefs,
        });

      // A tier change IS the remote re-licensing action, so it gets its own audit entry
      // recording old → new rather than being buried in a generic "Updated license".
      const changedTier =
        "tier" in body && (body.tier ?? null) !== license.tier_id;

      // R3-06: re-derive the expiry from the NEW tier whenever the tier moves and the operator
      // did not state an expiry explicitly. Without this, trial→paid kept the trial's
      // `expires_at` and expired a paying customer days after they paid, and paid→trial left a
      // time-boxed tier perpetual. An explicit `expiresAt` (number, or `null` for "never")
      // still wins — this only fills in the field the operator left unsaid.
      let expiresAt: number | null | undefined =
        body.expiresAt === null
          ? null
          : typeof body.expiresAt === "number"
            ? body.expiresAt
            : undefined;
      if (expiresAt === undefined && changedTier) {
        const nextTier =
          typeof body.tier === "string"
            ? await getTier(db, slug, body.tier)
            : null;
        expiresAt = tierExpiresAt(nextTier, now);
      }

      await patchLicense(
        db,
        slug,
        id,
        {
          name: typeof body.name === "string" ? body.name : undefined,
          email: typeof body.email === "string" ? body.email : undefined,
          expires_at: expiresAt,
          max_offline_days:
            typeof body.maxOfflineDays === "number"
              ? body.maxOfflineDays
              : undefined,
          tier_id:
            body.tier === null
              ? null
              : typeof body.tier === "string"
                ? body.tier
                : undefined,
          channels_json:
            "channels" in body ? parseChannels(body.channels) : undefined,
          min_version:
            body.minVersion === null
              ? null
              : typeof body.minVersion === "string"
                ? body.minVersion
                : undefined,
          max_version:
            body.maxVersion === null
              ? null
              : typeof body.maxVersion === "string"
                ? body.maxVersion
                : undefined,
        },
        session.sub,
        now,
      );
      if ("profiles" in body || "profile" in body)
        await setLicenseProfiles(db, slug, id, profiles);

      if (changedTier) {
        await audit(
          db,
          slug,
          session,
          now,
          "license.tier.change",
          { kind: "license", id },
          `Changed tier for ${id}: ${license.tier_id ?? "none"} → ${
            (body.tier as string | null) ?? "none"
          }`,
        );
      }
      await audit(
        db,
        slug,
        session,
        now,
        "license.update",
        { kind: "license", id },
        `Updated license ${id}`,
      );

      // Downgrading below the active device count doesn't evict anyone: authorizeDevice only
      // checks the limit on a NEW authorization, so existing devices are grandfathered and
      // new ones are refused until the count drops. Report both numbers so the UI can say so
      // rather than leaving the operator to discover it.
      let overLimit: { deviceCount: number; deviceLimit: number } | undefined;
      if (changedTier) {
        const nextTierId = (body.tier as string | null) ?? null;
        const nextTier = nextTierId
          ? await listTiers(db, slug).then((ts) =>
              ts.find((t) => t.id === nextTierId),
            )
          : undefined;
        const limit = nextTier?.policy_device_limit;
        if (typeof limit === "number" && limit > 0) {
          const deviceCount = await countActiveDevices(db, slug, id);
          if (deviceCount > limit) {
            overLimit = { deviceCount, deviceLimit: limit };
          }
        }
      }
      return adminJson({ ok: true, id, ...(overLimit ? { overLimit } : {}) });
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  // /licenses/<id>/disable | enable
  if (sub === "disable" || sub === "enable") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const status = sub === "disable" ? "disabled" : "active";
    await setLicenseStatus(db, slug, id, status, session.sub, now);
    if (sub === "disable") {
      // Purge hot-path bearer tokens immediately so disabled credentials stop authenticating
      // right away, instead of waiting for the next licenseUsable() check on a cached token.
      const devices = await listDevicesByLicense(db, slug, id);
      for (const m of devices) {
        if (m.token_hash) await deleteTokenRecord(env, slug, m.token_hash);
      }
    }
    await audit(
      db,
      slug,
      session,
      now,
      `license.${sub}`,
      { kind: "license", id },
      `${sub === "disable" ? "Disabled" : "Enabled"} license ${id}`,
    );
    return adminJson({ ok: true, id, status });
  }

  // /licenses/<id>/overrides (PUT batch)
  if (sub === "overrides") {
    if (req.method !== "PUT")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    if (!catalog) return err(409, ErrorCode.BadRequest, "no active catalog");
    const body = await readBody(req);
    const updates = Array.isArray(body.updates)
      ? (body.updates as OverrideUpdate[])
      : [];
    const result = await applyOverrides(
      env,
      slug,
      parsePayload(license.overrides_json),
      updates,
      catalog,
      now,
    );
    if (!result.ok)
      return err(422, ErrorCode.BadRequest, "validation failed", {
        fields: result.fields,
      });
    await patchLicense(
      db,
      slug,
      id,
      { overrides_json: JSON.stringify(result.payload) },
      session.sub,
      now,
    );
    await audit(
      db,
      slug,
      session,
      now,
      "license.overrides",
      { kind: "license", id },
      `Updated overrides for ${id}`,
    );
    return adminJson({ ok: true, id });
  }

  // /licenses/<id>/keys ...
  if (sub === "keys") {
    return handleKeys(req, env, db, session, slug, id, subId, action, now);
  }

  // /licenses/<id>/devices[/<deviceId>[/fingerprint/reset]]
  if (sub === "devices") {
    return handleAdminDevices(
      req,
      env,
      db,
      session,
      slug,
      id,
      subId,
      now,
      action,
    );
  }

  return notFound();
}
