import type { PortalFileReason } from "./product.js";
import { PortalApiError, call, enc } from "./transport.js";

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
  /** PX-23: how it reached the person. */
  origin: PortalLicenseOrigin | (string & {});
  /** The store for `store-key` and `store` (`purchase.store`'s ids), else null. */
  originStore: string | null;
  /**
   * PX-23: Remove from my library is offered (its key can bring it back: an active key, on a
   * product that lets a key add a licence).
   */
  removable: boolean;
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
 * One offer as the portal shows it, from the Worker's answer (PS-04's shape). `null` for an offer this build cannot show honestly: an
 * action it does not know (S-22's `buy`), or an Add with no path to say why (Q-6).
 */
export function offerFromWire(raw: unknown): PortalDiscoverOffer | null {
  if (!isObject(raw) || typeof raw.product !== "string") return null;
  const cta = raw.cta;
  if (cta !== "add" && cta !== "link") return null;
  const terms = termsFrom(raw.offer);
  const paths =
    cta === "link" || !Array.isArray(raw.paths)
      ? []
      : raw.paths.flatMap((p) => pathFrom(p) ?? []);
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

export const libraryApi = {
  licenses: () => call<{ licenses: PortalLicenseSummary[] }>("/api/licenses"),

  license: (product: string, id: string) =>
    call<PortalLicenseDetail>(`/api/licenses/${enc(product)}/${enc(id)}`),

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

  previewKey: (key: string) =>
    call<PortalKeyPreview>("/api/activate/preview", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

  releases: () => call<{ releases: PortalRelease[] }>("/api/releases"),
};
