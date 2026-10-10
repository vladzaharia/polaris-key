import { returnUrl } from "./carriedKey.js";

export interface PortalAccount {
  id: string;
  name: string;
  email: string;
  /**
   * The picture in use (PX-W16): a same-origin `/media/avatar/<asset>` URL (256 px; `-96` names
   * the small one), or null for initials. Absent on an older Worker, which means initials.
   */
  avatarUrl?: string | null;
}

export interface PortalMe {
  account: PortalAccount;
  csrf: string;
}

/** The sign-in providers the login card can show (PORTAL.md §4.1), in display order. */
export type PortalProvider = "apple" | "google" | "steam";

export interface PortalCapabilities {
  auth: {
    oidc: boolean;
    magic: boolean;
    /**
     * The single sign-on provider's display name. Not sent by today's Worker (G11): the card
     * falls back to "Continue with single sign-on".
     */
    oidcName?: string;
    /**
     * Apple, Google and Steam for this context (G11, S-16). Not sent by today's Worker: the
     * provider row renders only when the list is present and non-empty.
     */
    providers?: PortalProvider[];
  };
  /**
   * The product named by `?product=`, for the login card's context header (G1/G28). Not sent by
   * today's Worker: without it the card shows no header rather than a slug.
   */
  product?: { slug: string; name: string; developerName?: string | null };
  /**
   * I-07: the public Turnstile site key the email start asks a token for; null (or absent on an
   * older Worker) when the deploy has Turnstile off and no token is asked for.
   */
  turnstileSiteKey?: string | null;
  modules: {
    licensing: boolean;
    claim: boolean;
    releases: boolean;
  };
}

export interface PortalEntitlement {
  key: string;
  label: string;
  value: unknown;
}

/**
 * How a licence reached the person (PX-23; notes/S-24 D21, SIGN-IN.md O-11): the Worker decides,
 * the card words it. An open set: a value this build does not know reads by the older facts.
 */
export type PortalLicenseOrigin =
  | "key"
  | "store-key"
  | "store"
  | "developer"
  | "signin";

export interface PortalLicenseSummary {
  id: string;
  product: string;
  productName: string;
  productBranding?: unknown;
  name: string;
  email: string;
  status: "active" | "disabled" | string;
  tier: string | null;
  activatedAt: number;
  expiresAt: number | null;
  maxOfflineDays: number | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
  identityProvider: "manual" | "oidc" | string;
  usable: boolean;
  keyCount: number;
  activeKeyCount: number;
  deviceCount: number;
  entitlements: PortalEntitlement[];
  /** PX-23: how it reached the person. Absent on an older Worker (the card then infers it). */
  origin?: PortalLicenseOrigin | (string & {});
  /** The store for `store-key` and `store` (`purchase.store`'s ids), else null. */
  originStore?: string | null;
  /**
   * PX-23: Remove from my library is offered (its key can bring it back: an active key, on a
   * product that lets a key add a licence). Absent on an older Worker, which offers no Remove.
   */
  removable?: boolean;
}

export interface PortalKey {
  hash: string;
  /**
   * The key's last 4 characters (PORTAL.md §4.17 masked display). Not stored by today's Worker
   * (G7, PX-W5): without it the mask is `pkey_<slug>_…`.
   */
  last4?: string;
  status: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PortalDevice {
  deviceId: string;
  status: string;
  firstSeen: number;
  lastSeen: number;
  label: string | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  sdkName: string | null;
  sdkVersion: string | null;
  ua: string | null;
}

export interface PortalLicenseDetail extends PortalLicenseSummary {
  keys: PortalKey[];
  devices: PortalDevice[];
}

export interface PortalArtifact {
  artifactId: string;
  name: string;
  kind: string | null;
  platform: string | null;
  arch: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  /** Distribution's delivery access for the release's deliverable (P2b-04). */
  access: "public" | "authenticated" | "licensed" | "entitled" | string;
  canDownload: boolean;
  /** Why not, when the per-product downloads view (PX-W2) said; `/api/releases` never does. */
  reason?: PortalFileReason | null;
}

export interface PortalRelease {
  product: string;
  productName: string;
  releaseId: string;
  version: string;
  title: string | null;
  notes: string | null;
  publishedAt: number | null;
  sourceUrl: string | null;
  artifacts: PortalArtifact[];
}

// ── Library and product views (PX-W1; docs/design/PORTAL.md G1, G5, G16) ──────────────────

/** A product's status from its best licence (§5.3, the statuses the Worker decides today). */
export type PortalStatus =
  | "suspended"
  | "expired"
  | "device_limit"
  | "expires_soon"
  | "active";

/**
 * A product's presentation; art is a hosted copy on the image host (HA-07), the same-origin
 * `/media/…` proxy path in HA-10's rollback, or null (`model/library.ts` `mediaUrl`).
 */
export interface PortalPresentation {
  name: string;
  developerName: string | null;
  tintColor: string | null;
  website: string | null;
  iconUrl: string | null;
  headerUrl: string | null;
  support: { url: string | null; email: string | null } | null;
}

/** One licence with its seats (G5). */
export interface PortalLicenseSeats {
  id: string;
  tier: string | null;
  status: PortalStatus;
  licenseStatus: string;
  activatedAt: number | null;
  expiresAt: number | null;
  maxOfflineDays: number | null;
  deviceLimit: number;
  activeSeatCount: number;
  deviceCount: number;
  dormantCount: number;
}

/** `GET /api/library`: one item per product, plus the Discover count once the Worker lists offers. */
export interface PortalLibrary {
  products: PortalLibraryItem[];
  /**
   * How many products this account could add from Discover (G24): every offer with something to
   * add, open products included, never a link (notes/S-21 §6.10 item 8). Absent until the Worker
   * can list offers (PX-W10): Discover then stays out of the nav, as the spec's fallback says.
   */
  discoverCount?: number;
}

/** A product held by a licence, or an open product's library entry (PS-04). */
export type PortalLibraryItem = PortalLicensedItem | PortalEntryItem;

interface PortalLibraryItemBase extends PortalPresentation {
  product: string;
  status: PortalStatus;
  addedAt: number | null;
}

export interface PortalLicensedItem extends PortalLibraryItemBase {
  /** Absent on a Worker before PS-04, which listed licences only. */
  kind?: "license";
  license: PortalLicenseSeats;
  licenseCount: number;
}

/**
 * An open product added from the storefront (PS-04, notes/S-21 §6.4): no licence and no seats,
 * always `active`. It leaves the library by `DELETE /api/library/<p>`, or by itself once the
 * account holds a licence for the product.
 */
export interface PortalEntryItem extends PortalLibraryItemBase {
  kind: "entry";
  /** How it was added: `open` today. */
  via: string;
  license: null;
  licenseCount: 0;
}

/** A library item that is an entry (PS-04), not a licence. */
export function isEntryItem(item: PortalLibraryItem): item is PortalEntryItem {
  return item.kind === "entry";
}

/**
 * `GET /api/library` as the portal reads it: licence items (`kind` `license`, or none from a
 * Worker before PS-04) and entries. An item of a kind this build doesn't know is left out rather
 * than shown as something it isn't.
 */
function libraryFromWire(body: PortalLibrary): PortalLibrary {
  return {
    ...body,
    products: (body.products ?? []).filter((p) =>
      p.kind === "entry"
        ? p.license === null
        : (p.kind === undefined || p.kind === "license") && p.license != null,
    ),
  };
}

export interface PortalProductDevice {
  deviceId: string;
  label: string | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  firstSeen: number;
  lastSeen: number;
  /** Past the dormancy window: holds no seat. */
  dormant: boolean;
}

export interface PortalProduct extends PortalPresentation {
  product: string;
  /** `entry`: an open product's library entry (PS-04), with no licences. */
  kind?: "license" | "entry";
  /** Each service's own toggle (e.g. `identity`); a section shows only for a service that is on. */
  services: Record<string, boolean>;
  status: PortalStatus;
  addedAt: number | null;
  /**
   * Where the focused flows may return to (PX-10): the product's declared origins and app
   * schemes. Absent on an older Worker, which means no return is followed.
   */
  returnTo?: { origins: string[]; schemes: string[] };
  /** Best first. */
  licenses: Array<
    PortalLicenseSeats & {
      entitlements: PortalEntitlement[];
      devices: PortalProductDevice[];
      /**
       * Where the licence came from (PX-W6, G8): `source` `store` with the store of the earliest
       * active purchase, else `developer`, `sign_in` or `free`. Null with License off; absent on
       * an older Worker. The portal reads only the store name (never order ids).
       */
      purchase?: { source: string; store: string | null } | null;
    }
  >;
}

// ── Downloads and store links (PX-W2; G2, G4) ──────────────────────────────────────────────

/** Why a file can't be downloaded by this account (the Worker's codes, never copy). */
export type PortalFileReason =
  | "license_inactive"
  | "not_entitled"
  | "not_hosted";

/** One file of a release, marked for this account by the token mint's own predicates. */
export interface PortalDownloadFile {
  releaseId: string;
  artifactId: string;
  version: string;
  name: string;
  buildId: string | null;
  platform: string | null;
  arch: string | null;
  format: string | null;
  role: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  minOs: string | null;
  canDownload: boolean;
  reason: PortalFileReason | null;
}

export interface PortalRecommendation {
  platform: string;
  label: string;
  releaseId: string;
  version: string;
  /** `files[0]` runs on every arch of the platform. */
  universal: boolean;
  /** `false`: an older covered release (an update window that ended, §5.4). */
  latest: boolean;
  files: PortalDownloadFile[];
}

export interface PortalStoreLink {
  id: string;
  kind: string;
  outletId: string;
  platforms: string[];
  label: string;
  url: string | null;
  deepLink: string | null;
  command: string | null;
  activateUrl: string | null;
  live: boolean;
  version: string | null;
}

export interface PortalDownloads {
  product: { slug: string; name: string };
  channel: string;
  /** `false`: no downloads here (every list is then empty). */
  available: boolean;
  access: string | null;
  detected: {
    platform: string | null;
    arch: string | null;
    touchAmbiguous: boolean;
  };
  latest: {
    releaseId: string;
    version: string;
    title: string | null;
    publishedAt: number | null;
  } | null;
  recommended: PortalRecommendation | null;
  platforms: Array<{
    platform: string;
    label: string;
    recommended: PortalRecommendation | null;
    files: PortalDownloadFile[];
  }>;
  extras: PortalDownloadFile[];
  stores: PortalStoreLink[];
  /** The download page's install sources (Homebrew, Scoop, AltStore, F-Droid, Obtainium…),
   *  shown under each platform so an owner sees every channel (P0-48). An older Worker omits it. */
  installSources?: PortalInstallSource[];
}

/**
 * One install source (P0-48): a store link's shape, where `deepLink` is the app's own link (the
 * one to open) and `url` the source or repository URL to paste by hand (a browser shows JSON or a
 * 404 there, so it is never the link).
 */
export interface PortalInstallSource extends PortalStoreLink {
  /** F-Droid only: the repository's signing-certificate SHA-256, else `null`. */
  fingerprint: string | null;
  /** A QR code of the deep link as a `data:image/svg+xml` URI, for a phone to scan; or `null`. */
  qr: string | null;
}

// ── Package access (F-21; PORTAL.md §4.20, §4.21, G13) ───────────────────────────────────

/** One private (non-public) feed a licensee may mint a token for. */
export interface PortalPackageFeed {
  ecosystem: string;
  accessMode: string;
  /** The feed's base URL on the registry host, when Distribution knows it. */
  baseUrl: string | null;
}

/** One token as the portal lists it: never the plaintext or the hash. */
export interface PortalRegistryToken {
  tokenId: string;
  label: string;
  /** The plaintext's last four characters. */
  hint: string;
  scopes: string[];
  /** `null` = every feed of the product. */
  ecosystems: string[] | null;
  presentation: "header" | "url";
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: "active" | "expired" | "revoked";
}

/** `GET /api/licenses/<p>/<id>/registry-tokens`: the Package access card's state. */
export interface PortalPackageAccess {
  /** An enabled, non-public feed exists: only then is the card shown. */
  available: boolean;
  licenseUsable: boolean;
  registryOrigin: string | null;
  username: string;
  feeds: PortalPackageFeed[];
  tokens: PortalRegistryToken[];
  limits: {
    minDays: number;
    maxDays: number;
    defaultDays: number;
    urlDefaultDays: number;
    perLicense: number;
  };
}

export interface PortalMintTokenInput {
  label: string;
  ecosystem?: string | null;
  presentation?: "header" | "url";
  expiresInDays?: number;
}

// ── Activate preview (PX-W5; G22) ──────────────────────────────────────────────────────────

export type PortalPreviewVerdict =
  | "addable"
  | "already_yours"
  | "license_owned"
  | "email_mismatch"
  | "portal_off"
  | "unknown";

/** What adding a key would do, before it is added (one evaluator with the claim). */
export interface PortalKeyPreview {
  verdict: PortalPreviewVerdict;
  product: {
    slug: string;
    name: string;
    developerName: string | null;
    iconUrl: string | null;
    headerUrl: string | null;
  } | null;
  license?: {
    id?: string;
    tier: string | null;
    tierLabel: string | null;
    status: string;
    usable: boolean;
    expiresAt: number | null;
    deviceLimit: number | null;
  };
  platforms?: string[];
  /**
   * `addable` only (PX-23, S-24 D22): how many devices the licence is already on; they keep
   * working and come with it. A count, never which. Absent on an older Worker.
   */
  devices?: number;
  /** `addable` only: the product runs Cloud Sync, so signing in on those devices turns it on. */
  cloudSync?: boolean;
  /** `email_mismatch` only: `m•••@proton.me`. */
  maskedEmail?: string;
  /**
   * PX-W9 (WIRE-CONTRACT-V4 §12.2 rule 8): the licence's key entries on an Identity product, for
   * `addable` and `already_yours`; `null` otherwise and with Identity off.
   */
  keyEntries?: PortalKeyEntries | null;
}

/** §12.2 rule 5: a licence's key entries. `used` may exceed `limit`; show `max(0, limit - used)`. */
export interface PortalKeyEntries {
  used: number;
  limit: number;
}

// ── Discover, the Polaris Key storefront (PX-W10, G24, G25; PS-04, notes/S-21 §6.3–6.5) ───────

/**
 * A path's reason code (owner decision Q-6: why is always shown). An open set: today
 * `free_with_account`, `group:<group>` and `open`; later paths add their own codes, which the
 * page words generically until it knows them.
 */
export type PortalDiscoverReason = string;

/** What adding the product would give the account, from the same policy as the claim. */
export interface PortalDiscoverTerms {
  tier: string | null;
  tierLabel: string | null;
  deviceLimit: number;
  /** The expiry a licence minted now would carry; `null` = never expires. */
  expiresAt: number | null;
  /** The tier's policy length in days (`null` = lifetime). */
  expiryDays: number | null;
}

/**
 * The obtain-path kinds this build words (notes/S-21 §6.3). An open set: a kind it does not know
 * reads by its reason code, generically.
 */
export type PortalObtainPathKind =
  | "store_owned"
  | "group"
  | "product_idp"
  | "email_domain"
  | "auto_issue"
  | "open";

/** One way the account could add the product now, in the Worker's evaluation order. */
export interface PortalObtainPath {
  kind: PortalObtainPathKind | (string & {});
  /** The group, store, IdP label or email domain; `null` when the path has none. */
  detail: string | null;
  /** The operator's label for a `group` path ("Aperture Seven"), else `null` (S-21 D10). */
  label: string | null;
  /** The licence the path would mint; `null` for a path that mints none (`open`). */
  terms: PortalDiscoverTerms | null;
  /** `add` today; S-22 adds `buy` and `upgrade`, which this build never offers. */
  action: "add";
  reason: PortalDiscoverReason;
}

/** One live store page of a product (`stores`): a link-only offer's actions, the page's "Also on". */
export interface PortalStorefrontStore {
  id: string;
  kind: string;
  label: string;
  /** An `https:` page. */
  url: string;
}

/**
 * One product Discover shows the account (`GET /api/discover`): something to add (`cta: "add"`,
 * at least one path), or an audience-`everyone` listing with nothing to add (`cta: "link"`, no
 * path), whose actions are its store pages. `offer` and `reason` are the first path's (PX-W10's
 * fields); `null` for a link, and `offer` `null` for a path that mints no licence (`open`).
 */
export interface PortalDiscoverOffer extends PortalPresentation {
  product: string;
  platforms: string[];
  /** The listing's one-line subtitle, or `null`. */
  shortDescription: string | null;
  cta: "add" | "link";
  paths: PortalObtainPath[];
  offer: PortalDiscoverTerms | null;
  reason: PortalDiscoverReason | null;
  /** A link's live store pages; empty for an offer to add (the product page lists them all). */
  stores: PortalStorefrontStore[];
}

/** `GET /api/discover/<p>`: the storefront product page, `404` for anything not visible. */
export interface PortalStorefrontProduct extends PortalDiscoverOffer {
  /** The listing's description (plain text), or `null`. */
  description: string | null;
  /** The listing's screenshots, as media URLs (`/media/<p>/screenshot-<n>` or hosted). */
  screenshots: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

function termsFrom(v: unknown): PortalDiscoverTerms | null {
  if (!isObject(v)) return null;
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  return {
    tier: strOrNull(v.tier),
    tierLabel: strOrNull(v.tierLabel),
    deviceLimit: num(v.deviceLimit) ?? 0,
    expiresAt: num(v.expiresAt),
    expiryDays: num(v.expiryDays),
  };
}

/** A path as this build can offer it, or `null` (not a path, or an action it cannot take). */
function pathFrom(v: unknown): PortalObtainPath | null {
  if (!isObject(v) || typeof v.kind !== "string" || v.action !== "add")
    return null;
  return {
    kind: v.kind,
    detail: strOrNull(v.detail),
    label: strOrNull(v.label),
    terms: termsFrom(v.terms),
    action: "add",
    reason: typeof v.reason === "string" ? v.reason : v.kind,
  };
}

/** A Worker before PS-04 sent no `paths`: its one reason and terms are the one path. */
function legacyPath(reason: string, terms: PortalDiscoverTerms | null) {
  const group = reason.startsWith("group:")
    ? reason.slice("group:".length)
    : null;
  return {
    kind:
      reason === "free_with_account"
        ? "auto_issue"
        : group !== null
          ? "group"
          : reason,
    detail: group,
    label: null,
    terms,
    action: "add" as const,
    reason,
  };
}

function storeFrom(v: unknown): PortalStorefrontStore | null {
  if (!isObject(v)) return null;
  const url = strOrNull(v.url);
  const label = strOrNull(v.label);
  if (!url || !/^https:\/\//.test(url) || !label) return null;
  return {
    id: strOrNull(v.id) ?? url,
    kind: strOrNull(v.kind) ?? "store",
    label,
    url,
  };
}

/**
 * One offer as the portal shows it, from the Worker's answer (PS-04's additive shape, or PX-W10's
 * older one: no `cta`, no `paths`). `null` for an offer this build cannot show honestly: an
 * action it does not know (S-22's `buy`), or an Add with no path to say why (Q-6).
 */
export function offerFromWire(raw: unknown): PortalDiscoverOffer | null {
  if (!isObject(raw) || typeof raw.product !== "string") return null;
  const cta = raw.cta ?? "add";
  if (cta !== "add" && cta !== "link") return null;
  const reason = typeof raw.reason === "string" ? raw.reason : null;
  const terms = termsFrom(raw.offer);
  const paths =
    cta === "link"
      ? []
      : Array.isArray(raw.paths)
        ? raw.paths.flatMap((p) => pathFrom(p) ?? [])
        : reason !== null
          ? [legacyPath(reason, terms)]
          : [];
  if (cta === "add" && paths.length === 0) return null;
  const stores = Array.isArray(raw.stores)
    ? raw.stores.flatMap((s) => storeFrom(s) ?? [])
    : [];
  const pres = raw as unknown as PortalPresentation;
  return {
    name: typeof raw.name === "string" ? raw.name : raw.product,
    developerName: strOrNull(pres.developerName),
    tintColor: strOrNull(pres.tintColor),
    website: strOrNull(pres.website),
    iconUrl: strOrNull(pres.iconUrl),
    headerUrl: strOrNull(pres.headerUrl),
    support: isObject(raw.support)
      ? {
          url: strOrNull(raw.support.url),
          email: strOrNull(raw.support.email),
        }
      : null,
    product: raw.product,
    platforms: Array.isArray(raw.platforms)
      ? raw.platforms.filter((p): p is string => typeof p === "string")
      : [],
    shortDescription: strOrNull(raw.shortDescription),
    cta,
    paths,
    offer: paths[0]?.terms ?? null,
    reason: paths[0]?.reason ?? null,
    stores,
  };
}

/** The storefront product page from the Worker's answer, or `null` when it can't be shown. */
export function storefrontProductFromWire(
  raw: unknown,
): PortalStorefrontProduct | null {
  const offer = offerFromWire(raw);
  if (!offer || !isObject(raw)) return null;
  return {
    ...offer,
    description: strOrNull(raw.description),
    screenshots: Array.isArray(raw.screenshots)
      ? raw.screenshots.filter((s): s is string => typeof s === "string")
      : [],
  };
}

/**
 * `POST /api/discover/<p>/claim`: what Add created (`added`) or found already held. A licence for
 * the identity paths, a library entry for an open product (PS-04, notes/S-21 §6.4); an older
 * Worker sends no `kind` (a licence).
 */
export type PortalDiscoverClaim = { added: boolean; product: string } & (
  | {
      kind?: "license";
      license: {
        id: string;
        tier: string | null;
        tierLabel: string | null;
        status: string;
        usable: boolean;
        expiresAt: number | null;
        deviceLimit: number;
      };
    }
  | { kind: "entry"; entry: { via: string; addedAt: number } }
);

// ── Account → Profile (PX-W16; PORTAL.md §4.30, G32, G33) ──────────────────────────────────

/** A stored picture: same-origin URLs only, WebP or PNG by the browser's `Accept`. */
export interface PortalAvatar {
  asset: string;
  /** 256 px. */
  url: string;
  /** 96 px. */
  url96: string;
}

/**
 * Where a profile value came from. `provider` is a sign-in method's import; its `provider` is null
 * once that method was disconnected (the value stays and follows nothing).
 */
export type PortalProfileSource =
  | { kind: "provider"; linkId: string; provider: string | null }
  | { kind: "typed" }
  | { kind: "upload" }
  | { kind: "initials" };

/** One sign-in method that supplied a name or a picture: the editor's chips and tiles. */
export interface PortalProfileSourceOption {
  linkId: string;
  /** `google`, `apple`, `steam`, later the platform identities. */
  provider: string;
  /** The connected identity (an address or a persona), as Sign-in methods shows it. */
  label: string | null;
  name: string | null;
  picture: PortalAvatar | null;
}

/** Where the birth date came from (I-33): typed here, or accepted from a connection's claim. */
export type PortalBirthdateSource =
  | { kind: "user" }
  | { kind: "connection"; connectionId: string };

/** `GET /api/me/profile`. */
export interface PortalProfile {
  /** The screen name. */
  displayName: string | null;
  displayNameSource: PortalProfileSource | null;
  explicitName: boolean;
  /** The picture in use; null shows initials. */
  picture: PortalAvatar | null;
  pictureSource: PortalProfileSource | null;
  explicitPicture: boolean;
  locale: string | null;
  sources: PortalProfileSourceOption[];
  /**
   * I-33: the optional birth date, `YYYY-MM-DD`, private to the person (no app or developer ever
   * receives it). Absent from a Worker before I-33.
   */
  birthdate?: string | null;
  birthdateSource?: PortalBirthdateSource | null;
}

/** `PATCH /api/me/profile`: every value it sets is an explicit choice that sticks. */
export interface PortalProfileChange {
  /** A typed name. */
  name?: string;
  /** A sign-in method's name, by the method's id. */
  nameFrom?: string;
  picture?: "initials" | { from: string } | { upload: string };
  /** I-33: a birth date (`YYYY-MM-DD`), or `null` to remove it. */
  birthdate?: string | null;
}

// ── Account → Sign-in methods (PX-W12, I-16; PORTAL.md §4.26, G27) ─────────────────────────

/** Why a method cannot be removed now: the account's only method, or its only email address. */
export type PortalRemoveRefusal = "last_link" | "only_email";

/** One sign-in method (`GET /api/me/methods` `methods[]`). */
export interface PortalMethod {
  /** The method's id: the path segment that disconnects it. */
  id: string;
  /** `google`, `apple`, `steam`, `email`, `passkey`, `gamecenter`, `pgs`, `eos`, `oidc` … */
  kind: string;
  group: "accounts" | "email" | "passkeys";
  /** The method by its own name ("Google", "Game Center"). */
  label: string;
  /** The connected identity: an address, a persona, a passkey's browser. */
  display: string | null;
  connectedAt: number;
  lastUsedAt: number | null;
  canRemove: boolean;
  reason: PortalRemoveRefusal | null;
  /** What the provider reported since linking (`consent_revoked`, …). */
  flag?: string | null;
  /** Apple only: a Hide My Email relay address. */
  relay?: boolean;
  /** Recognised only inside one developer's products (Game Center, Play Games). */
  tenantScoped?: boolean;
}

/** One verified address (`emails[]`), the primary first. */
export interface PortalMethodEmail {
  methodId: string;
  email: string;
  primary: boolean;
  connectedAt: number;
  lastUsedAt: number | null;
  canRemove: boolean;
  reason: PortalRemoveRefusal | null;
}

/** One passkey (I-16's `PasskeyView`, plus what the methods list adds). */
export interface PortalPasskey {
  /** The credential id (base64url): what a sign-in names it by. */
  id: string;
  /** Its sign-in method's id. */
  methodId: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string[];
  synced: boolean | null;
  /** The authenticator model, when the browser disclosed it. */
  aaguid: string | null;
  /** The browser it was added from ("Safari on macOS"). */
  addedFrom: string | null;
  canRemove?: boolean;
  reason?: PortalRemoveRefusal | null;
}

/** `GET /api/me/methods`. */
export interface PortalMethods {
  methods: PortalMethod[];
  emails: PortalMethodEmail[];
  passkeys: PortalPasskey[];
  /** Apple, Google and Steam, always; `available` says whether this deploy can connect it. */
  providers: {
    kind: PortalProvider;
    connected: boolean;
    available: boolean;
  }[];
  /** Whether a passkey can be added now, and why not. */
  passkey: { canAdd: boolean; reason: "email_unverified" | "limit" | null };
  primaryEmail: string | null;
  /** The primary email is an Apple Hide My Email relay. */
  hideMyEmail: boolean;
  /** Whether this session signed in recently enough (5 minutes) for a change. */
  stepUp: {
    authenticatedAt: number;
    freshUntil: number;
    fresh: boolean;
    maxAgeSeconds: number;
  };
}

/** `POST /api/me/methods/email/start`: a code went out, or the address is already this account's. */
export type PortalEmailMethodStart =
  | {
      status: "code_sent";
      email: string;
      expiresIn: number;
      codeLength: number;
    }
  | { status: "connected"; already: true; email: string };

/** A WebAuthn ceremony's options, as the Worker sends them (base64url strings). */
export interface PortalPasskeyOptions {
  options: Record<string, unknown>;
  expiresIn: number;
}

/** One live session of the account (`GET /api/sessions`, I-07), newest first. */
export interface PortalSession {
  /** The row key (a hash, never a cookie): the path segment that ends it. */
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** "Firefox on Windows", when known. */
  browser?: string | null;
  /** How it signed in (`passkey`, `email`, `google`, …). */
  methods: string[];
  /** This browser. */
  current: boolean;
}

/**
 * The email start's and the resend's one answer (I-07, PX-W4), the same whether or not mail went
 * out. The numbers are optional so an older Worker's bare `{ ok: true }` still reads.
 */
export interface PortalEmailSent {
  ok: true;
  /** Seconds the code and the link work. */
  expiresIn?: number;
  codeLength?: number;
  /** Seconds before "Send a new code" is accepted (the card's countdown). */
  resendIn?: number;
}

export class PortalApiError extends Error {
  /** A refusal's numeric extras the card shows (`triesLeft` on a wrong sign-in code). */
  triesLeft?: number;
  /** Seconds to wait before asking again (a resend asked too soon, PX-W4). */
  retryAfter?: number;
  /**
   * The case a refusal names beside its registered code (PX-W16's profile routes: `invalid_name`,
   * `too_large`, `unsupported_type` …). Copy is chosen from it, never from `message`.
   */
  reason?: string;
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(`portal api ${status}`);
    this.name = "PortalApiError";
  }
}

const CSRF_HEADER = "X-PKey-Portal-CSRF";
let csrf = "";

export function setPortalCsrf(token: string): void {
  csrf = token;
}

/** This tab started an email sign-in that has not finished yet (I-07). */
let signInPending = false;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const mutating = init.method != null && init.method !== "GET";
  if (mutating) {
    headers.set(CSRF_HEADER, csrf);
    // JSON unless the caller sent bytes with their own type (a picture upload).
    if (init.body && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  } catch {
    // Offline, DNS, a dropped connection: "Can't reach Polaris Key", never "signed out".
    throw new PortalApiError(0, "network");
  }
  if (!res.ok) {
    let code: string | undefined;
    let message: string | undefined;
    let triesLeft: number | undefined;
    let retryAfter: number | undefined;
    let reason: string | undefined;
    try {
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        triesLeft?: unknown;
        retryAfter?: unknown;
        reason?: unknown;
      };
      code = body.error;
      message = body.message;
      if (typeof body.triesLeft === "number") triesLeft = body.triesLeft;
      if (typeof body.retryAfter === "number") retryAfter = body.retryAfter;
      if (typeof body.reason === "string") reason = body.reason;
    } catch {
      // non-JSON response
    }
    const error = new PortalApiError(res.status, code);
    if (message) error.message = message;
    if (triesLeft !== undefined) error.triesLeft = triesLeft;
    if (retryAfter !== undefined) error.retryAfter = retryAfter;
    if (reason !== undefined) error.reason = reason;
    throw error;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export const portalApi = {
  capabilities: (product?: string | null) =>
    call<PortalCapabilities>(
      product
        ? `/api/capabilities?product=${enc(product)}`
        : "/api/capabilities",
    ),
  me: () => call<PortalMe>("/api/me"),
  deleteMe: () =>
    call<{ ok: true; deleted: string; erasing?: true }>("/api/me", {
      method: "DELETE",
    }),
  /** Account → Profile (PX-W16): the profile, its sources and what each method supplied. */
  profile: () => call<{ profile: PortalProfile }>("/api/me/profile"),
  /** An explicit choice (a typed or picked name; Initials, a method's picture or an upload). */
  updateProfile: (change: PortalProfileChange) =>
    call<{ profile: PortalProfile }>("/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify(change),
    }),
  /**
   * A picture upload (PNG or JPEG, at most 5 MB; the Worker judges by the bytes, re-encodes and
   * crops it square). It stays unused until a PATCH picks it.
   */
  uploadPicture: (file: Blob) =>
    call<{ upload: PortalAvatar }>("/api/me/profile/picture", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }),
  licenses: () => call<{ licenses: PortalLicenseSummary[] }>("/api/licenses"),
  license: (product: string, id: string) =>
    call<PortalLicenseDetail>(`/api/licenses/${enc(product)}/${enc(id)}`),
  /**
   * I-07's identifier-first email start: one email with a 6-digit code and a sign-in link
   * (SIGN-IN.md §3.4). `/api/magic/start` is the older alias of the same route.
   */
  startEmailSignIn: async (email: string) => {
    const out = await call<PortalEmailSent>("/api/signin/email/start", {
      method: "POST",
      // Never the carried license key (carriedKey.ts).
      body: JSON.stringify({ email, returnTo: returnUrl() }),
    });
    signInPending = true;
    return out;
  },
  /**
   * PX-W4: "Send a new code" for this tab's email sign-in. The Worker mails the same address
   * (and keeps where the sign-in was headed), asks for no new security check, and retires the
   * previous code and link; starting again would need a fresh Turnstile token and leave the old
   * link alive.
   */
  resendSignInCode: async () => {
    const out = await call<PortalEmailSent>("/api/signin/email/resend", {
      method: "POST",
    });
    signInPending = true;
    return out;
  },
  /** Redeems the emailed code for this browser's sign-in (the Worker sets the session cookie). */
  verifySignInCode: async (code: string) => {
    const out = await call<{ status: string; next?: string }>(
      "/api/signin/email/verify",
      { method: "POST", body: JSON.stringify({ code }) },
    );
    signInPending = false;
    return out;
  },
  /**
   * I-07: a sign-in link opened on another device only confirms THIS tab's sign-in; this tab
   * finishes it here (the Worker sets the session cookie). Asked only after this tab started
   * an email sign-in.
   */
  finishPendingSignIn: async (): Promise<boolean> => {
    if (!signInPending) return false;
    try {
      const out = await call<{ status: string }>("/api/signin/flow", {
        method: "POST",
      });
      if (out.status !== "pending") signInPending = false;
      return out.status === "signed_in";
    } catch {
      return false;
    }
  },
  claimKey: (key: string) =>
    call<{ ok: true; license: PortalLicenseSummary | null }>(
      "/api/claim/license-key",
      {
        method: "POST",
        body: JSON.stringify({ key }),
      },
    ),
  /**
   * PX-23 (S-24 D19): Remove from my library. The licence leaves the account and does not come
   * back to it by itself; its key adds it back.
   */
  removeLicense: (product: string, id: string) =>
    call<{ ok: true; product: string; licenseId: string }>(
      `/api/licenses/${enc(product)}/${enc(id)}`,
      { method: "DELETE" },
    ),
  disconnectDevice: (product: string, id: string, deviceId: string) =>
    call<{ ok: true; deviceId: string }>(
      `/api/licenses/${enc(product)}/${enc(id)}/devices/${enc(deviceId)}`,
      { method: "DELETE" },
    ),
  library: () => call<PortalLibrary>("/api/library").then(libraryFromWire),
  /** Discover's offers (PX-W10, PS-04), each as the portal can show it (`offerFromWire`). */
  discover: () =>
    call<{ offers?: unknown }>("/api/discover").then((body) => ({
      offers: Array.isArray(body?.offers)
        ? body.offers.flatMap((o) => offerFromWire(o) ?? [])
        : [],
    })),
  /** The storefront product page (PS-04): `404` for anything this account can't see. */
  storefrontProduct: async (product: string) => {
    const body = storefrontProductFromWire(
      await call<unknown>(`/api/discover/${enc(product)}`),
    );
    // An answer this build can't show reads like any product it can't see.
    if (!body) throw new PortalApiError(404, "not_found");
    return body;
  },
  /**
   * "Add to library" (G25, PS-04): through `path` (a kind the offer listed), or the offer's first
   * path when absent. Idempotent per product.
   */
  claimDiscover: (product: string, path?: string) =>
    call<PortalDiscoverClaim>(`/api/discover/${enc(product)}/claim`, {
      method: "POST",
      ...(path ? { body: JSON.stringify({ path }) } : {}),
    }),
  /** PS-04: remove a library ENTRY (an open product); a licence is never removed here.
   *  `inLibrary`: a licence keeps the product in the library (an entry a licence replaced
   *  meanwhile); absent from a Worker that predates it. */
  removeLibraryEntry: (product: string) =>
    call<{ ok: true; product: string; inLibrary?: boolean }>(
      `/api/library/${enc(product)}`,
      { method: "DELETE" },
    ),
  product: (product: string) =>
    call<PortalProduct>(`/api/products/${enc(product)}`),
  downloads: (product: string) =>
    call<PortalDownloads>(`/api/products/${enc(product)}/downloads`),
  previewKey: (key: string) =>
    call<PortalKeyPreview>("/api/activate/preview", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  releases: () => call<{ releases: PortalRelease[] }>("/api/releases"),
  packageAccess: (product: string, id: string) =>
    call<PortalPackageAccess>(
      `/api/licenses/${enc(product)}/${enc(id)}/registry-tokens`,
    ),
  mintRegistryToken: (
    product: string,
    id: string,
    input: PortalMintTokenInput,
  ) =>
    call<{ ok: true; token: string; view: PortalRegistryToken }>(
      `/api/licenses/${enc(product)}/${enc(id)}/registry-tokens`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  revokeRegistryToken: (product: string, id: string, tokenId: string) =>
    call<{ ok: true; view: PortalRegistryToken }>(
      `/api/licenses/${enc(product)}/${enc(id)}/registry-tokens/${enc(tokenId)}`,
      { method: "DELETE" },
    ),
  /** G23: email the account's own address a link to this product's download for `platform`. */
  emailDownload: (product: string, platform: string) =>
    call<{ ok: true }>(`/api/products/${enc(product)}/email-download`, {
      method: "POST",
      body: JSON.stringify({ platform }),
    }),
  downloadToken: (product: string, releaseId: string, artifactId: string) =>
    call<{ url: string }>(
      `/api/releases/${enc(product)}/${enc(releaseId)}/artifacts/${enc(artifactId)}/token`,
      { method: "POST" },
    ),
  /** Account → Sign-in methods (PX-W12): every method, grouped, and what each allows. */
  methods: () => call<PortalMethods>("/api/me/methods"),
  /** Connect Apple, Google or Steam: the provider URL to open (step-up first). */
  startProviderMethod: (kind: PortalProvider) =>
    call<{ redirect: string; expiresIn: number }>(
      `/api/me/methods/${enc(kind)}/start`,
      { method: "POST" },
    ),
  /** Add an email: a code to the address (the same answer whoever holds it). */
  startEmailMethod: (email: string) =>
    call<PortalEmailMethodStart>("/api/me/methods/email/start", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  verifyEmailMethod: (code: string) =>
    call<{ status: "connected"; already: boolean; email: string }>(
      "/api/me/methods/email/verify",
      { method: "POST", body: JSON.stringify({ code }) },
    ),
  /** Add a passkey, step 1: the registration challenge (I-16, through PX-W12's start). */
  passkeyRegistrationOptions: () =>
    call<PortalPasskeyOptions>("/api/me/methods/passkey/start", {
      method: "POST",
    }),
  /** Add a passkey, step 2: the browser's attestation. */
  addPasskey: (response: unknown) =>
    call<{ ok: true; passkey: { id: string; methodId: string } }>(
      "/api/me/passkeys",
      { method: "POST", body: JSON.stringify({ response }) },
    ),
  /** Disconnect a method (step-up; never the last one). */
  removeMethod: (id: string) =>
    call<{ ok: true; removed: { id: string; kind: string } }>(
      `/api/me/methods/${enc(id)}`,
      { method: "DELETE" },
    ),
  /** A passkey sign-in's challenge: how the account page confirms it's you (step-up). */
  passkeySignInOptions: () =>
    call<PortalPasskeyOptions>("/api/signin/passkey/options", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  passkeySignInVerify: (response: unknown) =>
    call<{ status: string }>("/api/signin/passkey/verify", {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
  /** Where you're signed in (I-07): the account's live sessions. */
  sessions: () => call<{ sessions: PortalSession[] }>("/api/sessions"),
  endSession: (id: string) =>
    call<{ ok: true; current: boolean }>(`/api/sessions/${enc(id)}`, {
      method: "DELETE",
    }),
  /** Every session and app of the account, this browser's included. */
  signOutEverywhere: () =>
    call<{ ok: true; ended: number; devices?: number }>(
      "/api/sessions/sign-out-everywhere",
      { method: "POST" },
    ),
};
