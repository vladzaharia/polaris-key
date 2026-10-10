/**
 * The Polaris Key storefront's eligibility engine: OBTAIN PATHS (PS-03, notes/S-21 §6.3, owner
 * decisions 2-5). For one signed-in account, one product, now, and without writing anything: can
 * the person add it, by which paths, and with what terms?
 *
 *   obtainPaths(…, slug)   one product's verdict: hidden, `add` with its paths, or `link` only;
 *   storefrontOffers(…)    every product visible to the account, in name order;
 *   evaluateObtain(…)      the same evaluation with the evidence a claim needs (internal);
 *
 * Discover (`../discover.ts`) is rebuilt on it: its listing, count and claim are thin wrappers
 * that serve the identity paths, which is exactly today's Discover in `auto` mode.
 *
 * ── PATHS ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Each path is one reason the person could add the product now. Evaluation order, the first
 * path being the tile's reason: `store_owned`, `group`, `product_idp`, `email_domain`,
 * `auto_issue`, `open` (ownership first, the strongest claim; `open` last, it grants nothing).
 * This package builds three:
 *
 *   - `group` and `auto_issue` are Identity's own policy, `identityTier`, run dry through
 *     `previewIdentityIssue` for the subject the account holds at the platform IdP: the same
 *     function the product's sign-in mints with, so the storefront grants nothing a sign-in
 *     would not (THREAT-MODEL "Discover"). `identityTier` returns ONE grant (the first mapped
 *     group, else the `oidcDefault` rule), so a product yields at most one identity path: a
 *     group member of a product that also auto-issues gets the `group` path alone, because the
 *     claim would mint the group's tier, never the default one. They run only on products that
 *     sign in through the platform issuer with auto-linking on (R5-01/R5-02), only while License
 *     runs for the product, and never when the subject already holds a licence there.
 *   - `open` (nothing to licence): License is off for the product AND Distribution says every
 *     deliverable downloads without a licence (`delivery().openAccess()`, a single-provider
 *     descriptor hook, rule 6). With Distribution off there are no downloads to open and no
 *     listing (the website lives in Distribution's listing), so there is no `open` path.
 *
 * `store_owned` (PS-07), `product_idp` (PS-08) and `email_domain` (PS-09) arrive as further
 * `PathSource`s appended to `STOREFRONT_SOURCES`, each with a test row.
 *
 * ── LISTING MODES AND AUDIENCE (storefront.polarisKey.*, PS-02) ───────────────────────────────
 *
 *   - `unlisted`: no path is offered; the product is invisible everywhere in the portal.
 *   - `auto` (the default): only `group` and `auto_issue` count. This is today's Discover.
 *   - `listed`: every kind in `offerPaths` counts (`offerPaths` narrows `auto` too).
 *   - audience `everyone` additionally shows a `listed` product that has no path, to every
 *     signed-in account, with the `link` action (its store pages or website), never Add.
 *
 * A product the account already holds is Library, not storefront: a licence linked to the
 * account (any route), a library entry (`library_entries`, PS-04), or a licence
 * the account's platform subject already holds there. It is never offered, counted or linked.
 *
 * ── NO ENUMERATION ────────────────────────────────────────────────────────────────────────────
 *
 * Unknown, unlisted, ineligible and held products all read `{ visible: false }`, and only
 * visible products are listed or counted. The deployment switch `storefront.polarisKey.enabled`
 * off empties the candidate set. Audience `everyone` is the one deliberate exception, set by an
 * operator at level-2 confirmation (owner decision 5).
 *
 * ── DRY RUN ───────────────────────────────────────────────────────────────────────────────────
 *
 * Reads only: one switch read, one held-set read and one candidate query per listing, then at
 * most one policy evaluation per candidate that could show. A test runs the engine against a
 * database that refuses every write. Nothing here reaches another service except through Core's
 * hooks.
 */

import { representabilityIssue } from "@polaris-key/catalog";
import { platformOidcConfig } from "../../../../platformOidc.js";
import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../env.js";
import {
  loadProductPublic,
  type ProductPublic,
} from "../../../../core/products.js";
import { getTier, type LicenseRow } from "../../../../repo.js";
import { licenseDeviceLimit } from "../../../../core/authz.js";
import type { Delivery } from "../../../../core/hooks.js";
import { polarisKeyStorefrontEnabled } from "../../../../core/storefrontSwitch.js";
import {
  resolveListing,
  type ObtainPathKind,
  type StorefrontListing,
} from "../../../../core/storefront/polarisKeyListing.js";
import {
  previewIdentityIssue,
  type AutoIssueGrantVia,
  type OidcIdentity,
} from "../../oidc.js";
import type { PortalHooksFor } from "../api.js";
import {
  accountHoldsProduct,
  getPlatformIdentity,
  listHeldProducts,
  listLibraryEntryProducts,
  listStorefrontCandidates,
  portalIdentityIssuerKey,
  type StorefrontCandidateRow,
} from "../repo.js";

export type { ObtainPathKind } from "../../../../core/storefront/polarisKeyListing.js";

/** The evaluation order: the first offered path is the tile's main reason (S-21 §6.3). */
export const OBTAIN_PATH_ORDER: readonly ObtainPathKind[] = [
  "store_owned",
  "group",
  "product_idp",
  "email_domain",
  "auto_issue",
  "open",
];

/** The kinds that make a product visible in `auto` mode: today's Discover. */
export const IDENTITY_PATH_KINDS: readonly ObtainPathKind[] = [
  "group",
  "auto_issue",
];

export function isIdentityPathKind(kind: ObtainPathKind): boolean {
  return IDENTITY_PATH_KINDS.includes(kind);
}

/**
 * Why the account can add the product (owner decision Q-6: always shown, never hideable), for the
 * identity paths: `free_with_account` (the product's `oidcDefault` auto-issue rule) or
 * `group:<group>` (a group the account holds at the platform IdP, mapped in `groupRoleMap`). A
 * trial keeps its path; its copy derives from `expiryDays`.
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

/** What a path does when chosen. S-22 (commerce) adds `buy` and `upgrade`; nothing else may. */
export type ObtainAction = "add" | "link";

/** One reason the person could add the product now (S-21 §6.3). */
export interface ObtainPath {
  kind: ObtainPathKind;
  /** The group, store, IdP label or domain; never an account id. `null` when there is none. */
  detail: string | null;
  /** What adding gives: the licence terms, or `null` for a path that issues none (`open`). */
  terms: DiscoverTerms | null;
  action: ObtainAction;
  /** The reason code: `free_with_account`, `group:<g>`, `open`, and the later kinds' own. */
  reason: string;
}

/** The answer for one product. Unknown, unlisted, ineligible and held all read `hidden`. */
export type ObtainVerdict =
  | { visible: false }
  /** At least one path; `paths` in evaluation order, the first being the tile's reason. */
  | { visible: true; cta: "add"; paths: readonly ObtainPath[] }
  /** Audience `everyone` with no path: a link to its store pages or website, never Add. */
  | { visible: true; cta: "link"; paths: readonly [] };

export const HIDDEN: ObtainVerdict = Object.freeze({ visible: false });

/** One product the storefront may consider: its resolved listing and whether identity may run. */
export interface StorefrontCandidate {
  slug: string;
  listing: StorefrontListing;
  /** The platform issuer with auto-linking on (R5-01/R5-02): the identity paths may run. */
  identityEligible: boolean;
}

export function storefrontCandidate(
  row: StorefrontCandidateRow,
): StorefrontCandidate {
  return {
    slug: row.slug,
    listing: resolveListing(row),
    identityEligible: row.identity_eligible === 1,
  };
}

// ── The listing rules (pure) ─────────────────────────────────────────────────────────────────

/** Does a path of `kind` count for this listing? */
export function pathCounts(
  listing: StorefrontListing,
  kind: ObtainPathKind,
): boolean {
  if (listing.listed === "unlisted") return false;
  if (!listing.offerPaths.includes(kind)) return false;
  return listing.listed === "listed" || isIdentityPathKind(kind);
}

/** The paths the listing offers, in evaluation order. */
export function offeredPaths(
  listing: StorefrontListing,
  found: readonly ObtainPath[],
): ObtainPath[] {
  return found
    .filter((p) => pathCounts(listing, p.kind))
    .sort(
      (a, b) =>
        OBTAIN_PATH_ORDER.indexOf(a.kind) - OBTAIN_PATH_ORDER.indexOf(b.kind),
    );
}

/** Would a link target make this product visible (audience `everyone`, nothing to add)? */
export function wantsLink(
  listing: StorefrontListing,
  held: boolean,
  offered: readonly ObtainPath[],
): boolean {
  return (
    listing.listed === "listed" &&
    listing.audience === "everyone" &&
    !held &&
    offered.length === 0
  );
}

/** The verdict from the listing, whether the account holds it, the offered paths and links. */
export function decideVerdict(
  listing: StorefrontListing,
  held: boolean,
  offered: readonly ObtainPath[],
  linkable: boolean,
): ObtainVerdict {
  if (listing.listed === "unlisted" || held) return HIDDEN;
  if (offered.length > 0) return { visible: true, cta: "add", paths: offered };
  if (wantsLink(listing, held, offered) && linkable)
    return { visible: true, cta: "link", paths: [] };
  return HIDDEN;
}

// ── Evaluation context and sources ───────────────────────────────────────────────────────────

/**
 * A SYNTHETIC person, for the console's "Who can see this?" (PS-06; notes/S-21 §6.6, owner
 * decision 11): what the operator says the person has, never an account. Nothing in it names or
 * looks up a real person: groups are IdP group names, the email is a domain, stores are store ids.
 */
export interface Persona {
  /** Signed in to Polaris Key with the platform IdP (an email-link-only account has no subject). */
  platformAccount: boolean;
  /** The `groups` the platform IdP asserts for the person. */
  groups: readonly string[];
  /** The domain of a verified email the person holds (`email_domain`, PS-09), or `null`. */
  emailDomain: string | null;
  /** The stores the person linked (`store_owned`, PS-07), by store id. */
  stores: readonly string[];
  /** The person holds the product already (it is in their Library). */
  holds: boolean;
}

/** What a path source may read, for one account and one listing or claim. */
export interface ObtainContext {
  env: Env;
  db: Db;
  /**
   * The account. EMPTY when `persona` is set: a persona has no account, and a source must then
   * answer from the persona alone, never from an account's rows.
   */
  accountId: string;
  /** Set only for the console's persona preview (PS-06); `null` for every real account. */
  persona: Persona | null;
  now: number;
  /** The account at the platform IdP (read once), or `null` when it has none. */
  identity(): Promise<OidcIdentity | null>;
  /** The product's Distribution hook (memoised per product), or `null` when it is off. */
  delivery(product: ProductPublic): Delivery | null;
}

/**
 * One contributor of non-identity paths. Each kind has exactly one source, and a source reads
 * other services only through Core's single-provider hooks (rule 6). PS-07 to PS-09 append theirs.
 */
export interface PathSource {
  /** The kinds it may contribute; it is not asked when none of them counts for the listing. */
  readonly kinds: readonly ObtainPathKind[];
  paths(
    ctx: ObtainContext,
    candidate: StorefrontCandidate,
    product: ProductPublic,
  ): Promise<readonly ObtainPath[]>;
}

/** `open`: no licence to obtain, and every download open (`delivery().openAccess()`). */
export const OPEN_SOURCE: PathSource = {
  kinds: ["open"],
  async paths(ctx, _candidate, product) {
    if (product.services.license.enabled) return [];
    const delivery = ctx.delivery(product);
    if (!delivery || !(await delivery.openAccess())) return [];
    return [
      {
        kind: "open",
        detail: null,
        terms: null,
        action: "add",
        reason: "open",
      },
    ];
  },
};

/** Every non-identity source this Worker has, in no particular order (the engine sorts). */
export const STOREFRONT_SOURCES: readonly PathSource[] = [OPEN_SOURCE];

export interface ObtainOptions {
  /** The composition root's hook builder; without it no Distribution answer is read. */
  hooksFor?: PortalHooksFor;
  /** Slugs never offered or counted (the caller's library view lists them). */
  exclude?: ReadonlySet<string>;
  /** The non-identity sources to evaluate; `STOREFRONT_SOURCES` by default. */
  sources?: readonly PathSource[];
  /** Evaluate audience-`everyone` link targets (default true). */
  links?: boolean;
}

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

/** The subject a persona's synthetic identity carries; it is never looked up (`personaIdentity`). */
export const PERSONA_SUBJECT = "persona";

/**
 * A persona as the identity policy sees it: the groups and a verified email at its domain, as
 * `discoverIdentity` shapes a real account. Built in memory; its subject keys nothing, and the
 * engine never looks it up among licences (`previewIdentityIssue`'s `existing: false`).
 */
export function personaIdentity(persona: Persona): OidcIdentity | null {
  if (!persona.platformAccount) return null;
  const email =
    persona.emailDomain !== null ? `person@${persona.emailDomain}` : undefined;
  const groups = [...persona.groups];
  return {
    sub: PERSONA_SUBJECT,
    ...(email !== undefined ? { email } : {}),
    groups,
    claims: {
      sub: PERSONA_SUBJECT,
      ...(email !== undefined ? { email, email_verified: true } : {}),
      groups,
    },
  };
}

function obtainContext(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
  persona: Persona | null = null,
): ObtainContext {
  let identity: Promise<OidcIdentity | null> | undefined;
  const deliveries = new Map<string, Delivery | null>();
  return {
    env,
    db,
    accountId: persona ? "" : accountId,
    persona,
    now,
    identity: () =>
      (identity ??= persona
        ? Promise.resolve(personaIdentity(persona))
        : discoverIdentity(env, db, accountId)),
    delivery(product) {
      if (!hooksFor) return null;
      if (!deliveries.has(product.slug))
        deliveries.set(product.slug, hooksFor(product, now).delivery());
      return deliveries.get(product.slug) ?? null;
    },
  };
}

// ── The identity paths (Identity's own policy) ───────────────────────────────────────────────

/** What the identity policy says about one product for the account's platform subject. */
export interface IdentityEvidence {
  identity: OidcIdentity;
  /** The licence that subject already holds here (when the policy grants): held, not offered. */
  existing: LicenseRow | null;
  /** The `group` or `auto_issue` path, or `null` (nothing granted, or already held). */
  path: ObtainPath | null;
}

async function identityEvidence(
  ctx: ObtainContext,
  candidate: StorefrontCandidate,
  product: ProductPublic,
): Promise<IdentityEvidence | null> {
  // A product that does not run License has no licence to offer; a custom issuer or auto-linking
  // off means the platform subject keys nothing there (R5-01/R5-02).
  if (!candidate.identityEligible || !product.services.license.enabled)
    return null;
  const identity = await ctx.identity();
  if (!identity) return null;
  const { db, now } = ctx;
  // A persona's subject is synthetic: it is never looked up among real licences.
  const preview = await previewIdentityIssue(db, product, identity, now, {
    existing: ctx.persona === null,
  });
  if ("error" in preview) return { identity, existing: null, path: null };
  if (preview.existing)
    return { identity, existing: preview.existing, path: null };
  const tier = preview.tierId
    ? await getTier(db, product.slug, preview.tierId)
    : null;
  // The seat limit the minted licence will enforce: `licenseDeviceLimit` over the row
  // `activateFromIdentity` would insert (its tier and provisioned overrides; no licence
  // profiles, as a new licence has none).
  const would: LicenseRow = {
    product: product.slug,
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
    identity,
    existing: null,
    path: {
      kind: preview.via.kind === "group" ? "group" : "auto_issue",
      detail: preview.via.kind === "group" ? preview.via.group : null,
      terms: {
        tier: preview.tierId,
        tierLabel: tier?.label ?? null,
        // LX-08: `would`'s overrides already carry the provisioned keys, and a licence with no
        // id has no stored `oidc` grant, so the grant is not read (`core/payload.ts`).
        deviceLimit: await licenseDeviceLimit(db, product, would, now, {
          withoutOidcGrant: true,
        }),
        expiresAt: preview.expiresAt,
        expiryDays: tier?.policy_expiry_days ?? null,
      },
      action: "add",
      reason: discoverReason(preview.via),
    },
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────────────────────────

/** One candidate evaluated for one account, with the evidence a claim needs. Never serialised. */
export interface ObtainEvaluation {
  product: ProductPublic;
  listing: StorefrontListing;
  /** A licence linked to the account, a library entry, or a licence its platform subject holds. */
  held: boolean;
  /** Set when the identity paths could run (platform issuer, auto-link, License, an identity). */
  identity: IdentityEvidence | null;
  verdict: ObtainVerdict;
}

/**
 * Link targets for audience `everyone`: the listing's website, or a store page (`stores[]`) where a
 * channel release is reported live (a store link that leads to nothing yet is not a target).
 */
async function hasLinkTarget(
  ctx: ObtainContext,
  product: ProductPublic,
): Promise<boolean> {
  const delivery = ctx.delivery(product);
  if (!delivery) return false;
  const website = (await delivery.listing())?.website;
  if (typeof website === "string" && website.length > 0) return true;
  const downloads = await delivery.customerDownloads?.({
    channel: "stable",
    limit: 1,
  });
  return downloads?.stores.some((s) => s.live) ?? false;
}

/** Could anything make this candidate visible? If not, nothing is read for it. */
function couldShow(
  candidate: StorefrontCandidate,
  identity: OidcIdentity | null,
  sources: readonly PathSource[],
  links: boolean,
): boolean {
  const { listing } = candidate;
  if (listing.listed === "unlisted") return false;
  if (
    candidate.identityEligible &&
    identity !== null &&
    IDENTITY_PATH_KINDS.some((k) => pathCounts(listing, k))
  )
    return true;
  if (sources.some((s) => s.kinds.some((k) => pathCounts(listing, k))))
    return true;
  return (
    links && listing.listed === "listed" && listing.audience === "everyone"
  );
}

async function evaluateCandidate(
  ctx: ObtainContext,
  candidate: StorefrontCandidate,
  holds: boolean,
  opts: ObtainOptions,
): Promise<ObtainEvaluation | null> {
  const product = await loadProductPublic(ctx.db, candidate.slug);
  if (!product) return null;
  const { listing } = candidate;
  const identity = await identityEvidence(ctx, candidate, product);
  const found: ObtainPath[] = identity?.path ? [identity.path] : [];
  for (const source of opts.sources ?? STOREFRONT_SOURCES) {
    if (!source.kinds.some((k) => pathCounts(listing, k))) continue;
    found.push(...(await source.paths(ctx, candidate, product)));
  }
  const held = holds || (identity?.existing ?? null) !== null;
  const offered = offeredPaths(listing, found);
  const linkable =
    (opts.links ?? true) && wantsLink(listing, held, offered)
      ? await hasLinkTarget(ctx, product)
      : false;
  return {
    product,
    listing,
    held,
    identity,
    verdict: decideVerdict(listing, held, offered, linkable),
  };
}

/** Every product the account holds: a linked licence (any route) or a library entry (PS-04). */
async function heldProducts(db: Db, accountId: string): Promise<Set<string>> {
  const held = await listHeldProducts(db, accountId);
  for (const slug of await listLibraryEntryProducts(db, accountId))
    held.add(slug);
  return held;
}

/** One product visible to the account: its listing, its action and its offered paths. */
export interface StorefrontOffer {
  product: ProductPublic;
  listing: StorefrontListing;
  cta: "add" | "link";
  /** In evaluation order, the first being the tile's reason; empty for `link`. */
  paths: readonly ObtainPath[];
}

/**
 * Every product visible to the account, in name order (S-21 §6.3). Reads only. A held product is
 * skipped before any evaluation, as is every slug in `exclude`.
 */
export async function storefrontOffers(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
  opts: ObtainOptions = {},
): Promise<StorefrontOffer[]> {
  if (!(await polarisKeyStorefrontEnabled(db))) return [];
  const ctx = obtainContext(env, db, accountId, now, opts.hooksFor);
  const held = await heldProducts(db, accountId);
  const exclude = opts.exclude ?? new Set<string>();
  const sources = opts.sources ?? STOREFRONT_SOURCES;
  const out: StorefrontOffer[] = [];
  for (const row of await listStorefrontCandidates(db)) {
    if (held.has(row.slug) || exclude.has(row.slug)) continue;
    const candidate = storefrontCandidate(row);
    const identity = candidate.identityEligible ? await ctx.identity() : null;
    if (!couldShow(candidate, identity, sources, opts.links ?? true)) continue;
    const ev = await evaluateCandidate(ctx, candidate, false, opts);
    if (!ev?.verdict.visible) continue;
    out.push({
      product: ev.product,
      listing: ev.listing,
      cta: ev.verdict.cta,
      paths: ev.verdict.paths,
    });
  }
  return out;
}

/**
 * One product, evaluated for the account with the evidence a claim needs (`null` when it is not a
 * candidate at all: unknown, gone, portal off, unlisted, or the storefront switched off). A held
 * product IS evaluated, so a claim can answer the licence already held. Reads only. Callers must
 * answer `null` and a hidden verdict identically.
 */
export async function evaluateObtain(
  env: Env,
  db: Db,
  accountId: string,
  slug: string,
  now: number,
  opts: ObtainOptions = {},
): Promise<ObtainEvaluation | null> {
  if (!(await polarisKeyStorefrontEnabled(db))) return null;
  const [row] = await listStorefrontCandidates(db, slug);
  if (!row) return null;
  const candidate = storefrontCandidate(row);
  if (candidate.listing.listed === "unlisted") return null;
  const holds =
    (await accountHoldsProduct(db, accountId, slug)) ||
    (await listLibraryEntryProducts(db, accountId)).has(slug) ||
    (opts.exclude?.has(slug) ?? false);
  const ctx = obtainContext(env, db, accountId, now, opts.hooksFor);
  return evaluateCandidate(ctx, candidate, holds, opts);
}

/**
 * THE question (S-21 §6.3): can this account add this product now, by which paths, with what
 * terms? Unknown, unlisted, ineligible and held products all answer `{ visible: false }`, the
 * same frozen value. Reads only.
 */
export async function obtainPaths(
  env: Env,
  db: Db,
  accountId: string,
  slug: string,
  now: number,
  opts: ObtainOptions = {},
): Promise<ObtainVerdict> {
  return (
    (await evaluateObtain(env, db, accountId, slug, now, opts))?.verdict ??
    HIDDEN
  );
}

// ── The console's persona preview (PS-06) ────────────────────────────────────────────────────

/**
 * Why a persona does not see the product: the deployment switch is off, the product is not a
 * candidate at all (portal off, unlisted, not active), the persona holds it already, or no path
 * is offered to it (and no audience-`everyone` link applies).
 */
export type PersonaHidden =
  | "storefront_off"
  | "not_candidate"
  | "holds"
  | "no_path";

export interface PersonaPreview {
  /** What the persona would see: the engine's own verdict. */
  verdict: ObtainVerdict;
  /** The evaluated candidate, for the tile; `null` when the product is not a candidate. */
  evaluation: ObtainEvaluation | null;
  /** Why it is hidden, for the operator; `null` when visible. */
  hidden: PersonaHidden | null;
}

/**
 * "Who can see this?" (notes/S-21 §6.6, owner decision 11): the engine run for a SYNTHETIC person
 * against one product, exactly as a real account's listing runs it, but with every account fact
 * taken from the persona. No account row is read: not the platform identity (the persona's
 * groups and email domain are the identity), not the held set (`persona.holds`), and not a
 * licence by subject (`existing: false`). A product operator therefore learns nothing about any
 * person. Reads only, like the rest of the engine.
 */
export async function previewPersona(
  env: Env,
  db: Db,
  slug: string,
  persona: Persona,
  now: number,
  opts: ObtainOptions = {},
): Promise<PersonaPreview> {
  if (!(await polarisKeyStorefrontEnabled(db)))
    return { verdict: HIDDEN, evaluation: null, hidden: "storefront_off" };
  const [row] = await listStorefrontCandidates(db, slug);
  const candidate = row ? storefrontCandidate(row) : null;
  if (!candidate || candidate.listing.listed === "unlisted")
    return { verdict: HIDDEN, evaluation: null, hidden: "not_candidate" };
  const ctx = obtainContext(env, db, "", now, opts.hooksFor, persona);
  const ev = await evaluateCandidate(ctx, candidate, persona.holds, opts);
  if (!ev)
    return { verdict: HIDDEN, evaluation: null, hidden: "not_candidate" };
  return {
    verdict: ev.verdict,
    evaluation: ev,
    hidden: ev.verdict.visible ? null : ev.held ? "holds" : "no_path",
  };
}
