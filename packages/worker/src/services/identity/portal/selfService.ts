/**
 * PX-W5 — the portal's self-service additions (docs/design/PORTAL.md §10.2 G6, G7, G22):
 *
 * - `PATCH /api/licenses/<product>/<licenseId>/devices/<deviceId>` — rename one of your devices.
 * - `POST  /api/licenses/<product>/<licenseId>/keys` — get a new license key; the old one stops
 *   activating new devices. Per-product opt-in, recent sign-in required, shown once.
 * - `POST  /api/activate/preview` — what adding a key WOULD do, before it is added: the product,
 *   the tier and terms, the platforms, or a typed refusal.
 *
 * ── ONE EVALUATOR FOR THE PREVIEW AND THE CLAIM ─────────────────────────────────────────────
 *
 * `evaluateKeyClaim` is the only place the claim rules live. `POST /api/claim/license-key` acts on
 * its verdict and the preview reports it, so the preview can never promise an add the claim then
 * refuses, nor refuse one the claim would allow. The rules are the S-16 safety defaults the owner
 * confirmed (2026-10-04): an owned licence never moves by its key (`owned_elsewhere`), and a licence
 * that carries an email attaches only to an account with that email verified (`email_mismatch`),
 * unless the product sets `claimByKey`.
 *
 * ── ENUMERATION (THREAT-MODEL) ─────────────────────────────────────────────────────────────
 *
 * Nothing here can be reached without the WHOLE key: 128 random bits, so the preview is not a
 * key oracle. What it adds is what a key HOLDER learns, and that is kept to the design's list:
 * the product's public presentation, and for a licence they could add, its tier and terms. A
 * refusal never carries ownership details: `owned_elsewhere` says only that another account holds
 * it, and `email_mismatch` shows the first character and the domain of the address (§4.19). The
 * preview and the claim charge ONE rate bucket (`portalClaimKey`, per account), so previewing is
 * never a cheaper probe than adding.
 */

import {
  hashKey,
  mintLicenseKey,
  productFromKey,
  type Db,
  type Env,
} from "../../../core/platform.js";
import {
  getKey,
  getLicense,
  getProduct,
  getTier,
  replaceLicenseKeys,
  setDeviceLabel,
  getDevice,
  type LicenseRow,
} from "../../../core/data.js";
import { licenseDeviceLimit } from "../../../core/authz.js";
import { licenseUsable } from "../../../core/devices.js";
import { loadProductPublic } from "../../../core/products.js";
import { ErrorCode } from "../../../core/errors.js";
import {
  accountHasVerifiedEmail,
  getPortalLicense,
  getPortalProductSettings,
  licenseLinkedElsewhere,
  linkLicense,
  normalizeEmail,
  portalAudit,
  type PortalLicenseRow,
} from "./repo.js";
import { portalSessionAuthenticatedAt, type PortalSession } from "./session.js";
import { sendPortalNotice } from "./email.js";
import {
  err,
  notFound,
  portalJson,
  readBody,
  requireActionRateLimit,
  shapeLicenseSummary,
  type PortalHooksFor,
} from "./api.js";

// ── The claim rules ─────────────────────────────────────────────────────────────────────────

/** The shared rate bucket of the preview and the claim (§10.2: "same rate bucket as add"). */
export const CLAIM_BUCKET = "portalClaimKey";
export const CLAIM_LIMIT_PER_MINUTE = 10;

interface ProductFacts {
  slug: string;
  name: string;
  branding: unknown;
}

export type KeyClaimVerdict =
  /** Not the shape of a license key at all (`LICENSE_KEY_SHAPE`). Nothing was looked up. */
  | { kind: "invalid" }
  /**
   * No such product, no such key, the key was replaced or revoked, or its licence is gone. Never
   * carries the product's facts: a well-formed guess must not reveal whether a slug exists, or its
   * name and branding.
   */
  | { kind: "unknown"; product: null }
  /** The product does not manage licences in this portal (portal or key claim switched off). */
  | { kind: "portal_off"; product: ProductFacts }
  /** Already linked to this account. */
  | {
      kind: "already_yours";
      product: ProductFacts;
      license: PortalLicenseRow;
    }
  /** Linked to another account; an owned licence never moves by its key. */
  | { kind: "owned_elsewhere"; product: ProductFacts }
  /** Carries an email this account has not verified, and the product does not allow claim by key. */
  | { kind: "email_mismatch"; product: ProductFacts; maskedEmail: string }
  /** May be added. */
  | { kind: "addable"; product: ProductFacts; license: LicenseRow };

function parseJsonOrNull(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * `m•••@proton.me`: the first character of the local part and the domain, nothing else (§4.19).
 * Enough for the holder to recognise their own address, not enough to read someone else's.
 */
export function maskEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return "•••";
  return `${normalized[0]}•••@${normalized.slice(at + 1)}`;
}

export async function evaluateKeyClaim(
  env: Env,
  db: Db,
  accountId: string,
  key: string,
): Promise<KeyClaimVerdict> {
  const slug = productFromKey(key);
  if (!slug) return { kind: "invalid" };
  const productRow = await getProduct(db, slug);
  if (!productRow || productRow.status === "deleted") {
    return { kind: "unknown", product: null };
  }
  const product: ProductFacts = {
    slug,
    name: productRow.name,
    branding: parseJsonOrNull(productRow.branding_json),
  };
  const keyRow = await getKey(
    db,
    slug,
    await hashKey(key, env.KEY_HASH_PEPPER),
  );
  if (!keyRow || keyRow.status !== "active")
    return { kind: "unknown", product: null };
  const license = await getLicense(db, slug, keyRow.license_id);
  if (!license) return { kind: "unknown", product: null };

  const settings = await getPortalProductSettings(db, slug);
  if (
    settings.portal_enabled !== 1 ||
    settings.license_key_claim_enabled !== 1
  ) {
    return { kind: "portal_off", product };
  }
  const mine = await getPortalLicense(db, accountId, slug, license.id);
  if (mine) return { kind: "already_yours", product, license: mine };
  if (await licenseLinkedElsewhere(db, accountId, slug, license.id)) {
    return { kind: "owned_elsewhere", product };
  }
  const email = license.email?.trim();
  if (
    email &&
    settings.claim_by_key !== 1 &&
    !(await accountHasVerifiedEmail(db, accountId, email))
  ) {
    return { kind: "email_mismatch", product, maskedEmail: maskEmail(email) };
  }
  return { kind: "addable", product, license };
}

// ── G22: the activate preview ───────────────────────────────────────────────────────────────

/** The platforms the product's newest app release ships for (through Core's catalog hook). */
async function productPlatforms(
  db: Db,
  hooksFor: PortalHooksFor | undefined,
  slug: string,
  now: number,
): Promise<string[]> {
  if (!hooksFor) return [];
  const product = await loadProductPublic(db, slug);
  if (!product) return [];
  const catalog = hooksFor(product, now).releaseCatalog();
  if (!catalog) return [];
  try {
    // The app deliverable (`app` is its fixed id; a product with no deliverable rows yet still
    // keeps its releases under it), newest unyanked publication first.
    const newest = (await catalog.releases("app")).find((r) => !r.yanked);
    if (!newest) return [];
    const platforms = new Set<string>();
    for (const build of await catalog.builds(newest.releaseId)) {
      if (build.platform) platforms.add(build.platform);
    }
    return [...platforms].sort();
  } catch {
    // Platforms are a courtesy on the confirm step; a catalog that cannot answer never blocks it.
    return [];
  }
}

async function licenseTerms(
  db: Db,
  license: LicenseRow,
  now: number,
): Promise<Record<string, unknown>> {
  const product = await loadProductPublic(db, license.product);
  const tier = license.tier_id
    ? await getTier(db, license.product, license.tier_id)
    : null;
  return {
    tier: license.tier_id,
    tierLabel: tier?.label ?? null,
    status: license.status,
    usable: licenseUsable(license, now),
    expiresAt: license.expires_at,
    deviceLimit: product
      ? await licenseDeviceLimit(db, product, license, now)
      : null,
  };
}

function productView(
  product: ProductFacts | null,
): Record<string, unknown> | null {
  if (!product) return null;
  return {
    slug: product.slug,
    name: product.name,
    branding: product.branding,
    // G1's presentation (developer name and same-origin art through the media proxy) is PX-W1's;
    // the fields are reserved here so the confirm step binds to one shape before and after it lands.
    developerName: null,
    iconUrl: null,
    headerUrl: null,
  };
}

export async function handleActivatePreview(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  // Charged BEFORE any lookup, on the claim's own bucket: a preview costs exactly what an add costs.
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    CLAIM_BUCKET,
    now,
    CLAIM_LIMIT_PER_MINUTE,
  );
  if (limited) return limited;
  const body = await readBody(req);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const verdict = await evaluateKeyClaim(env, db, session.accountId, key);
  if (verdict.kind === "invalid") {
    return err(422, ErrorCode.BadRequest, "invalid license key");
  }
  const base = {
    verdict: verdict.kind,
    product: productView(verdict.product),
    // G21 (key-entry counting) is PX-W9's: until it lands no entry is counted, so none is reported.
    entries: null,
  };
  switch (verdict.kind) {
    case "addable":
      return portalJson({
        ...base,
        license: await licenseTerms(db, verdict.license, now),
        platforms: await productPlatforms(
          db,
          hooksFor,
          verdict.product.slug,
          now,
        ),
      });
    case "already_yours":
      return portalJson({
        ...base,
        license: {
          id: verdict.license.id,
          ...(await licenseTerms(db, verdict.license, now)),
        },
        platforms: await productPlatforms(
          db,
          hooksFor,
          verdict.product.slug,
          now,
        ),
      });
    case "email_mismatch":
      return portalJson({ ...base, maskedEmail: verdict.maskedEmail });
    default:
      return portalJson(base);
  }
}

// ── The claim, on the same verdict ──────────────────────────────────────────────────────────

export async function handleClaimKey(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    CLAIM_BUCKET,
    now,
    CLAIM_LIMIT_PER_MINUTE,
  );
  if (limited) return limited;
  const body = await readBody(req);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const verdict = await evaluateKeyClaim(env, db, session.accountId, key);
  switch (verdict.kind) {
    case "invalid":
      return err(422, ErrorCode.BadRequest, "invalid license key");
    case "unknown":
      return err(401, ErrorCode.Unauthorized, "license key not found");
    case "portal_off":
      return notFound();
    case "owned_elsewhere":
      return portalJson(
        {
          error: "owned_elsewhere",
          message: "license is held by another account",
        },
        409,
      );
    case "email_mismatch":
      return portalJson(
        {
          error: "email_mismatch",
          message: "license joins only the account with its email verified",
          maskedEmail: verdict.maskedEmail,
        },
        403,
      );
    case "already_yours":
      // Idempotent: nothing is written and nobody is emailed a second time.
      return portalJson({
        ok: true,
        license: await shapeLicenseSummary(db, verdict.license, now),
      });
    case "addable":
      break;
  }
  const { product, license } = verdict;
  await linkLicense(
    db,
    session.accountId,
    product.slug,
    license.id,
    "license-key",
    now,
  );
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.license.claim",
    product: product.slug,
    targetKind: "license",
    targetId: license.id,
    summary: "Claimed license with a license key",
    now,
  });
  await sendPortalNotice(
    env,
    session.email,
    "License added to your Polaris Key account",
    `A license for ${product.name} was added to your Polaris Key account.`,
  );
  // S-16: each attach notifies the licence's own email too, when it is a different address.
  if (
    license.email &&
    normalizeEmail(license.email) !== normalizeEmail(session.email)
  ) {
    await sendPortalNotice(
      env,
      license.email,
      "Your license was added to a Polaris Key account",
      `Your ${product.name} license was added to a Polaris Key account with its license key. ` +
        "If that wasn't you, contact the developer.",
    );
  }
  const portalRow = await getPortalLicense(
    db,
    session.accountId,
    product.slug,
    license.id,
  );
  return portalJson({
    ok: true,
    license: portalRow ? await shapeLicenseSummary(db, portalRow, now) : null,
  });
}

// ── G6: rename a device ─────────────────────────────────────────────────────────────────────

/** The longest device name the portal stores. Short enough for a row and a notice line. */
export const DEVICE_LABEL_MAX = 64;

/**
 * A device name is display text other people's code never interprets, but it lands in emails and
 * lists, so it is held to plain text: no control characters, no bidirectional overrides (which can
 * make "Studio PC" render as something else), trimmed, at most `DEVICE_LABEL_MAX` characters.
 * `null` clears the name. Answers `undefined` for a value that is not acceptable.
 */
export function parseDeviceLabel(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ([...trimmed].length > DEVICE_LABEL_MAX) return undefined;
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(trimmed)) return undefined;
  return trimmed;
}

export async function handleDeviceRename(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  licenseId: string,
  deviceId: string,
  now: number,
): Promise<Response> {
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return notFound();
  const license = await getPortalLicense(
    db,
    session.accountId,
    product,
    licenseId,
  );
  if (!license) return notFound();
  // Charged after ownership is proven and in this product's shard, like the disconnect (R5-05).
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalDeviceRename",
    now,
    30,
    product,
  );
  if (limited) return limited;
  const device = await getDevice(db, product, deviceId);
  if (!device || device.license_id !== licenseId) return notFound();
  const body = await readBody(req);
  if (!("label" in body)) {
    return err(422, ErrorCode.BadRequest, "label is required");
  }
  const label = parseDeviceLabel(body.label);
  if (label === undefined) {
    return err(
      422,
      ErrorCode.BadRequest,
      `label must be plain text of at most ${DEVICE_LABEL_MAX} characters`,
    );
  }
  await setDeviceLabel(db, product, deviceId, label);
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.device.rename",
    product,
    targetKind: "device",
    targetId: deviceId,
    summary: label
      ? `Renamed device ${deviceId}`
      : `Cleared the name of device ${deviceId}`,
    now,
  });
  return portalJson({ ok: true, device: { deviceId, label } });
}

// ── G7: get a new key ───────────────────────────────────────────────────────────────────────

/** How recent the sign-in must be to mint a new key (the portal's step-up, see session.ts). */
export const KEY_REISSUE_MAX_AUTH_AGE_SECONDS = 5 * 60;

export async function handleKeyReissue(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  licenseId: string,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const settings = await getPortalProductSettings(db, product);
  // Hidden, not refused, when the product has not opted in: the same 404 as a licence that is not
  // yours, so the route says nothing about a product's settings to a caller who cannot use it.
  if (settings.portal_enabled !== 1 || settings.key_reissue_enabled !== 1) {
    return notFound();
  }
  const license = await getPortalLicense(
    db,
    session.accountId,
    product,
    licenseId,
  );
  if (!license) return notFound();
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalKeyReissue",
    now,
    5,
    product,
    60 * 60,
  );
  if (limited) return limited;
  if (
    now - portalSessionAuthenticatedAt(session) >
    KEY_REISSUE_MAX_AUTH_AGE_SECONDS
  ) {
    return portalJson(
      {
        error: "step_up_required",
        message: "sign in again to get a new key",
        maxAgeSeconds: KEY_REISSUE_MAX_AUTH_AGE_SECONDS,
      },
      401,
    );
  }
  const key = mintLicenseKey(product);
  const hash = await hashKey(key, env.KEY_HASH_PEPPER);
  const revoked = await replaceLicenseKeys(db, {
    product,
    key_hash: hash,
    license_id: licenseId,
    status: "active",
    label: "Issued in the portal",
    created_at: now,
    created_by: `portal:${session.accountId}`,
    last_used_at: null,
  });
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.license.key_reissue",
    product,
    targetKind: "license",
    targetId: licenseId,
    summary: `Issued a new license key; ${revoked} old key${revoked === 1 ? "" : "s"} revoked`,
    now,
  });
  const notice =
    `A new license key for ${license.product_name} was made in your Polaris Key account. ` +
    "The old key no longer activates new devices; devices already using the product keep working. " +
    "If this wasn't you, sign in and get a new key again, then contact the developer.";
  await sendPortalNotice(
    env,
    session.email,
    "Your license has a new key",
    notice,
  );
  if (
    license.email &&
    normalizeEmail(license.email) !== normalizeEmail(session.email)
  ) {
    await sendPortalNotice(
      env,
      license.email,
      "Your license has a new key",
      notice,
    );
  }
  // Shown ONCE: the raw key is in this response and nowhere else; only its hash is stored.
  return portalJson({ key, hash, revokedKeys: revoked, createdAt: now }, 201);
}
