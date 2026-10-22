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
 * refused: making a licence floating is the relink tool's Make floating (LX-30, I-12). So is
 * changing it to another address: that is Reassign… (LX-30); a case-only edit stays a PATCH.
 *
 * LX-28: every licence read carries `batchId` (the batch it was created in, or `null`) and the
 * list filters on it (`?batch=`). Batches themselves are `batches.ts`.
 */

import { deleteTokenRecord } from "../../../platform/kv.js";
import { hashKey, mintLicenseKey, randomId } from "../../../platform/crypto.js";
import {
  parseJsonColumn,
  parseJsonStringList,
} from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import { ErrorCode } from "../../../core/errors.js";
import {
  countActiveDevices,
  seatActiveSince,
  getDeviceFacts,
  getFingerprint,
  listDevicesByLicense,
} from "../../../core/devices/store.js";
import {
  getLicense,
  getTier,
  insertKey,
  insertLicense,
  listKeysByLicense,
  listLicenseProfiles,
  setLicenseProfiles,
} from "../../../core/licensing/store.js";
import {
  adminJson,
  notFound as adminNotFound,
  err,
  readBody,
} from "../../../core/console/respond.js";
import {
  applyOverrides,
  type OverrideUpdate,
} from "../../../core/console/overrides.js";
import { audit } from "../../../core/audit.js";
import {
  keyEntryListContext,
  licenseSummaries,
  type KeyEntryListContext,
} from "../../../core/licensing/summary.js";
import {
  decodeLicenseCursor,
  LICENSE_PAGE_DEFAULT,
  LICENSE_PAGE_MAX,
  countLicenses,
  LICENSE_LIST_STATES,
  type LicenseListState,
  listLicensePage,
  type LicenseCursor,
  listProfiles,
  listTiers,
  patchLicense,
} from "../../../core/licensing/store.js";
import { loadCatalog } from "../../../core/activeCatalog.js";
import { parsePayload, redactPayload } from "../../../core/console/redact.js";
import {
  shapeFacts,
  shapeFingerprint,
} from "../../../core/console/deviceShape.js";
import {
  deviceLimitMessage,
  invalidDeviceLimit,
} from "../../../core/console/deviceLimit.js";
import { WriteChecks } from "../../../core/console/writeChecks.js";
import { tierExpiresAt } from "../../../core/licensing/authz.js";
import { issueTierFor } from "../../../core/licensing/implicitTier.js";
import {
  licenseEmail,
  subjectForOrNull,
} from "../../../core/accounts/accountSubjects.js";
import { portalEnabled } from "../../../core/licensing/manageUrl.js";
import { customerOrigin } from "../../../core/hosts.js";
import {
  associateLicenseHolder,
  HOLDER_FILTERS,
  isHolderFilter,
  licenseHolder,
  type HolderFilter,
} from "../../../core/licensing/licenseHolders.js";
import {
  licenseDeviceLimit,
  licenseTermsMany,
} from "../../../core/licensing/authz.js";
import type { LicenseTerms } from "../../../core/licensing/terms.js";
import {
  licenseEndedReasonOf,
  licenseStatusOf,
} from "../../../core/licensing/lifecycle.js";
import { transitionLicense } from "../../../core/licensing/lifecycleWrites.js";
import type { LicenseRow } from "../../../core/repo.js";
import { withIncludedChannels } from "../../../core/channels.js";
import type { LicenseAdminContext } from "./index.js";
import { handleKeys } from "./keys.js";
import { emailLicenseKey, handleSendKey } from "./keyEmail.js";
import {
  emailLicenseInvitation,
  handleSendInvite,
  inviteRefusal,
} from "./inviteEmail.js";
import { handleAdminDevices } from "./devices.js";
import { deletionVerdicts, handleDeleteLicense } from "./deletion.js";

/** Normalize a request-body `channels` field into a JSON string array column value.
 *  An array (even empty) is stored as JSON; anything else (absent/null) clears the column.
 *  Shared with the batch create (`batches.ts`, LX-28). */
export function parseChannels(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const channels = raw.filter((c) => typeof c === "string") as string[];
  return JSON.stringify(withIncludedChannels(channels));
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
    .expiresAt("expiresAt", body.expiresAt)
    .response();
}

/**
 * LX-14a: a licence's own `deviceLimit` is an integer from 1 to `MAX_DEVICE_LIMIT`, or `null` to
 * inherit; absent keeps it. Anything else (zero, a fraction, a string, a number past the
 * ceiling) is refused rather than silently ignored or clamped: the same rule `invalidDeviceLimit`
 * applies to a tier and a product default, 0084's CHECK applies at the database (its lower
 * bound), and the ceiling keeps `claimDeviceSeat`'s O(limit) seat scan bounded on this way in
 * too (`core/console/deviceLimit.ts` says why). Shared with the batch create (`batches.ts`,
 * LX-28).
 */
export function invalidLicenseDeviceLimit(
  body: Record<string, unknown>,
): boolean {
  if (!("deviceLimit" in body) || body.deviceLimit === null) return false;
  const v = body.deviceLimit;
  return typeof v !== "number" || invalidDeviceLimit(v);
}

/** The refusal both licence write paths answer a bad `deviceLimit` with. */
export function licenseDeviceLimitRefusal(): Response {
  return err(
    422,
    ErrorCode.BadRequest,
    `${deviceLimitMessage("deviceLimit")}, or null`,
    { fields: ["deviceLimit"] },
  );
}

/** The device-limit fields every licence read carries (LX-14a): the stored value, the limit
 *  `authorizeDevice` enforces and where it comes from, and the inherited value the console's
 *  **Device limit…** sheet offers as its placeholder. */
function deviceLimitFields(
  license: LicenseRow,
  terms: LicenseTerms,
): Record<string, unknown> {
  return {
    deviceLimit: license.device_limit ?? null,
    effectiveDeviceLimit: terms.deviceLimit.value,
    deviceLimitSource: terms.deviceLimit.source,
    inheritedDeviceLimit: terms.inheritedDeviceLimit.value,
    inheritedDeviceLimitSource: terms.inheritedDeviceLimit.source,
    // LX-32: every limit with the layer it came from (the console's Limits read-out).
    terms,
  };
}

/** PX-W9 on ST-04: the key-entry limit is resolved with the dispatcher's settings registry. */
function keyEntrySettings(ctx: LicenseAdminContext) {
  return { env: ctx.env, db: ctx.db, registry: ctx.settings };
}

/** The summaries of a set of licences: the page's reads are grouped over the set (P0-29). */
async function summarizeMany(
  ctx: LicenseAdminContext,
  licenses: readonly LicenseRow[],
  keyEntryContext?: KeyEntryListContext,
): Promise<Record<string, unknown>[]> {
  const context =
    keyEntryContext ??
    (await keyEntryListContext(keyEntrySettings(ctx), ctx.product.slug));
  const [summaries, terms] = await Promise.all([
    licenseSummaries(ctx.db, ctx.product.slug, licenses, context),
    licenseTermsMany(ctx.db, ctx.product, licenses, ctx.now),
  ]);
  return licenses.map((l, i) => ({
    ...summaries[i],
    ...deviceLimitFields(l, terms.get(l.id)!),
  }));
}

async function summarize(
  ctx: LicenseAdminContext,
  license: LicenseRow,
  keyEntryContext?: KeyEntryListContext,
): Promise<Record<string, unknown>> {
  return (await summarizeMany(ctx, [license], keyEntryContext))[0]!;
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

/**
 * The ownership facts the console's Config tab needs (U-03, notes/S-17 §5.12). The licence layer
 * is always read and always writable (U-27), so there is no phase:
 *
 *   - `owned`: whether an account owns the licence. An unowned licence has no account layer, so
 *     the console says "No account: managed config for this customer needs an account" and offers
 *     `signUpUrl`, the portal's Activate License page (an offer to the customer, never forced);
 *   - `ownerSubject`: the owner's subject for the Users-page link (created on first contact, as
 *     the licence summary's `ownerSubject` is).
 */
async function configOverridesView(
  ctx: LicenseAdminContext,
  license: LicenseRow,
): Promise<Record<string, unknown>> {
  const slug = ctx.product.slug;
  const owned = (license.account_id ?? null) !== null;
  const origin = customerOrigin(ctx.env, ctx.req);
  return {
    owned,
    ownerSubject: owned
      ? await subjectForOrNull(ctx.db, license.account_id!, slug, ctx.now)
      : null,
    signUpUrl:
      origin && (await portalEnabled(ctx.db, slug))
        ? `${origin}/activate?product=${encodeURIComponent(slug)}`
        : null,
  };
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
      const params = new URL(req.url).searchParams;
      const tier = params.get("tier");
      const rawState = params.get("state");
      if (
        rawState !== null &&
        rawState !== "" &&
        !(LICENSE_LIST_STATES as readonly string[]).includes(rawState)
      )
        return err(
          400,
          ErrorCode.BadRequest,
          `state must be one of ${LICENSE_LIST_STATES.join(", ")}`,
          { fields: ["state"] },
        );
      const state = (rawState || undefined) as LicenseListState | undefined;
      const rawLimit = params.get("limit");
      const rawCursor = params.get("cursor");
      let limit = LICENSE_PAGE_DEFAULT;
      if (rawLimit !== null) {
        const n = Number(rawLimit);
        if (!/^\d+$/.test(rawLimit) || n < 1 || n > LICENSE_PAGE_MAX)
          return err(
            400,
            ErrorCode.BadRequest,
            `limit must be an integer from 1 to ${LICENSE_PAGE_MAX}`,
            { fields: ["limit"] },
          );
        limit = n;
      }
      let after: LicenseCursor | undefined;
      if (rawCursor !== null && rawCursor !== "") {
        const decoded = decodeLicenseCursor(rawCursor);
        if (!decoded)
          return err(400, ErrorCode.BadRequest, "cursor is not valid", {
            fields: ["cursor"],
          });
        after = decoded;
      }
      const page = await listLicensePage(
        db,
        slug,
        {
          ...(holder ? { holder } : {}),
          ...(batch ? { batch } : {}),
          ...(tier ? { tier } : {}),
          ...(state ? { state, now } : {}),
        },
        { limit, ...(after ? { after } : {}) },
      );
      const rows = page.licenses;
      const verdicts = await deletionVerdicts(ctx, rows);
      // PX-W9: the Identity toggle and the key-entry limit, read once for the whole page.
      const keyEntryContext = await keyEntryListContext(
        keyEntrySettings(ctx),
        slug,
      );
      const summaries = await summarizeMany(ctx, rows, keyEntryContext);
      const licenses = rows.map((r, i) => ({
        ...summaries[i],
        deletion: verdicts.get(r.id),
      }));
      // The first page also carries what the filter matches and its state counts (one GROUP BY),
      // so the console can say how much it has not loaded.
      const totals = after
        ? {}
        : await countLicenses(
            db,
            slug,
            {
              ...(holder ? { holder } : {}),
              ...(batch ? { batch } : {}),
              ...(tier ? { tier } : {}),
              ...(state ? { state, now } : {}),
            },
            now,
          );
      // LX-27c.4 (L15): whether an invitation can reach a licence of this product, and why not,
      // on the first page (the console's wizard and record read this one fact).
      const invitationsOff = after ? undefined : await inviteRefusal(ctx);
      return adminJson({
        licenses,
        nextCursor: page.nextCursor,
        ...totals,
        ...(invitationsOff === undefined
          ? {}
          : {
              holders: { invitations: invitationsOff === null, invitationsOff },
            }),
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const refused = licenseWriteChecks(body);
      if (refused) return refused;
      // LX-14a/LX-27: a licence's own device limit may be set at creation (1 to the ceiling, or
      // null/absent to inherit); the effective limit follows LX-14a's precedence.
      if (invalidLicenseDeviceLimit(body)) return licenseDeviceLimitRefusal();
      // LX-27: `delivery: {email: true}` emails the first key to the licence's address in this
      // request. It needs an email (a floating key is never emailed, S-24 D11).
      const delivery = body.delivery;
      const deliveryShape = (
        d: unknown,
      ): d is { email?: boolean; invite?: boolean } =>
        typeof d === "object" &&
        d !== null &&
        !Array.isArray(d) &&
        (!("email" in d) || typeof d.email === "boolean") &&
        (!("invite" in d) || typeof d.invite === "boolean");
      if (delivery !== undefined && !deliveryShape(delivery))
        return err(
          422,
          ErrorCode.BadRequest,
          "delivery must be {email?: boolean, invite?: boolean}",
          {
            fields: ["delivery"],
          },
        );
      if ("key" in body && typeof body.key !== "boolean")
        return err(422, ErrorCode.BadRequest, "key must be a boolean", {
          fields: ["key"],
        });
      const emailDelivery =
        (delivery as { email?: boolean } | undefined)?.email === true;
      const inviteDelivery =
        (delivery as { invite?: boolean } | undefined)?.invite === true;
      const mintKey = body.key !== false;
      const refuseDelivery = (message: string, reason: string) =>
        err(422, ErrorCode.BadRequest, message, {
          fields: ["delivery"],
          reason,
        });
      if (emailDelivery && inviteDelivery)
        return refuseDelivery(
          "delivery.email and delivery.invite are exclusive",
          "email_and_invite",
        );
      if (!mintKey && !inviteDelivery)
        return refuseDelivery(
          "key: false needs delivery.invite",
          "key_false_without_invite",
        );
      if ((emailDelivery || inviteDelivery) && bodyEmail(body) == null)
        return err(
          422,
          ErrorCode.BadRequest,
          `delivery.${inviteDelivery ? "invite" : "email"} needs an email on the license`,
          { fields: ["delivery"] },
        );
      if (inviteDelivery) {
        const refusal = await inviteRefusal(ctx);
        if (refusal)
          return refuseDelivery(
            refusal === "identity_off"
              ? "an invitation needs Sign-in (Identity) on"
              : "an invitation needs auto-link on for this product",
            refusal,
          );
      }
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
        tier_id: await issueTierFor(
          db,
          slug,
          typeof body.tier === "string" ? body.tier : null,
        ),
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
        device_limit:
          typeof body.deviceLimit === "number" ? body.deviceLimit : null,
        modified_by: session.sub,
        modified_at: now,
      });
      if (profiles.length > 0)
        await setLicenseProfiles(db, slug, licenseId, profiles);
      // Mint the first key — returned ONCE, only here. `key: false` (an invitation only) mints none.
      const key = mintKey ? mintLicenseKey(slug) : null;
      if (key !== null)
        await insertKey(db, {
          product: slug,
          key_hash: await hashKey(key, env.KEY_HASH_PEPPER),
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
      // LX-27: the key email, in this request (the key exists in plaintext only here). A failure
      // never undoes the licence; the answer says `failed` and send-key tries again.
      const keyEmail =
        emailDelivery && row && key !== null
          ? await emailLicenseKey(ctx, row, key)
          : null;
      // LX-27c: the invitation, sent with no key. Same rule: a failure never undoes the licence.
      const invitation =
        inviteDelivery && row ? await emailLicenseInvitation(ctx, row) : null;
      const emailDelivered = keyEmail?.email ?? null;
      // The send stamped `invited_at`: read the row again so the answer carries it.
      const shown =
        invitation?.invite === "sent"
          ? await getLicense(db, slug, licenseId)
          : row;
      await audit(
        db,
        slug,
        session,
        now,
        "license.create",
        { kind: "license", id: licenseId },
        // The id, never the buyer's email or name (an audit row outlives erasure by up
        // to 180 days), nor whether an account took the licence, nor the key.
        `Created license ${licenseId} (${email !== null ? "assigned" : "floating"})` +
          (emailDelivered ? `, key email ${emailDelivered}` : "") +
          (invitation ? `, invitation ${invitation.invite}` : "") +
          (key === null ? ", no key" : ""),
      );
      return adminJson(
        {
          licenseId,
          ...(key !== null ? { key } : {}),
          ...(keyEmail
            ? {
                delivered: {
                  email: keyEmail.email,
                  ...(keyEmail.reason ? { reason: keyEmail.reason } : {}),
                },
              }
            : invitation
              ? {
                  delivered: {
                    invite: invitation.invite,
                    ...(invitation.reason ? { reason: invitation.reason } : {}),
                  },
                }
              : {}),
          // The answer is built as if no account had taken the licence, so a create
          // is not an oracle for "does this address have an account" (no `inAccount`, no
          // `ownerSubject`, whatever the association found).
          license: shown
            ? await summarize(ctx, { ...shown, account_id: null })
            : null,
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
      const configOverrides = await configOverridesView(ctx, license);
      return adminJson({
        ...(await summarize(ctx, license)),
        deletion: (await deletionVerdicts(ctx, [license])).get(id),
        // R11-06: guarded reads — a corrupt column degrades to empty/undefined, never a 500.
        groups: parseJsonStringList(license.groups_json),
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
        configOverrides,
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
      if (invalidLicenseDeviceLimit(body)) return licenseDeviceLimitRefusal();
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
      // LX-30 (S-24 D20): giving a licence that has an email to another address is Reassign…, the
      // relink tool's audited move (step-up, reason, notices, undo), never a PATCH. A case-only
      // edit of the same address stays allowed, as does a first email (Assign on a floating
      // licence, or a licence in an account that has none).
      if (
        typeof nextEmail === "string" &&
        currentEmail !== null &&
        nextEmail.trim().toLowerCase() !== currentEmail.trim().toLowerCase()
      )
        return err(
          400,
          ErrorCode.BadRequest,
          "this license already has an email; use Reassign to give it to someone else",
          { fields: ["email"] },
        );
      const emailChanged =
        typeof nextEmail === "string" && nextEmail !== currentEmail;
      const assigns =
        emailChanged && licenseHolder(license).kind === "floating";
      // LX-33.6: every licence has a tier. `null` used to mean "no tier"; it now has no meaning.
      if (body.tier === null)
        return err(422, ErrorCode.BadRequest, "a license always has a tier", {
          fields: ["tier"],
        });
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
          // The id, never the address.
          `Assigned ${id} to a new holder`,
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

  // /licenses/<id>/disable | enable — LX-12: Disable revokes the licence (`ended_reason`
  // `revoked`) and Enable reinstates it, through the lifecycle table. A refunded or charged-back
  // licence is not reinstated by an operator: only the store's reversal undoes a money end
  // (`core/licensing/lifecycle.ts` rule 3).
  if (sub === "disable" || sub === "enable") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const result = await transitionLicense(db, {
      product: slug,
      licenseId: id,
      event: sub === "disable" ? "revoke" : "reinstate",
      actor: session.sub,
      now,
    });
    if (!result) return adminNotFound();
    if (result.outcome === "refused")
      return err(
        409,
        ErrorCode.BadRequest,
        `a license that ended by ${result.from === "chargeback" ? "a chargeback" : "a refund"} is restored only by the store's reversal; issue a new license instead`,
        { endedReason: result.from },
      );
    const status = licenseStatusOf(result.to);
    if (sub === "disable") {
      // Purge hot-path bearer tokens immediately so disabled credentials stop authenticating
      // right away, instead of waiting for the next licenseUsable() check on a cached token.
      const devices = await listDevicesByLicense(db, slug, id);
      for (const m of devices) {
        if (m.token_hash) await deleteTokenRecord(env, slug, m.token_hash);
      }
    }
    // A licence already in the requested state is not changed again, and not audited again.
    if (result.changed)
      await audit(
        db,
        slug,
        session,
        now,
        `license.${sub}`,
        { kind: "license", id },
        `${sub === "disable" ? "Disabled" : "Enabled"} license ${id}`,
      );
    return adminJson({
      ok: true,
      id,
      status,
      endedReason: licenseEndedReasonOf(result.to),
    });
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
  if (sub === "send-key") return handleSendKey(ctx, license);
  if (sub === "send-invite") return handleSendInvite(ctx, license);

  if (sub === "keys") {
    return handleKeys(ctx, id, subId, action);
  }

  // /licenses/<id>/devices[/<deviceId>[/fingerprint/reset]]
  if (sub === "devices") {
    return handleAdminDevices(ctx, id, subId, action);
  }

  return adminNotFound();
}
