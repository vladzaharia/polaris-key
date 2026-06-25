/**
 * Licenses (`/api/products/<slug>/licenses/...`): list/create, detail/patch, enable/disable,
 * catalog-validated override batches, and the keys/machines sub-resources. Creating a license
 * mints its first key (returned ONCE). Override values validate against the active catalog.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { hashKey, mintLicenseKey, randomId } from "../../crypto.js";
import { deleteTokenRecord, putKeyRecord } from "../../kv.js";
import {
  getLicense,
  insertLicense,
  insertKey,
  listKeysByLicense,
  listLicenseProfiles,
  listMachinesByLicense,
  setLicenseProfiles,
} from "../../repo.js";
import { listLicenses, patchLicense, setLicenseStatus } from "../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";
import { redactPayload, parsePayload } from "../lib/redact.js";
import { applyOverrides, type OverrideUpdate } from "../lib/overrides.js";
import { licenseSummary, loadCatalog } from "../lib/shape.js";
import { handleKeys } from "./keys.js";
import { handleMachines } from "./machines.js";

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
      await insertLicense(db, {
        product: slug,
        id: licenseId,
        status: "active",
        sub: null,
        name: typeof body.name === "string" ? body.name : null,
        email: typeof body.email === "string" ? body.email : null,
        groups_json: null,
        tier_id: typeof body.tier === "string" ? body.tier : null,
        profile_id: profiles[0] ?? null,
        enrolled_at: now,
        expires_at: typeof body.expiresAt === "number" ? body.expiresAt : null,
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
      await putKeyRecord(env, slug, keyHash, {
        product: slug,
        licenseId,
        status: "active",
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
      const machines = await listMachinesByLicense(db, slug, id);
      const profiles = await listLicenseProfiles(db, slug, id);
      const overrides = parsePayload(license.overrides_json);
      return adminJson({
        ...(await licenseSummary(db, slug, license)),
        groups: license.groups_json
          ? (JSON.parse(license.groups_json) as string[])
          : [],
        profiles: profiles.length
          ? profiles.map((p) => p.profile_id)
          : license.profile_id
            ? [license.profile_id]
            : [],
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
        machines: machines.map((m) => ({
          machineId: m.machine_id,
          status: m.status,
          firstSeen: m.first_seen,
          lastSeen: m.last_seen,
          ua: m.ua ?? undefined,
          label: m.label ?? undefined,
          reported: m.reported_json
            ? (JSON.parse(m.reported_json) as unknown)
            : undefined,
        })),
      });
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const profiles = parseProfiles(body);
      await patchLicense(
        db,
        slug,
        id,
        {
          name: typeof body.name === "string" ? body.name : undefined,
          email: typeof body.email === "string" ? body.email : undefined,
          expires_at:
            body.expiresAt === null
              ? null
              : typeof body.expiresAt === "number"
                ? body.expiresAt
                : undefined,
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
      await audit(
        db,
        slug,
        session,
        now,
        "license.update",
        { kind: "license", id },
        `Updated license ${id}`,
      );
      return adminJson({ ok: true, id });
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
      const machines = await listMachinesByLicense(db, slug, id);
      for (const m of machines) {
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
    const result = applyOverrides(
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

  // /licenses/<id>/machines ...
  if (sub === "machines") {
    return handleMachines(req, env, db, session, slug, id, subId, now);
  }

  return notFound();
}
