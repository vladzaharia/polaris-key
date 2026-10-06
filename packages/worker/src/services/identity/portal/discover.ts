/**
 * Discover (PX-W10, docs/design/PORTAL.md §4.16, §10.2 G24, G25), rebuilt on the Polaris Key
 * storefront's obtain-path engine (PS-03, `store/obtain.ts`, notes/S-21 §6.3):
 *
 *   GET  /api/discover                  every product the engine shows the signed-in account with
 *                                       an identity path (`group`, `auto_issue`): what its licence
 *                                       policy WOULD auto-issue, evaluated without issuing, with
 *                                       the presentation, what the account would get (tier,
 *                                       device limit, expiry) and why (`reason`, always present).
 *   POST /api/discover/<p>/claim        "Add to library": re-evaluate through the engine, then
 *                                       mint through the auto-issue path itself. Idempotent per
 *                                       account and product; `409 not_eligible` when the offer is
 *                                       gone, exactly as for an unknown product.
 *
 * In `auto` mode (every product's default) this is PX-W10's Discover, unchanged: the engine's
 * identity paths are the same policy function, on the same candidates. The listing, the count and
 * the claim are thin wrappers that serve the IDENTITY paths only, because the claim can add only
 * what the auto-issue path mints. The `open` path and audience `everyone` link-only listings are
 * evaluated by the engine (`storefrontOffers`) and served once PS-04 adds the claim by path,
 * `library_entries` and the additive `paths[]` / `cta` fields.
 *
 * ── WHICH POLICY, AND WHY NO CORE HOOK ──────────────────────────────────────────────────────
 *
 * "First-load auto-issue" for an ACCOUNT is the product sign-in's: `activateFromIdentity` in
 * `../oidc.ts`, which mints on a product's first sign-in from the product's `groupRoleMap` (a
 * group the identity holds) or its `oidcDefault` auto-issue rule. That lives in Identity, the
 * service the portal is part of, so the engine calls it directly: the listing through
 * `previewIdentityIssue` (the same policy function, `identityTier`, plus the read-only
 * provisioning step, and nothing written) and the claim through `activateFromIdentity` itself.
 * No other service's internals are read (rule 6): tiers, licences and seats come from Core
 * (`core/data.ts`, `core/authz.ts`), presentation and platforms through the descriptor hooks.
 * License's own auto-issue (`POST /<p>/license/enroll`, the `anonymous` mode) is per MACHINE and
 * keyed by a hardware id, so it is not an account's offer and is never listed.
 *
 * ── WHO IS THE ACCOUNT, TO THE POLICY ───────────────────────────────────────────────────────
 *
 * The account's identity at the platform IdP (`discoverIdentity`): its subject, verified email,
 * name and the `groups` claim of its last portal sign-in. A `provider: platform` product's own
 * sign-in carries the same subject for the same person, so a licence Discover mints is the licence
 * that product's first sign-in would have minted, and `syncAccountLicenseLinks` links it back by
 * subject. That is also why the identity paths run only on platform-issuer products with
 * auto-linking on, and why an account with no platform identity (one that has only ever used an
 * email link) is offered nothing here: there is no subject for the auto-issue path to key a
 * licence by until the account model of S-16 (I-05, I-06) attaches licences to accounts directly.
 *
 * Purchase-only and operator-issued products never appear: with no mapped group and no
 * `oidcDefault` rule the policy grants nothing. Neither do products the account already holds,
 * products with the portal off, products whose developer unlisted them
 * (`storefront.polarisKey.listed`, or `discover_enabled = 0` until PS-11), or any product while
 * the deployment's `storefront.polarisKey.enabled` is off.
 */

import { randomId, type Db, type Env } from "../../../core/platform.js";
import type { ProductPublic } from "../../../core/products.js";
import {
  appendAudit,
  getLicense,
  getLicenseBySub,
  getTier,
  type LicenseRow,
} from "../../../core/data.js";
import { licenseDeviceLimit } from "../../../core/authz.js";
import { licenseUsable } from "../../../core/devices.js";
import { activateFromIdentity } from "../oidc.js";
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
import { linkLicense, recordDiscoverClaim } from "./repo.js";
import type { PortalSession } from "./session.js";
import {
  evaluateObtain,
  isIdentityPathKind,
  storefrontOffers,
  type DiscoverReason,
  type DiscoverTerms,
  type ObtainOptions,
  type ObtainPath,
} from "./store/obtain.js";

export {
  discoverIdentity,
  discoverReason,
  type DiscoverReason,
  type DiscoverTerms,
} from "./store/obtain.js";

/**
 * What Discover serves today: the identity paths alone (no other source, no link-only listing),
 * because its claim mints only through the auto-issue path. PS-04 widens it with the claim by path.
 */
const DISCOVER: ObtainOptions = { sources: [], links: false };

/** An identity path, with the terms and reason code it always carries. */
type IdentityPath = ObtainPath & {
  terms: DiscoverTerms;
  reason: DiscoverReason;
};

function identityPath(path: ObtainPath | undefined): IdentityPath | null {
  return path && isIdentityPathKind(path.kind) && path.terms
    ? (path as IdentityPath)
    : null;
}

/**
 * Every offer for the account, in name order: the engine's visible products whose first path is
 * an identity path. Reads only: no row is written (G24).
 *
 * A product the account already holds is never an offer, whatever its policy would say: the
 * engine reads the held set once up front and skips those candidates before any evaluation, and
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
  const offers = [];
  for (const o of await storefrontOffers(env, db, accountId, now, {
    ...DISCOVER,
    exclude,
  })) {
    const first = o.cta === "add" ? identityPath(o.paths[0]) : null;
    if (first)
      offers.push({
        product: o.product,
        reason: first.reason,
        terms: first.terms,
      });
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
      ...(await presentationFor(env, db, o.product, hooksFor, now, "discover")),
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

  // The engine's view of this one product (`null`: not a candidate at all, an unknown slug, the
  // portal off, unlisted, the storefront switched off). Every refusal below reads exactly like a
  // withdrawn offer: Discover never confirms that a product exists beyond what it listed.
  const ev = await evaluateObtain(
    env,
    db,
    session.accountId,
    slug,
    now,
    DISCOVER,
  );
  // Set only where the identity paths can run: the platform issuer with auto-linking on, License
  // on, and an account with a platform identity.
  const evidence = ev?.identity ?? null;

  if (ev && evidence && ev.held) {
    // Idempotent: the second submit of an add answers the licence the first one minted.
    let found = evidence.existing;
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
      found ?? (await heldLicense(db, session.accountId, ev.product.slug));
    if (license) {
      return portalJson({
        added: false,
        product: ev.product.slug,
        license: await claimedLicenseView(db, ev.product, license, now),
      });
    }
  }
  const offered =
    ev?.verdict.visible && ev.verdict.cta === "add"
      ? identityPath(ev.verdict.paths[0])
      : null;
  if (!ev || !evidence || !offered) return notEligible();
  const { identity } = evidence;

  const { product } = ev;
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
    summary: `Added ${product.name} from Discover (source: discover; reason: ${offered.reason})`,
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
      summary: `Auto-issued to ${who} from the portal's Discover (source: discover; reason: ${offered.reason})`,
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
