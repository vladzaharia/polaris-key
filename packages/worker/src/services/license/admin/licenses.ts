/**
 * Licenses (`/manage/api/products/<slug>/license/licenses/...`): list/create, detail/patch/delete,
 * enable/disable, catalog-validated override batches, and the keys/devices sub-resources. Every
 * summary carries its deletion verdict (`deletion.ts`).
 * Creating a license mints its first key (returned ONCE). Override values validate against the
 * active catalog.
 *
 * LX-26 (notes/S-24 §5, §6.3): every licence read carries its derived `holder` (floating, or
 * assigned in an account or waiting) and the list filters on it (`?holder=`). A licence created
 * with an email, or given one by PATCH while floating, joins the account that verified that
 * address in the same request (Core's `associateLicenseHolder`, implemented by Identity); the
 * answer has the same shape whether or not one did (D4). Clearing an assigned licence's email is
 * refused: making a licence floating is the relink tool's Make floating (LX-30, I-12).
 *
 * LX-28: every licence read carries `batchId` (the batch it was created in, or `null`) and the
 * list filters on it (`?batch=`). Batches themselves are `batches.ts`.
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
  keyEntryListContext,
  licenseSummary,
  type KeyEntryListContext,
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
import { licenseEmail } from "../../../core/accountSubjects.js";
import {
  associateLicenseHolder,
  describeHolder,
  HOLDER_FILTERS,
  isHolderFilter,
  licenseHolder,
  type HolderFilter,
} from "../../../core/licenseHolders.js";
import {
  licenseDeviceLimit,
  licenseDeviceLimitInfo,
} from "../../../core/authz.js";
import type { LicenseRow } from "../../../core/data.js";
import type { LicenseAdminContext } from "./index.js";
import { handleKeys } from "./keys.js";
import { handleAdminDevices } from "./devices.js";
import { deletionVerdicts, handleDeleteLicense } from "./deletion.js";

/** Normalize a request-body `channels` field into a JSON string array column value.
 *  An array (even empty) is stored as JSON; anything else (absent/null) clears the column.
 *  Shared with the batch create (`batches.ts`, LX-28). */
export function parseChannels(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const channels = raw.filter((c) => typeof c === "string") as string[];
  return JSON.stringify(channels);
}

/**
 * LX-26: the email a create or PATCH body sets, trimmed. `undefined` = not set (absent, or not a
 * string and not `null`); `null` = none (an explicit `null`, or empty after trimming).
 */
function bodyEmail(body: Record<string, unknown>): string | null | undefined {
  if (!("email" in body)) return undefined;
  if (body.email === null) return null;
  if (typeof body.email !== "string") return undefined;
  const trimmed = body.email.trim();
  return trimmed === "" ? null : trimmed;
}

/** LX-26: the list's `?holder=` filter; `"invalid"` for a value outside `HOLDER_FILTERS`. */
function holderQuery(req: Request): HolderFilter | null | "invalid" {
  const raw = new URL(req.url).searchParams.get("holder");
  if (raw === null || raw === "") return null;
  return isHolderFilter(raw) ? raw : "invalid";
}

/** The context Core's licence-holder association needs, from this request. */
function holderContext(ctx: LicenseAdminContext) {
  return {
    db: ctx.db,
    env: ctx.env,
    now: ctx.now,
    origin: new URL(ctx.req.url).origin,
  };
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
    .wireInteger("deviceLimit", body.deviceLimit)
    .response();
}

/**
 * LX-14a: a licence's own `deviceLimit` is a positive integer, or `null` to inherit; absent keeps
 * it. Anything else (zero, a fraction, a string) is refused rather than silently ignored, the
 * same rule `invalidDeviceLimit` applies to a tier and 0084's CHECK applies at the database.
 * Shared with the batch create (`batches.ts`, LX-28).
 */
export function invalidLicenseDeviceLimit(
  body: Record<string, unknown>,
): boolean {
  if (!("deviceLimit" in body) || body.deviceLimit === null) return false;
  const v = body.deviceLimit;
  return typeof v !== "number" || !Number.isInteger(v) || v <= 0;
}

/** The device-limit fields every licence read carries (LX-14a): the stored value, the limit
 *  `authorizeDevice` enforces and where it comes from, and the inherited value the console's
 *  **Device limit…** sheet offers as its placeholder. */
async function deviceLimitView(
  ctx: LicenseAdminContext,
  license: LicenseRow,
): Promise<Record<string, unknown>> {
  const info = await licenseDeviceLimitInfo(
    ctx.db,
    ctx.product,
    license,
    ctx.now,
  );
  return {
    deviceLimit: license.device_limit ?? null,
    effectiveDeviceLimit: info.limit,
    deviceLimitSource: info.source,
    inheritedDeviceLimit: info.inherited.limit,
    inheritedDeviceLimitSource: info.inherited.source,
  };
}

/** PX-W9 on ST-04: the key-entry limit is resolved with the dispatcher's settings registry. */
function keyEntrySettings(ctx: LicenseAdminContext) {
  return { env: ctx.env, db: ctx.db, registry: ctx.settings };
}

async function summarize(
  ctx: LicenseAdminContext,
  license: LicenseRow,
  keyEntryContext?: KeyEntryListContext,
): Promise<Record<string, unknown>> {
  return {
    ...(await licenseSummary(
      ctx.db,
      ctx.product.slug,
      license,
      keyEntryContext ??
        (await keyEntryListContext(keyEntrySettings(ctx), ctx.product.slug)),
    )),
    ...(await deviceLimitView(ctx, license)),
  };
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
      const holder = holderQuery(req);
      if (holder === "invalid")
        return err(
          400,
          ErrorCode.BadRequest,
          `holder must be one of ${HOLDER_FILTERS.join(", ")}`,
          { fields: ["holder"] },
        );
      // LX-28: `?batch=<id>` lists one batch's licences (an unknown id lists none).
      const batch = new URL(req.url).searchParams.get("batch");
      const rows = await listLicenses(db, slug, {
        ...(holder ? { holder } : {}),
        ...(batch ? { batch } : {}),
      });
      const verdicts = await deletionVerdicts(ctx, rows);
      // PX-W9: the Identity toggle and the key-entry limit, read once for the whole list.
      const keyEntryContext = await keyEntryListContext(
        keyEntrySettings(ctx),
        slug,
      );
      const licenses = await Promise.all(
        rows.map(async (r) => ({
          ...(await summarize(ctx, r, keyEntryContext)),
          deletion: verdicts.get(r.id),
        })),
      );
      return adminJson({ licenses });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const refused = licenseWriteChecks(body);
      if (refused) return refused;
      // LX-14a: a new licence inherits its device limit; its own is set afterwards with PATCH
      // (audited as `license.device_limit.set`). Refused rather than silently dropped.
      if ("deviceLimit" in body)
        return err(
          422,
          ErrorCode.BadRequest,
          "deviceLimit cannot be set when creating a license; create it, then PATCH deviceLimit",
          { fields: ["deviceLimit"] },
        );
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
      // LX-26: an email makes the licence assigned (S-24 D1); none (absent, null or blank) makes
      // it floating. Stored trimmed, so the email match and the holder rule read the same value.
      const email = bodyEmail(body) ?? null;
      await insertLicense(db, {
        product: slug,
        id: licenseId,
        status: "active",
        sub: null,
        name: typeof body.name === "string" ? body.name : null,
        email,
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
      // LX-26 (S-24 D3): association at creation, in the same request, when an account has
      // verified the address. Identity runs the account lookup on every create with an email,
      // whatever the outcome; the answer below has the same shape either way (D4).
      if (email !== null)
        await associateLicenseHolder(holderContext(ctx), slug, licenseId);
      const row = await getLicense(db, slug, licenseId);
      const holder = licenseHolder(row ?? { account_id: null, email });
      await audit(
        db,
        slug,
        session,
        now,
        "license.create",
        { kind: "license", id: licenseId },
        `Created license for ${email ?? (typeof body.name === "string" && body.name ? body.name : licenseId)} (holder: ${describeHolder(holder)})`,
      );
      return adminJson(
        {
          licenseId,
          key,
          license: row ? await summarize(ctx, row) : null,
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
        ...(await summarize(ctx, license)),
        deletion: (await deletionVerdicts(ctx, [license])).get(id),
        // R11-06: guarded reads — a corrupt column degrades to empty/undefined, never a 500.
        groups: parseJsonList(license.groups_json),
        profiles: profiles.map((p) => p.profile_id),
        maxOfflineDays: license.max_offline_days,
        // LX-14a: the seat-holding devices with the dormancy cutoff `authorizeDevice` and the
        // PATCH's `overLimit` apply, so the console's Device limit… warning predicts the same.
        seatDeviceCount: await countActiveDevices(
          db,
          slug,
          id,
          seatActiveSince(now),
        ),
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
            subject: m.subject ?? null,
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
      if (invalidLicenseDeviceLimit(body))
        return err(
          422,
          ErrorCode.BadRequest,
          "deviceLimit must be a positive integer or null",
          { fields: ["deviceLimit"] },
        );
      // LX-26 (S-24 §6.3): setting an email on a floating licence assigns it; clearing the email
      // of a licence that has one is refused, because that would make it floating (or drop a
      // waiting holder) outside the relink tool's Make floating (I-12, LX-30). No new code.
      const nextEmail = bodyEmail(body);
      const currentEmail = licenseEmail(license);
      if (nextEmail === null && currentEmail !== null)
        return err(
          400,
          ErrorCode.BadRequest,
          "an assigned license's email cannot be cleared; use Make floating to remove its holder",
          { fields: ["email"] },
        );
      const emailChanged =
        typeof nextEmail === "string" && nextEmail !== currentEmail;
      const assigns =
        emailChanged && licenseHolder(license).kind === "floating";
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
      // LX-14a: the licence's own device limit, audited old → new like a tier change.
      const nextDeviceLimit =
        "deviceLimit" in body
          ? ((body.deviceLimit as number | null) ?? null)
          : undefined;
      const changedDeviceLimit =
        nextDeviceLimit !== undefined &&
        nextDeviceLimit !== (license.device_limit ?? null);

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
          // A string sets it (trimmed); `null` and blank were refused above unless the licence has
          // no email, where they change nothing.
          email: typeof nextEmail === "string" ? nextEmail : undefined,
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
          device_limit: nextDeviceLimit,
        },
        session.sub,
        now,
      );
      if ("profiles" in body || "profile" in body)
        await setLicenseProfiles(db, slug, id, profiles);

      if (assigns) {
        await audit(
          db,
          slug,
          session,
          now,
          "license.holder.assign",
          { kind: "license", id },
          `Assigned ${id} to ${nextEmail}`,
        );
      }
      // S-24 D3: a licence that has an email and no account joins the account that verified the
      // new address, if one did, as at creation. An in-account licence keeps its account.
      if (emailChanged && (license.account_id ?? null) === null)
        await associateLicenseHolder(holderContext(ctx), slug, id);

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
      if (changedDeviceLimit) {
        await audit(
          db,
          slug,
          session,
          now,
          "license.device_limit.set",
          { kind: "license", id },
          `Set device limit for ${id}: ${license.device_limit ?? "inherit"} → ${
            nextDeviceLimit ?? "inherit"
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

      // Lowering the limit below the active device count doesn't evict anyone: authorizeDevice
      // only checks the limit on a NEW authorization, so existing devices are grandfathered and
      // new ones are refused until the count drops. Report both numbers so the UI can say so
      // rather than leaving the operator to discover it. Whatever moved (the tier or the
      // licence's own limit), the number compared is the EFFECTIVE limit the next activation
      // will meet (LX-14a), not just the tier's.
      let overLimit: { deviceCount: number; deviceLimit: number } | undefined;
      if (changedTier || changedDeviceLimit) {
        const updated = await getLicense(db, slug, id);
        const limit = updated
          ? await licenseDeviceLimit(db, product, updated, now)
          : 0;
        if (limit > 0) {
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
