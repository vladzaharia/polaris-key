/**
 * Discover (PX-W10, docs/design/PORTAL.md §4.16, §10.2 G24, G25):
 *
 *   GET  /api/discover                  every product whose licence policy WOULD auto-issue to
 *                                       the signed-in account, evaluated without issuing: the
 *                                       presentation, what the account would get (tier, device
 *                                       limit, expiry) and why (`reason`, always present).
 *   POST /api/discover/<p>/claim        "Add to library": re-evaluate, then mint through the
 *                                       auto-issue path itself. Idempotent per account and
 *                                       product; `409 not_eligible` when the offer is gone.
 *
 * ── WHICH POLICY, AND WHY NO CORE HOOK ──────────────────────────────────────────────────────
 *
 * "First-load auto-issue" for an ACCOUNT is the product sign-in's: `activateFromIdentity` in
 * `../oidc.ts`, which mints on a product's first sign-in from the product's `groupRoleMap` (a
 * group the identity holds) or its `oidcDefault` auto-issue rule. That lives in Identity, the
 * service the portal is part of, so Discover calls it directly: the listing through
 * `previewIdentityIssue` (the same policy function, `identityTier`, plus the read-only
 * provisioning step, and nothing written) and the claim through `activateFromIdentity` itself.
 * No other service's internals are read (rule 6): tiers, licences and seats come from Core
 * (`core/data.ts`, `core/authz.ts`), presentation and platforms through the descriptor hooks.
 * License's own auto-issue (`POST /<p>/license/enroll`, the `anonymous` mode) is per MACHINE and
 * keyed by a hardware id, so it is not an account's offer and is never listed.
 *
 * ── WHO IS THE ACCOUNT, TO THE POLICY ───────────────────────────────────────────────────────
 *
 * The account's identity at the platform IdP (`getPlatformIdentity`): its subject, verified
 * email, name and the `groups` claim of its last portal sign-in. A `provider: platform` product's
 * own sign-in carries the same subject for the same person, so a licence Discover mints is the
 * licence that product's first sign-in would have minted, and `syncAccountLicenseLinks` links it
 * back by subject. That is also why only platform-issuer products with auto-linking on are
 * candidates (`listDiscoverCandidates`), and why an account with no platform identity (one that
 * has only ever used an email link) is offered nothing: there is no subject for the auto-issue
 * path to key a licence by until the account model of S-16 (I-05, I-06) attaches licences to
 * accounts directly.
 *
 * Purchase-only and operator-issued products never appear: with no mapped group and no
 * `oidcDefault` rule the policy grants nothing. Neither do products the account already holds,
 * products with the portal off, or products whose developer turned Discover off
 * (`portal_product_settings.discover_enabled`, migrations/0071).
 */

import { representabilityIssue } from "@polaris-key/catalog";
import {
  platformOidcConfig,
  randomId,
  type Db,
  type Env,
} from "../../../core/platform.js";
import {
  loadProductPublic,
  type ProductPublic,
} from "../../../core/products.js";
import {
  appendAudit,
  getLicense,
  getLicenseBySub,
  getTier,
  type LicenseRow,
} from "../../../core/data.js";
import { licenseDeviceLimit } from "../../../core/authz.js";
import { licenseUsable } from "../../../core/devices.js";
import {
  activateFromIdentity,
  previewIdentityIssue,
  type AutoIssueGrantVia,
  type OidcIdentity,
} from "../oidc.js";
import {
  err,
  portalJson,
  requireActionRateLimit,
  type PortalHooksFor,
} from "./api.js";
import { presentationFor } from "./library.js";
import {
  CLAIM_BUCKET,
  CLAIM_LIMIT_PER_MINUTE,
  productPlatforms,
} from "./selfService.js";
import {
  accountHoldsProduct,
  getPlatformIdentity,
  linkLicense,
  listDiscoverCandidates,
  listHeldProducts,
  portalIdentityIssuerKey,
  recordDiscoverClaim,
} from "./repo.js";
import type { PortalSession } from "./session.js";

/**
 * Why the account can add the product (owner decision Q-6: always shown, never hideable):
 * `free_with_account` (the product's `oidcDefault` auto-issue rule) or `group:<group>` (a group
 * the account holds at the platform IdP, mapped in the product's `groupRoleMap`). An open set:
 * the email-domain and beta reasons of §4.16 arrive with the policies that can grant them.
 */
export type DiscoverReason = "free_with_account" | `group:${string}`;

export function discoverReason(via: AutoIssueGrantVia): DiscoverReason {
  return via.kind === "group" ? `group:${via.group}` : "free_with_account";
}

/** What adding the product would give the account: the tier and its terms, from the policy. */
export interface DiscoverTerms {
  tier: string | null;
  tierLabel: string | null;
  deviceLimit: number;
  /** The expiry the licence would carry if it were minted now; `null` = never expires. */
  expiresAt: number | null;
  /** The tier's policy length in days (`null` = lifetime), for "Beta · 90 days". */
  expiryDays: number | null;
}

type OfferVerdict =
  | {
      kind: "offer";
      product: ProductPublic;
      reason: DiscoverReason;
      terms: DiscoverTerms;
    }
  /** The account already holds a licence here; `license` is the auto-issue one when it exists. */
  | { kind: "held"; product: ProductPublic; license: LicenseRow | null }
  | { kind: "none" };

/** The account as the auto-issue policy sees it, or `null` when it has no platform identity. */
export async function discoverIdentity(
  env: Env,
  db: Db,
  accountId: string,
): Promise<OidcIdentity | null> {
  const cfg = platformOidcConfig(env);
  if (!cfg) return null;
  const pi = await getPlatformIdentity(
    db,
    accountId,
    portalIdentityIssuerKey(cfg.issuer),
  );
  if (!pi) return null;
  // The product sign-in's `mapClaims` rules: a verified email only (the portal stores no other),
  // and nothing a signed document could not carry.
  const email =
    pi.email !== null && representabilityIssue(pi.email) === null
      ? pi.email
      : undefined;
  const name =
    pi.displayName !== null && representabilityIssue(pi.displayName) === null
      ? pi.displayName
      : undefined;
  const groups = pi.groups ?? [];
  return {
    sub: pi.subject,
    email,
    name,
    groups,
    // The claims a provisioning hook can read: what the portal kept from the platform ID token.
    claims: {
      sub: pi.subject,
      ...(email !== undefined ? { email, email_verified: true } : {}),
      ...(name !== undefined ? { name } : {}),
      groups,
    },
  };
}

/** Evaluate one candidate product for the account. Reads only. */
async function evaluateOffer(
  db: Db,
  accountId: string,
  identity: OidcIdentity,
  slug: string,
  now: number,
): Promise<OfferVerdict> {
  const product = await loadProductPublic(db, slug);
  // A product that does not run License has no licence to offer.
  if (!product || !product.services.license.enabled) return { kind: "none" };
  const preview = await previewIdentityIssue(db, product, identity, now);
  if (await accountHoldsProduct(db, accountId, slug)) {
    return {
      kind: "held",
      product,
      license: "error" in preview ? null : preview.existing,
    };
  }
  if ("error" in preview) return { kind: "none" };
  if (preview.existing) {
    return { kind: "held", product, license: preview.existing };
  }
  const tier = preview.tierId ? await getTier(db, slug, preview.tierId) : null;
  // The seat limit the minted licence will enforce: `licenseDeviceLimit` over the row
  // `activateFromIdentity` would insert (its tier and provisioned overrides; no licence
  // profiles, as a new licence has none).
  const would: LicenseRow = {
    product: slug,
    id: "",
    status: "active",
    sub: identity.sub,
    name: identity.name ?? null,
    email: identity.email ?? null,
    groups_json: JSON.stringify(identity.groups),
    tier_id: preview.tierId,
    activated_at: now,
    expires_at: preview.expiresAt,
    max_offline_days: null,
    overrides_json: JSON.stringify(preview.overrides),
    channels_json: null,
    min_version: null,
    max_version: null,
    origin: "oidc",
    modified_by: "oidc",
    modified_at: now,
  };
  return {
    kind: "offer",
    product,
    reason: discoverReason(preview.via),
    terms: {
      tier: preview.tierId,
      tierLabel: tier?.label ?? null,
      deviceLimit: await licenseDeviceLimit(db, product, would, now),
      expiresAt: preview.expiresAt,
      expiryDays: tier?.policy_expiry_days ?? null,
    },
  };
}

/**
 * Every offer for the account, in name order. Reads only: no row is written (G24).
 *
 * A product the account already holds is never an offer, whatever its policy would say: the held
 * set is read once up front and those candidates are skipped before any evaluation, and
 * `exclude` (the slugs the caller's library view lists) is skipped too, so the count beside the
 * library can never name a product that library already shows.
 */
export async function discoverOffers(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
): Promise<
  Array<{
    product: ProductPublic;
    reason: DiscoverReason;
    terms: DiscoverTerms;
  }>
> {
  const identity = await discoverIdentity(env, db, accountId);
  if (!identity) return [];
  const held = await listHeldProducts(db, accountId);
  const offers = [];
  for (const slug of await listDiscoverCandidates(db)) {
    if (held.has(slug) || exclude.has(slug)) continue;
    const verdict = await evaluateOffer(db, accountId, identity, slug, now);
    if (verdict.kind === "offer") offers.push(verdict);
  }
  return offers;
}

/**
 * How many offers the account has: the Discover count in the nav (§4.16, `GET /api/library`).
 * `library` is the slugs that same response lists, none of which is ever counted.
 */
export async function discoverCount(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
  library: ReadonlySet<string> = new Set(),
): Promise<number> {
  return (await discoverOffers(env, db, accountId, now, library)).length;
}

/** `GET /api/discover`. */
export async function handleDiscover(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (req.method !== "GET") return err(405, "method_not_allowed");
  const offers = [];
  for (const o of await discoverOffers(env, db, session.accountId, now)) {
    offers.push({
      product: o.product.slug,
      ...(await presentationFor(o.product, hooksFor, now)),
      platforms: await productPlatforms(db, hooksFor, o.product.slug, now),
      offer: o.terms,
      reason: o.reason,
    });
  }
  return portalJson({ offers });
}

async function claimedLicenseView(
  db: Db,
  product: ProductPublic,
  license: LicenseRow,
  now: number,
): Promise<Record<string, unknown>> {
  const tier = license.tier_id
    ? await getTier(db, product.slug, license.tier_id)
    : null;
  return {
    id: license.id,
    tier: license.tier_id,
    tierLabel: tier?.label ?? null,
    status: license.status,
    usable: licenseUsable(license, now),
    expiresAt: license.expires_at,
    deviceLimit: await licenseDeviceLimit(db, product, license, now),
  };
}

function notEligible(): Response {
  return portalJson(
    {
      error: "not_eligible",
      message: "this product is no longer offered to your account",
    },
    409,
  );
}

/** A UNIQUE violation from the store: another request inserted the same licence first. */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/** `POST /api/discover/<p>/claim`. */
export async function handleDiscoverClaim(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  slug: string,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  // The one account-wide bucket the activate preview and the key claim spend (§10.2 notes:
  // "preview, add and Discover claim share one bucket per account"), charged before any lookup.
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    CLAIM_BUCKET,
    now,
    CLAIM_LIMIT_PER_MINUTE,
  );
  if (limited) return limited;

  const identity = await discoverIdentity(env, db, session.accountId);
  const verdict = identity
    ? await evaluateOffer(db, session.accountId, identity, slug, now)
    : ({ kind: "none" } as const);
  // Not a candidate at all (unknown slug, portal or Discover off, a custom issuer) reads exactly
  // like a withdrawn offer: Discover never confirms that a product exists beyond what it listed.
  const candidate =
    identity !== null &&
    (await listDiscoverCandidates(db, slug)).includes(slug);

  if (verdict.kind === "held" && candidate) {
    // Idempotent: the second submit of an add answers the licence the first one minted.
    let found = verdict.license;
    // I-05: a licence has one owner. The auto-issue licence keyed by this account's platform
    // subject is linked here if it is in no account, and is never answered when another account
    // owns it. This is the person's own "Add to library", an explicit act, so it links even a
    // licence this account once removed: an auto-attach block (LX-26, S-24 D19) stops only the
    // automatic sweep, which skips that pair.
    if (found && (found.account_id ?? null) === null) {
      await linkLicense(
        db,
        session.accountId,
        found.product,
        found.id,
        "oidc",
        now,
      );
      found = await getLicense(db, found.product, found.id);
    }
    if (found && found.account_id !== session.accountId) found = null;
    const license =
      found ?? (await heldLicense(db, session.accountId, verdict.product.slug));
    if (license) {
      return portalJson({
        added: false,
        product: verdict.product.slug,
        license: await claimedLicenseView(db, verdict.product, license, now),
      });
    }
  }
  if (verdict.kind !== "offer" || !candidate || !identity) return notEligible();

  const { product } = verdict;
  let licenseId: string;
  try {
    const result = await activateFromIdentity(db, product, identity, now);
    if ("error" in result) return notEligible();
    licenseId = result.licenseId;
  } catch (e) {
    // Two submits raced past the evaluation and the other inserted first
    // (`idx_licenses_sub`): its licence is this account's, so answer it.
    if (!isUniqueViolation(e)) throw e;
    const raced = await getLicenseBySub(db, product.slug, identity.sub);
    if (!raced) throw e;
    licenseId = raced.id;
  }
  const license = await getLicense(db, product.slug, licenseId);
  if (!license) return notEligible();
  await linkLicense(
    db,
    session.accountId,
    product.slug,
    licenseId,
    "oidc",
    now,
  );

  const who = identity.email ?? identity.sub;
  const added = await recordDiscoverClaim(db, {
    accountId: session.accountId,
    product: product.slug,
    licenseId,
    summary: `Added ${product.name} from Discover (source: discover; reason: ${verdict.reason})`,
    now,
  });
  if (added) {
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: identity.sub,
      actor_name: identity.name ?? null,
      actor_email: identity.email ?? null,
      action: "license.create",
      target_kind: "license",
      target_id: licenseId,
      parent_id: null,
      summary: `Auto-issued to ${who} from the portal's Discover (source: discover; reason: ${verdict.reason})`,
    });
  }
  return portalJson({
    added,
    product: product.slug,
    license: await claimedLicenseView(db, product, license, now),
  });
}

/** The licence an account already holds for a product, best first (usable, then newest). */
async function heldLicense(
  db: Db,
  accountId: string,
  product: string,
): Promise<LicenseRow | null> {
  return db.first<LicenseRow>(
    `SELECT l.* FROM licenses l
      WHERE l.account_id = ? AND l.product = ?
      ORDER BY CASE WHEN l.status = 'active' THEN 0 ELSE 1 END, l.activated_at DESC
      LIMIT 1`,
    accountId,
    product,
  );
}
