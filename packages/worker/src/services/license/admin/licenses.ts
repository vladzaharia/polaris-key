/**
 * Licenses (`/manage/api/products/<slug>/license/licenses/...`): list/create, detail/patch/delete,
 * enable/disable, catalog-validated override batches, and the keys/devices sub-resources. Every
 * summary carries its deletion verdict (`deletion.ts`).
 * Creating a license mints its first key (returned ONCE). Override values validate against the
 * active catalog.
 */

import type { Db } from "../../../core/platform.js";
import { ErrorCode } from "../../../core/errors.js";
import {
  deleteTokenRecord,
  hashKey,
  mintLicenseKey,
  randomId,
} from "../../../core/platform.js";
import {
  countActiveDevices,
  seatActiveSince,
  getDeviceFacts,
  getFingerprint,
  getLicense,
  getTier,
  insertKey,
  insertLicense,
  listDevicesByLicense,
  listKeysByLicense,
  listLicenseProfiles,
  setLicenseProfiles,
} from "../../../core/data.js";
import {
  adminJson,
  adminNotFound,
  applyOverrides,
  audit,
  err,
  licenseSummary,
  listLicenses,
  listProfiles,
  listTiers,
  loadCatalog,
  parseJsonColumn,
  parseJsonList,
  parsePayload,
  patchLicense,
  readBody,
  redactPayload,
  setLicenseStatus,
  shapeFacts,
  shapeFingerprint,
  type OverrideUpdate,
  WriteChecks,
} from "../../../core/adminApi.js";
import { tierExpiresAt } from "../authz.js";
import type { LicenseAdminContext } from "./index.js";
import { handleKeys } from "./keys.js";
import { handleAdminDevices } from "./devices.js";
import { deletionVerdicts, handleDeleteLicense } from "./deletion.js";

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

/**
 * The write checks a licence body's signed values take (plans/P3-01.md §2.2's inventory): the
 * name and email are free text the profile carries, the channels and version bounds the
 * manifest's patterns, and the offline-day count an integer from 1 to 365, the bundle mint's
 * rule (it becomes `graceUntil`).
 */
function licenseWriteChecks(body: Record<string, unknown>): Response | null {
  return new WriteChecks()
    .text("name", body.name)
    .text("email", body.email)
    .channels("channels", body.channels)
    .semver("minVersion", body.minVersion)
    .semver("maxVersion", body.maxVersion)
    .offlineDays("maxOfflineDays", body.maxOfflineDays)
    .response();
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
  ctx: LicenseAdminContext,
  rest: string[],
): Promise<Response> {
  const { req, env, db, product, session, now } = ctx;
  const slug = product.slug;
  const [id, sub, subId, action] = rest;

  // /licenses
  if (!id) {
    if (req.method === "GET") {
      const rows = await listLicenses(db, slug);
      const verdicts = await deletionVerdicts(ctx, rows);
      const licenses = await Promise.all(
        rows.map(async (r) => ({
          ...(await licenseSummary(db, slug, r)),
          deletion: verdicts.get(r.id),
        })),
      );
      return adminJson({ licenses });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const refused = licenseWriteChecks(body);
      if (refused) return refused;
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
  if (!license) return adminNotFound();
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
        deletion: (await deletionVerdicts(ctx, [license])).get(id),
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
      const refused = licenseWriteChecks(body);
      if (refused) return refused;
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
          // A-3: `null` clears the license's own value, so the tier or product default applies.
          max_offline_days:
            body.maxOfflineDays === null
              ? null
              : typeof body.maxOfflineDays === "number"
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
          // Counted with the SAME dormancy cutoff `authorizeDevice` applies: this warning
          // exists to predict activation outcomes, and a seat the check would reclaim is
          // not one the operator needs warning about.
          const deviceCount = await countActiveDevices(
            db,
            slug,
            id,
            seatActiveSince(now),
          );
          if (deviceCount > limit) {
            overLimit = { deviceCount, deviceLimit: limit };
          }
        }
      }
      return adminJson({ ok: true, id, ...(overLimit ? { overLimit } : {}) });
    }
    if (req.method === "DELETE") return handleDeleteLicense(ctx, license);
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
      return err(422, result.code, "validation failed", {
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
    return handleKeys(ctx, id, subId, action);
  }

  // /licenses/<id>/devices[/<deviceId>[/fingerprint/reset]]
  if (sub === "devices") {
    return handleAdminDevices(ctx, id, subId, action);
  }

  return adminNotFound();
}
