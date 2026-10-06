/**
 * Discover, the Polaris Key storefront's portal API (PX-W10, docs/design/PORTAL.md §4.16, §10.2
 * G24, G25; PS-04, notes/S-21 §6.4, §6.5, §6.7), on the storefront's obtain-path engine (PS-03,
 * `store/obtain.ts`, notes/S-21 §6.3):
 *
 *   GET  /api/discover                  every product the engine shows the signed-in account, in
 *                                       name order: presentation, platforms, short description,
 *                                       the action (`cta`: `add`, or `link` for an audience-
 *                                       `everyone` listing with nothing to add, with its live
 *                                       `stores`), every path with its terms (`paths`), and the
 *                                       FIRST path's reason and terms as PX-W10's `reason` and
 *                                       `offer`, so PX-16's tile reads what it always read.
 *   GET  /api/discover/<p>              the storefront product page: the same for one product,
 *                                       plus the listing's description and screenshots; `404
 *                                       not_found` for anything not visible to this account.
 *   POST /api/discover/<p>/claim        "Add to library", optional body `{path}` (the first path
 *                                       when absent): re-evaluate through the engine, then issue
 *                                       through `issueFromPath`, the ONE issuance function.
 *                                       Idempotent per account and product; `409 not_eligible`
 *                                       for every invisible case alike.
 *
 * In `auto` mode (every product's default) the listing is PX-W10's Discover, unchanged: only the
 * identity paths count there, and they are the same policy function on the same candidates. The
 * `open` path and link-only listings appear only on products an operator set to `listed`.
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
 * (`core/data.ts`, `core/authz.ts`), presentation, platforms and `openAccess` through the
 * descriptor hooks. License's own auto-issue (`POST /<p>/license/enroll`, the `anonymous` mode) is
 * per MACHINE and keyed by a hardware id, so it is not an account's offer and is never listed.
 *
 * ── WHO IS THE ACCOUNT, TO THE POLICY ───────────────────────────────────────────────────────
 *
 * The account's identity at the platform IdP (`discoverIdentity`): its subject, verified email,
 * name and the `groups` claim of its last portal sign-in. A `provider: platform` product's own
 * sign-in carries the same subject for the same person, so a licence Discover mints is the licence
 * that product's first sign-in would have minted, and `syncAccountLicenseLinks` links it back by
 * subject. That is also why the identity paths run only on platform-issuer products with
 * auto-linking on, and why an account with no platform identity (one that has only ever used an
 * email link) gets no identity path: there is no subject for the auto-issue path to key a licence
 * by. The `open` path issues no licence, so it needs no subject.
 *
 * ── WHAT ADD CREATES (notes/S-21 §6.4) ──────────────────────────────────────────────────────
 *
 *   group, auto_issue   the licence `activateFromIdentity` mints on the platform subject, linked
 *                       to the account; `portal.discover.claim` and `license.create` audited with
 *                       `source: discover; path: <kind>`.
 *   open                a `library_entries` row and no licence; `portal.discover.claim` in the
 *                       account's own history.
 *
 * Never a device binding (devices choose at their next sign-in, SIGN-IN.md's `LicenseChoiceStep`)
 * and never a second licence for a product the account holds (the I-26 rule): a held product's
 * claim answers what it holds. `store_owned` (PS-07), `product_idp` (PS-08) and `email_domain`
 * (PS-09) add their own branch to `issueFromPath`; S-22 calls it from a verified checkout event.
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
import {
  isObtainPathKind,
  type StorefrontListing,
} from "../../../core/storefront/polarisKeyListing.js";
import { activateFromIdentity } from "../oidc.js";
import {
  err,
  notFound,
  portalJson,
  readBody,
  requireActionRateLimit,
  type PortalHooksFor,
} from "./api.js";
import { presentationOf, productListing } from "./library.js";
import { screenshotUrlsFor } from "./media.js";
import {
  CLAIM_BUCKET,
  CLAIM_LIMIT_PER_MINUTE,
  productPlatforms,
} from "./selfService.js";
import {
  addLibraryEntry,
  linkLicense,
  listLibraryEntries,
  portalAudit,
  recordDiscoverClaim,
  type LibraryEntryRow,
} from "./repo.js";
import type { PortalSession } from "./session.js";
import {
  evaluateObtain,
  storefrontOffers,
  type DiscoverTerms,
  type ObtainEvaluation,
  type ObtainOptions,
  type ObtainPath,
  type StorefrontOffer,
} from "./store/obtain.js";
import {
  LINK_PATH_KIND,
  recordAdd,
  recordImpressions,
  type Impression,
} from "./store/analytics.js";

export {
  discoverIdentity,
  discoverReason,
  type DiscoverReason,
  type DiscoverTerms,
} from "./store/obtain.js";

/** The storefront product page's own budget, per account, charged before any lookup. */
export const STOREFRONT_PAGE_BUCKET = "portalStorefrontPage";
export const STOREFRONT_PAGE_LIMIT_PER_MINUTE = 60;

/** One product Discover shows the account, with its first path's reason and terms (the tile's). */
export interface DiscoverOffer extends StorefrontOffer {
  /** The first path's reason code (`free_with_account`, `group:<g>`, `open`); `null` for a link. */
  reason: string | null;
  /** The first path's terms; `null` for a link, and for a path that issues no licence (`open`). */
  terms: DiscoverTerms | null;
}

function discoverOffer(offer: StorefrontOffer): DiscoverOffer {
  const first = offer.paths[0];
  return {
    ...offer,
    reason: first?.reason ?? null,
    terms: first?.terms ?? null,
  };
}

function engineOptions(
  hooksFor: PortalHooksFor | undefined,
  extra: ObtainOptions = {},
): ObtainOptions {
  return hooksFor ? { ...extra, hooksFor } : extra;
}

/**
 * Every product the engine shows the account, in name order: offers to add (`cta: "add"`, at
 * least one path) and audience-`everyone` links (`cta: "link"`, no path). Reads only: no row is
 * written (G24). Without `hooksFor` no Distribution answer is read, so only the identity paths can
 * show.
 *
 * A product the account already holds is never shown, whatever its policy would say: the engine
 * reads the held set (licences and library entries) once up front and skips those candidates
 * before any evaluation, and `exclude` (the slugs the caller's library view lists) is skipped too,
 * so the count beside the library can never name a product that library already shows.
 */
export async function discoverOffers(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
  hooksFor?: PortalHooksFor,
  opts: { links?: boolean } = {},
): Promise<DiscoverOffer[]> {
  const offers = await storefrontOffers(
    env,
    db,
    accountId,
    now,
    engineOptions(hooksFor, { exclude, ...opts }),
  );
  return offers.map(discoverOffer);
}

/**
 * How many products the account could add now: the Discover count in the nav (§4.16, `GET
 * /api/library`; notes/S-21 §6.10 item 8, "offers you can add now", so a link is not counted).
 * `library` is the slugs that same response lists, none of which is ever counted.
 */
export async function discoverCount(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
  library: ReadonlySet<string> = new Set(),
  hooksFor?: PortalHooksFor,
): Promise<number> {
  const offers = await discoverOffers(
    env,
    db,
    accountId,
    now,
    library,
    hooksFor,
    {
      links: false,
    },
  );
  return offers.filter((o) => o.cta === "add").length;
}

// ── The views ────────────────────────────────────────────────────────────────────────────────

function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The operator's label for a `group` path (`storefront.polarisKey.groupLabels`), or `null`. */
function groupLabel(
  listing: StorefrontListing,
  path: ObtainPath,
): string | null {
  if (path.kind !== "group" || path.detail === null) return null;
  return Object.prototype.hasOwnProperty.call(listing.groupLabels, path.detail)
    ? (listing.groupLabels[path.detail] ?? null)
    : null;
}

/** One path as the portal sees it: the engine's path plus the operator's group label. */
function pathView(
  listing: StorefrontListing,
  path: ObtainPath,
): Record<string, unknown> {
  return {
    kind: path.kind,
    detail: path.detail,
    label: groupLabel(listing, path),
    terms: path.terms,
    action: path.action,
    reason: path.reason,
  };
}

/** A store page a link points at: a live store outlet with an https page (`stores[]`). */
interface StoreLink {
  id: string;
  kind: string;
  label: string;
  url: string;
}

/** The product's live store pages, from Distribution's `customerDownloads` (stable channel). */
async function storeLinks(
  product: ProductPublic,
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<StoreLink[]> {
  const delivery = hooksFor ? hooksFor(product, now).delivery() : null;
  const downloads = await delivery?.customerDownloads?.({
    channel: "stable",
    limit: 1,
  });
  const out: StoreLink[] = [];
  for (const s of downloads?.stores ?? [])
    if (s.live && s.url !== null)
      out.push({ id: s.id, kind: s.kind, label: s.label, url: s.url });
  return out;
}

/** What an offer shows, on the listing and the product page alike. */
async function offerView(
  db: Db,
  offer: DiscoverOffer,
  listing: Record<string, unknown> | null,
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<Record<string, unknown>> {
  return {
    product: offer.product.slug,
    ...(await presentationOf(offer.product, listing)),
    platforms: await productPlatforms(db, hooksFor, offer.product.slug, now),
    shortDescription: text(listing?.subtitle),
    cta: offer.cta,
    paths: offer.paths.map((p) => pathView(offer.listing, p)),
    offer: offer.terms,
    reason: offer.reason,
    stores:
      offer.cta === "link"
        ? await storeLinks(offer.product, hooksFor, now)
        : [],
  };
}

/** The kind an impression of this offer counts under: its first path's, or `link`. */
function impression(offer: DiscoverOffer): Impression {
  return {
    product: offer.product.slug,
    kind: offer.paths[0]?.kind ?? LINK_PATH_KIND,
  };
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
  const shown: Impression[] = [];
  for (const o of await discoverOffers(
    env,
    db,
    session.accountId,
    now,
    new Set(),
    hooksFor,
  )) {
    const listing = await productListing(o.product, hooksFor, now);
    offers.push(await offerView(db, o, listing, hooksFor, now));
    shown.push(impression(o));
  }
  // PS-04 (notes/S-21 §6.6): one impression per product per account per day. Only what the
  // listing shows is counted, after the engine's dry run decided it.
  await recordImpressions(env, db, session.accountId, shown, now);
  return portalJson({ offers });
}

/**
 * `GET /api/discover/<p>`: the storefront product page (notes/S-21 §6.5). Unknown, gone, portal
 * off, unlisted, ineligible and held products, and every product while the storefront is off,
 * all answer the portal's one `404 not_found`: the page never confirms more than the listing
 * shows. Its own per-account budget is charged before any lookup.
 */
export async function handleStorefrontPage(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  slug: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (req.method !== "GET") return err(405, "method_not_allowed");
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    STOREFRONT_PAGE_BUCKET,
    now,
    STOREFRONT_PAGE_LIMIT_PER_MINUTE,
  );
  if (limited) return limited;
  const ev = await evaluateObtain(
    env,
    db,
    session.accountId,
    slug,
    now,
    engineOptions(hooksFor),
  );
  if (!ev?.verdict.visible) return notFound();
  const offer = discoverOffer({
    product: ev.product,
    listing: ev.listing,
    cta: ev.verdict.cta,
    paths: ev.verdict.paths,
  });
  const listing = await productListing(ev.product, hooksFor, now);
  const body = {
    ...(await offerView(db, offer, listing, hooksFor, now)),
    description: text(listing?.description),
    screenshots: await screenshotUrlsFor(ev.product.slug, listing),
    // Every live store page, whatever the action: the page lists where else the product is.
    stores: await storeLinks(ev.product, hooksFor, now),
  };
  await recordImpressions(env, db, session.accountId, [impression(offer)], now);
  return portalJson(body);
}

// ── Issuance ─────────────────────────────────────────────────────────────────────────────────

/** What `issueFromPath` needs besides the path: the bindings and the clock. */
export interface IssueContext {
  env: Env;
  db: Db;
  now: number;
}

/** Who the path issues to. */
export interface IssueAccount {
  accountId: string;
}

/** The product and the evidence the engine gathered for it (`evaluateObtain`). */
export type IssueTarget = Pick<ObtainEvaluation, "product" | "identity">;

/** What a path created (`added: true`) or found already there (`added: false`), or a refusal. */
export type IssueResult =
  | { kind: "license"; added: boolean; license: LicenseRow }
  | { kind: "entry"; added: boolean; entry: LibraryEntryRow }
  | { error: "not_eligible" };

/** The audit trail's words for an add: `source: discover; path: <kind>; reason: <code>`. */
function addSummary(path: ObtainPath): string {
  return `source: discover; path: ${path.kind}; reason: ${path.reason}`;
}

/** A UNIQUE violation from the store: another request inserted the same licence first. */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/** `group` and `auto_issue`: the licence the product's first sign-in would mint, on the account. */
async function issueIdentityLicense(
  ctx: IssueContext,
  path: ObtainPath,
  account: IssueAccount,
  target: IssueTarget,
): Promise<IssueResult> {
  const { db, now } = ctx;
  const evidence = target.identity;
  if (!evidence) return { error: "not_eligible" };
  const { identity } = evidence;
  const { product } = target;
  let licenseId: string;
  try {
    const result = await activateFromIdentity(db, product, identity, now);
    if ("error" in result) return { error: "not_eligible" };
    licenseId = result.licenseId;
  } catch (e) {
    // Two submits raced past the evaluation and the other inserted first
    // (`idx_licenses_sub`): its licence is this account's, so answer it.
    if (!isUniqueViolation(e)) throw e;
    const raced = await getLicenseBySub(db, product.slug, identity.sub);
    if (!raced) throw e;
    licenseId = raced.id;
  }
  if (!(await getLicense(db, product.slug, licenseId)))
    return { error: "not_eligible" };
  await linkLicense(
    db,
    account.accountId,
    product.slug,
    licenseId,
    "oidc",
    now,
  );
  const license = await getLicense(db, product.slug, licenseId);
  if (!license) return { error: "not_eligible" };

  const who = identity.email ?? identity.sub;
  const added = await recordDiscoverClaim(db, {
    accountId: account.accountId,
    product: product.slug,
    licenseId,
    summary: `Added ${product.name} from Discover (${addSummary(path)})`,
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
      summary: `Auto-issued to ${who} from the portal's Discover (${addSummary(path)})`,
    });
    await recordAdd(db, product.slug, path.kind, now);
  }
  return { kind: "license", added, license };
}

/** `open`: a library entry and no licence. The entry's primary key decides a double submit. */
async function issueOpenEntry(
  ctx: IssueContext,
  path: ObtainPath,
  account: IssueAccount,
  target: IssueTarget,
): Promise<IssueResult> {
  const { db, now } = ctx;
  const { product } = target;
  const added = await addLibraryEntry(db, {
    accountId: account.accountId,
    product: product.slug,
    via: "open",
    now,
  });
  const [entry] = await listLibraryEntries(db, account.accountId, product.slug);
  if (!entry) return { error: "not_eligible" };
  if (added) {
    // The account's own history only: no licence exists, so the product's `audit` has nothing
    // to record, and the developer learns of adds through the daily aggregates alone.
    await portalAudit(db, {
      accountId: account.accountId,
      action: "portal.discover.claim",
      product: product.slug,
      targetKind: "product",
      targetId: product.slug,
      summary: `Added ${product.name} from Discover (${addSummary(path)})`,
      now,
    });
    await recordAdd(db, product.slug, path.kind, now);
  }
  return { kind: "entry", added, entry };
}

/**
 * THE issuance function (notes/S-21 §6.4, §6.10 item 3): create what `path` implies for the
 * account on `target`'s product, audit it, and count the add. The caller has evaluated the
 * product and chosen a path the engine offered; a path whose evidence no longer holds answers
 * `not_eligible` and creates nothing. Idempotent per account and product: a repeat answers what
 * the first call created with `added: false`, and audits and counts nothing.
 */
export async function issueFromPath(
  ctx: IssueContext,
  path: ObtainPath,
  account: IssueAccount,
  target: IssueTarget,
): Promise<IssueResult> {
  switch (path.kind) {
    case "group":
    case "auto_issue":
      return issueIdentityLicense(ctx, path, account, target);
    case "open":
      return issueOpenEntry(ctx, path, account, target);
    // `store_owned` (PS-07), `product_idp` (PS-08) and `email_domain` (PS-09) bring their own
    // branch with their source; until then no engine source offers them.
    default:
      return { error: "not_eligible" };
  }
}

// ── The claim ────────────────────────────────────────────────────────────────────────────────

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

function entryView(entry: LibraryEntryRow): Record<string, unknown> {
  return { via: entry.via, addedAt: entry.added_at };
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

/**
 * The path a claim asks for: the first offered path when the body names none (`path` absent or
 * null), else the offered path of exactly that kind, else `null` (an unknown kind, a kind not
 * offered, or a value that is not a kind all read as "not offered").
 */
export function chooseClaimPath(
  offered: readonly ObtainPath[],
  requested: unknown,
): ObtainPath | null {
  if (requested === undefined || requested === null) return offered[0] ?? null;
  if (!isObtainPathKind(requested)) return null;
  return offered.find((p) => p.kind === requested) ?? null;
}

/**
 * What the account already holds for a product the engine reads as held, for an idempotent
 * repeat: the auto-issue licence keyed by its platform subject (linked here if it floats), else
 * its best linked licence, else its library entry. `null` when none of them is this account's.
 */
async function heldAnswer(
  db: Db,
  accountId: string,
  ev: ObtainEvaluation,
  now: number,
): Promise<Record<string, unknown> | null> {
  const slug = ev.product.slug;
  let found = ev.identity?.existing ?? null;
  // I-05: a licence has one owner. The auto-issue licence keyed by this account's platform
  // subject is linked here if it is in no account, and is never answered when another account
  // owns it. This is the person's own "Add to library", an explicit act, so it links even a
  // licence this account once removed: an auto-attach block (LX-26, S-24 D19) stops only the
  // automatic sweep, which skips that pair.
  if (found && (found.account_id ?? null) === null) {
    await linkLicense(db, accountId, found.product, found.id, "oidc", now);
    found = await getLicense(db, found.product, found.id);
  }
  if (found && found.account_id !== accountId) found = null;
  const license = found ?? (await heldLicense(db, accountId, slug));
  if (license)
    return {
      added: false,
      product: slug,
      kind: "license",
      license: await claimedLicenseView(db, ev.product, license, now),
    };
  const [entry] = await listLibraryEntries(db, accountId, slug);
  if (entry)
    return {
      added: false,
      product: slug,
      kind: "entry",
      entry: entryView(entry),
    };
  return null;
}

/** `POST /api/discover/<p>/claim`, optional body `{path?: ObtainPathKind}`. */
export async function handleDiscoverClaim(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  slug: string,
  now: number,
  hooksFor?: PortalHooksFor,
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
  const requested = (await readBody(req)).path;

  // The engine's view of this one product (`null`: not a candidate at all, an unknown slug, the
  // portal off, unlisted, the storefront switched off). Every refusal below reads exactly like a
  // withdrawn offer: Discover never confirms that a product exists beyond what it listed. A link
  // is never claimable, so link targets are not evaluated.
  const ev = await evaluateObtain(
    env,
    db,
    session.accountId,
    slug,
    now,
    engineOptions(hooksFor, { links: false }),
  );

  // Idempotent: a held product's claim (a second submit, or a product held by any route) answers
  // what the account holds and creates nothing; never a second licence (the I-26 rule).
  if (ev?.held) {
    const held = await heldAnswer(db, session.accountId, ev, now);
    if (held) return portalJson(held);
  }
  const path =
    ev?.verdict.visible && ev.verdict.cta === "add"
      ? chooseClaimPath(ev.verdict.paths, requested)
      : null;
  if (!ev || !path) return notEligible();

  const result = await issueFromPath(
    { env, db, now },
    path,
    { accountId: session.accountId },
    ev,
  );
  if ("error" in result) return notEligible();
  if (result.kind === "entry")
    return portalJson({
      added: result.added,
      product: ev.product.slug,
      kind: "entry",
      entry: entryView(result.entry),
    });
  return portalJson({
    added: result.added,
    product: ev.product.slug,
    kind: "license",
    license: await claimedLicenseView(db, ev.product, result.license, now),
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
