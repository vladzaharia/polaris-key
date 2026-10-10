import {
  isEntryItem,
  type PortalArtifact,
  type PortalDownloadFile,
  type PortalDownloads,
  type PortalLibraryItem,
  type PortalLicensedItem,
  type PortalLicenseOrigin,
  type PortalLicenseSummary,
  type PortalPresentation,
  type PortalRelease,
  type PortalStatus,
  type PortalStoreLink,
} from "../api.js";
import { PLATFORM_ORDER, type PlatformKey } from "../components/Glyphs.js";
import { t } from "../../lib/copy.js";

/**
 * The Library's model (PORTAL.md §5.3, §5.4; PX-02, PX-08): one product per library item, the
 * product's one status, its reason line and the one next action.
 *
 * `GET /api/library` (PX-W1) is the source of the product list: which products the account
 * holds, each one's status from the licence the Worker ranks best, presentation and same-origin
 * art (G1), the seats activation counts (G5) and support links (G16). The client only words the
 * Worker's status (§6.4: codes are never copy) and adds what the Worker leaves to the page:
 * a sign-in licence's quiet origin, "From signing in". `GET /api/licenses` supplies each product's
 * licence summaries (the product page's switcher and key facts), `GET /api/products/<p>/downloads`
 * (PX-W2) the server-detected build and the live store links for the quick action, and
 * `GET /api/releases` the fallback while a downloads view hasn't answered. Steam-key states wait
 * for G8.
 */

export type StatusKind =
  | "suspended"
  | "expired"
  | "deviceLimit"
  | "keyNotActivated"
  | "expiresSoon"
  | "offlineGrace"
  | "signedInApp"
  | "active"
  /** An open product's library entry (PS-04): nothing to licence, so "Free to use". */
  | "freeToUse";

export type StatusTone = "danger" | "warning" | "info" | "neutral" | "success";

export interface ProductStatus {
  kind: StatusKind;
  /** The pill's word(s): "Expires in 9 days". */
  label: string;
  tone: StatusTone;
  /** The reason line, in visible text: "Ended 4 Sep 2026", "Lifetime · 2 devices". */
  note: string;
  /** Not "Active" or "From signing in": counted by the Needs attention filter. */
  attention: boolean;
}

/** The presentation fields a product may carry (G1/G16 names); each may be absent. */
export interface Presentation {
  developer: string | null;
  tint: string | null;
  website: string | null;
  supportUrl: string | null;
  supportEmail: string | null;
  /**
   * The hosted copy on the image host (HA-07), the same-origin `/media/…` proxy path in HA-10's
   * rollback, or null for the letter-on-tint fallback (`mediaUrl`).
   */
  iconUrl: string | null;
  headerUrl: string | null;
}

/** The best licence's seats as activation counts them (G5); null when the Worker didn't say. */
export interface Seats {
  limit: number;
  inUse: number;
}

interface LibraryProductBase {
  slug: string;
  name: string;
  presentation: Presentation;
  status: ProductStatus;
  /**
   * When the product joined the library: the Worker's first contact (PX-W1's `addedAt`), else its
   * newest license's activation; an entry's (PS-04), when the entry was added.
   */
  addedAt: number;
  /**
   * "Added just now" (PX-24; EXPERIENCE §0.6 P1 step 7): the Worker's `addedAt` is under 24 hours
   * old (`isJustAdded`). The tile then carries a ring and the text, and leads with its download.
   */
  justAdded: boolean;
  /** This product's releases, newest first. */
  releases: PortalRelease[];
  latestVersion: string | null;
  platforms: PlatformKey[];
  /**
   * The per-product downloads view (PX-W2): the server-detected build and the store links. `null`
   * when the Worker has none for this product; `undefined` while it hasn't answered.
   */
  downloads?: PortalDownloads | null;
  /** Stores reporting a live release with a link to open ("Also yours on", §4.13). */
  stores: PortalStoreLink[];
}

/** A product the account holds a licence for. */
export interface LicensedProduct extends LibraryProductBase {
  kind: "license";
  licenses: PortalLicenseSummary[];
  /** The license the product page and tile describe (best by §5.3 precedence). */
  best: PortalLicenseSummary;
  /** Devices using a seat on the best license. */
  deviceCount: number;
  /** The seat limit and use (G5), as the Worker counted them on the best licence. */
  seats: Seats | null;
}

/**
 * An open product in the library through an entry (PS-04, notes/S-21 §6.4): no licence, so no
 * licence card, no seats and no devices; "Free to use", Get it, and Remove from library.
 */
export interface EntryProduct extends LibraryProductBase {
  kind: "entry";
  licenses: readonly [];
  best: null;
  deviceCount: 0;
  seats: null;
}

/** One library item: a licensed product, or an open product's entry. */
export type LibraryProduct = LicensedProduct | EntryProduct;

/** The status an entry always has (PS-04): healthy, quiet, never an issue. */
export const FREE_TO_USE: ProductStatus = {
  kind: "freeToUse",
  label: "Free to use",
  tone: "neutral",
  note: "Free to use",
  attention: false,
};

const DAY = 86_400;
export const EXPIRES_SOON_DAYS = 14;

/** How long a new product stays "Added just now" (EXPERIENCE §0.6 P1 step 7, §0.7): 24 hours. */
export const JUST_ADDED_SECONDS = DAY;

/**
 * Whether a product is "just added" (PX-24): `0 ≤ now − addedAt < 24 h`, both in seconds.
 *
 * `addedAt` is the Worker's, and it is the account's **first contact** with the product (the
 * pairwise subject's creation, `library.ts` `addedAt()`), not the latest attach: a product added
 * again after Remove from my library, or a licence attached where an earlier sign-in already made
 * the subject, keeps its old date and is not just added. A future `addedAt` (this device's clock
 * behind the server's) counts as now; a missing one is never just added. `now` is the browser's
 * clock, so a wrong one can only show or hide a quiet cue, never decide anything.
 */
export function isJustAdded(
  addedAt: number | null | undefined,
  now: number,
): boolean {
  if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) return false;
  return Math.max(0, now - addedAt) < JUST_ADDED_SECONDS;
}

const PRECEDENCE: readonly StatusKind[] = [
  "suspended",
  "expired",
  "deviceLimit",
  "keyNotActivated",
  "expiresSoon",
  "offlineGrace",
  "signedInApp",
  "active",
  "freeToUse",
];

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** `productBranding` read for the listing fields it may carry; today's Worker sends null. */
export function readPresentation(branding: unknown): Presentation {
  const b =
    branding && typeof branding === "object"
      ? (branding as Record<string, unknown>)
      : {};
  const tint = str(b.tintColor);
  const https = (v: unknown): string | null => {
    const s = str(v);
    return s && /^https:\/\//.test(s) ? s : null;
  };
  return {
    developer: str(b.developerName),
    tint: tint && /^#[0-9a-fA-F]{6}$/.test(tint) ? tint : null,
    website: https(b.website),
    supportUrl: https(b.supportUrl),
    supportEmail: str(b.supportEmail),
    iconUrl: null,
    headerUrl: null,
  };
}

/** The image host's content-addressed paths (HA-02): an original or one of its WebP widths. */
const HOSTED_PATH =
  /^\/[a-z0-9-]{1,64}\/a\/[0-9a-f]{64}(?:\/[1-9][0-9]{0,3}\.webp)?$/;

/**
 * Art the portal may show, never a developer host (CSP, §G1): a hosted copy on the image host
 * (HA-07; the Worker builds it from the copy's hash), which is an `https:` URL whose path is the
 * host's content-addressed shape and which carries nothing else (no credentials, no port, no
 * query, no fragment; `http:` only on a loopback host, for local development); or, in HA-10's
 * rollback, the same-origin proxy's `/media/…` path. Anything else reads as no art. The page's
 * policy is the boundary: its `img-src` admits this origin, the image host and `data:`, so a URL
 * of the right shape on any other host would still not load.
 */
export function mediaUrl(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  if (v.startsWith("/media/")) return v;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const scheme =
    u.protocol === "https:" || (u.protocol === "http:" && loopback);
  const bare =
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    (u.port === "" || loopback);
  return scheme && bare && HOSTED_PATH.test(u.pathname) && u.href === v
    ? v
    : null;
}

/** The server-side library's presentation (PX-W1), validated like the branding fallback. */
export function presentationFrom(item: PortalPresentation): Presentation {
  const base = readPresentation({
    developerName: item.developerName,
    tintColor: item.tintColor,
    website: item.website,
    supportUrl: item.support?.url,
    supportEmail: item.support?.email,
  });
  return {
    ...base,
    iconUrl: mediaUrl(item.iconUrl),
    headerUrl: mediaUrl(item.headerUrl),
  };
}

/** "studio" → "Studio". A tier id is all today's API gives; this is its display fallback. */
export function tierLabel(tier: string | null): string | null {
  if (!tier) return null;
  const words = tier.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : null;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "14 Sep 2026" (the spec's form; `Intl`'s en-GB writes "Sept"), in the viewer's time zone. */
export function formatDay(epochSeconds: number, withYear = true): string {
  const d = new Date(epochSeconds * 1000);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return withYear ? `${day} ${d.getFullYear()}` : day;
}

/** "2 devices", or "2 of 3 devices" when the seat limit is known (G5). */
export function devicesText(n: number, limit?: number | null): string {
  if (limit != null && limit > 0)
    return `${n} of ${limit} ${limit === 1 ? "device" : "devices"}`;
  return `${n} ${n === 1 ? "device" : "devices"}`;
}

/**
 * Every licence is account-bound, so none is labelled by type: how it came to be is a quiet
 * origin in plain words (owner decision, 2026-10-05: no "Account-wide" label).
 */
export const FROM_SIGNING_IN = t("signin.choice.origin.signIn");

/**
 * The **License source** of a licence granted automatically through OIDC, by the product's
 * auto-issue or a group grant when the person signed in (the Worker's `signin` origin): "Automatic
 * grant", sentence case (owner polish 2026-10-07; P0-36). The status line and the picker keep
 * "From signing in" and "Sign-in" until the catalog's `signin.choice.origin.signIn` takes this
 * wording too.
 */
export const AUTOMATIC_GRANT = "Automatic grant";

/**
 * A licence issued by signing in (`identityProvider` "oidc") with no key. Activation counts its
 * seats like any other licence's.
 */
export function isSignInLicense(
  l: Pick<PortalLicenseSummary, "identityProvider" | "keyCount">,
): boolean {
  return l.identityProvider === "oidc" && l.keyCount === 0;
}

/** A store's name as customers know it (`purchase.store`, PX-W6); unknown ids read as given. */
export function storeName(store: string): string {
  return STORE_NAMES[store] ?? store;
}

const STORE_NAMES: Record<string, string> = {
  "app-store": "App Store",
  play: "Google Play",
  steam: "Steam",
  "microsoft-store": "Microsoft Store",
  itch: "itch.io",
  "polaris-key": "Polaris Key",
};

/** What a licence's origin is read from: the summary, its keys' known last characters (G7),
 * the store of an active purchase on it (`purchase.store`, PX-W6; store name only) and the
 * developer's name (G1), for "From <Developer>". */
export interface OriginFacts {
  keys?: readonly { last4?: string }[];
  store?: string | null;
  developer?: string | null;
}

type OriginSummary = Pick<
  PortalLicenseSummary,
  "identityProvider" | "keyCount" | "origin" | "originStore"
>;

const ORIGIN_KINDS: readonly PortalLicenseOrigin[] = [
  "key",
  "store-key",
  "store",
  "developer",
  "signin",
];

/**
 * How the licence reached the person: the Worker's `origin` (PX-23, S-24 D21) when it sent one
 * this build knows, else inferred from the older facts (a key, a store purchase, a sign-in) as
 * before; an older Worker never says "developer" for a licence with a key.
 */
function originOf(
  l: OriginSummary,
  facts: OriginFacts,
): { kind: PortalLicenseOrigin; store: string | null } {
  const store = l.originStore ?? facts.store ?? null;
  const hasKey = l.keyCount > 0 || (facts.keys ?? []).length > 0;
  if (l.origin && (ORIGIN_KINDS as readonly string[]).includes(l.origin)) {
    const kind = l.origin as PortalLicenseOrigin;
    // A store origin with no store named reads by its other facts, never " key" or "From ".
    if (kind === "store-key" && !store) return { kind: "key", store: null };
    if (kind === "store" && !store) return { kind: "developer", store: null };
    return { kind, store };
  }
  if (store) return { kind: hasKey ? "store-key" : "store", store };
  if (hasKey) return { kind: "key", store: null };
  if (isSignInLicense(l)) return { kind: "signin", store: null };
  return { kind: "developer", store: null };
}

/**
 * The licence's origin in plain words (owner, 2026-10-05; S-24 D21): "Key ending 3WPLDA" (or
 * "Added with a key" while the key's last characters aren't kept, G7) for a key the person
 * added, "Steam key ending 3WPLDA" (or "Steam key") for a store key, "From Steam" for a
 * store-bound licence with no key, "From Tidewater Labs" for a licence the developer assigned
 * (even though it has a key; "From the developer" without a name), "Automatic Grant" for one
 * granted through OIDC at sign-in (owner polish 2026-10-07).
 */
export function licenseOrigin(
  l: OriginSummary,
  facts: OriginFacts = {},
): string {
  const { kind, store } = originOf(l, facts);
  const last = (facts.keys ?? []).find((k) => k.last4)?.last4;
  switch (kind) {
    case "store-key": {
      const name = storeName(store ?? "");
      return last
        ? t("signin.choice.origin.storeKey", { store: name, last6: last })
        : t("signin.choice.origin.storeKeyAdded", { store: name });
    }
    case "store":
      // "From the App Store", "From Steam", "From Google Play".
      return t("signin.choice.origin.store", {
        store: store === "app-store" ? "the App Store" : storeName(store ?? ""),
      });
    case "key":
      return last
        ? t("signin.choice.origin.key", { last6: last })
        : t("signin.choice.origin.keyAdded");
    case "signin":
      return AUTOMATIC_GRANT;
    case "developer":
      return `From ${facts.developer?.trim() || "the developer"}`;
  }
}

/**
 * The licence picker's short origin: "Sign-in", "Key …3WPLDA", "Steam key …3WPLDA", "Steam",
 * "Key", "From Tidewater Labs" for a licence the developer assigned; null for one from a
 * developer with no name (the tier says enough).
 */
export function shortOrigin(
  l: OriginSummary,
  facts: OriginFacts = {},
): string | null {
  const { kind, store } = originOf(l, facts);
  const last = (facts.keys ?? []).find((k) => k.last4)?.last4;
  switch (kind) {
    case "store-key": {
      const word = `${storeName(store ?? "")} key`;
      return last ? `${word} …${last}` : word;
    }
    case "store":
      return storeName(store ?? "");
    case "key":
      return last ? `Key …${last}` : "Key";
    case "signin":
      return "Sign-in";
    case "developer":
      return facts.developer?.trim() ? `From ${facts.developer.trim()}` : null;
  }
}

/** §5.3: one status per license, first match wins. */
export function licenseStatus(
  l: PortalLicenseSummary,
  now: number,
  /** The seats the Worker counted (G5); without them the device limit is never guessed. */
  seats?: Seats | null,
): ProductStatus {
  const tier = tierLabel(l.tier);
  if (l.status !== "active") {
    return {
      kind: "suspended",
      label: "Suspended",
      tone: "danger",
      note: "Suspended by the developer.",
      attention: true,
    };
  }
  if (l.expiresAt !== null && l.expiresAt <= now) {
    return {
      kind: "expired",
      label: t("part.status.expired"),
      tone: "danger",
      note: `Ended ${formatDay(l.expiresAt)}`,
      attention: true,
    };
  }
  if (seats && seats.limit > 0 && seats.inUse >= seats.limit) {
    return {
      kind: "deviceLimit",
      label: t("core.codes.device_limit.title"),
      tone: "danger",
      note: [tier, `${devicesText(seats.inUse, seats.limit)} in use`]
        .filter(Boolean)
        .join(" · "),
      attention: true,
    };
  }
  if (l.expiresAt !== null && l.expiresAt - now <= EXPIRES_SOON_DAYS * DAY) {
    const days = Math.max(1, Math.ceil((l.expiresAt - now) / DAY));
    return {
      kind: "expiresSoon",
      label: days === 1 ? "Expires tomorrow" : `Expires in ${days} days`,
      tone: "warning",
      note: [tier, `ends ${formatDay(l.expiresAt, false)}`]
        .filter(Boolean)
        .join(" · "),
      attention: true,
    };
  }
  if (isSignInLicense(l)) {
    return {
      kind: "signedInApp",
      label: FROM_SIGNING_IN,
      tone: "neutral",
      note: [
        tier ?? "Standard",
        FROM_SIGNING_IN,
        devicesText(seats ? seats.inUse : l.deviceCount, seats?.limit),
      ].join(" · "),
      attention: false,
    };
  }
  const until = l.expiresAt !== null ? `until ${formatDay(l.expiresAt)}` : null;
  return {
    kind: "active",
    label: t("part.status.ok"),
    tone: "success",
    note: [
      tier,
      until,
      devicesText(seats ? seats.inUse : l.deviceCount, seats?.limit),
    ]
      .filter(Boolean)
      .join(" · "),
    attention: false,
  };
}

/** The best license: the most favourable status, then the newest. */
export function bestLicense(
  licenses: readonly PortalLicenseSummary[],
  now: number,
): PortalLicenseSummary {
  return [...licenses].sort((a, b) => {
    const ra = PRECEDENCE.indexOf(licenseStatus(a, now).kind);
    const rb = PRECEDENCE.indexOf(licenseStatus(b, now).kind);
    if (ra !== rb) return rb - ra;
    return b.activatedAt - a.activatedAt;
  })[0]!;
}

export function normalisePlatform(p: string | null): PlatformKey | null {
  if (!p) return null;
  const v = p.toLowerCase();
  if (v === "ipados") return "ios";
  if (v === "steamos") return "linux";
  return (PLATFORM_ORDER as readonly string[]).includes(v)
    ? (v as PlatformKey)
    : null;
}

/** A device's `X-PKey-Platform` value that is a header value only, not a download platform
 *  (WIRE-CONTRACT-V4 §5.2 rule 5): the device rows show these, the download vocabulary does not. */
export type HeaderOnlyPlatform = "tvos" | "visionos" | "watchos";
const HEADER_ONLY_PLATFORMS: readonly HeaderOnlyPlatform[] = [
  "tvos",
  "visionos",
  "watchos",
];

/** The family a stored device platform belongs to, for its glyph: a download platform, one of
 *  the header-only Apple values, or null. */
export function deviceFamily(
  p: string | null,
): PlatformKey | HeaderOnlyPlatform | null {
  const v = p?.toLowerCase() ?? "";
  if ((HEADER_ONLY_PLATFORMS as readonly string[]).includes(v))
    return v as HeaderOnlyPlatform;
  return normalisePlatform(p);
}

/** The licence summary a library item stands for, when `GET /api/licenses` hasn't listed it. */
function summaryFromItem(item: PortalLicensedItem): PortalLicenseSummary {
  const l = item.license;
  return {
    id: l.id,
    product: item.product,
    productName: item.name,
    name: "",
    email: "",
    status: l.licenseStatus,
    tier: l.tier,
    activatedAt: l.activatedAt ?? item.addedAt ?? 0,
    expiresAt: l.expiresAt,
    maxOfflineDays: l.maxOfflineDays,
    channels: [],
    minVersion: null,
    maxVersion: null,
    identityProvider: "manual",
    usable: l.status !== "suspended" && l.status !== "expired",
    keyCount: 0,
    activeKeyCount: 0,
    deviceCount: l.deviceCount,
    entitlements: [],
  };
}

/**
 * The Worker's status for a product (§5.3, `GET /api/library`), in words. The precedence is the
 * Worker's; the page only phrases it, and words an `active` sign-in licence (no key) by its quiet
 * origin, "From signing in". `lastCovered` is the newest version an expired licence still
 * downloads, for "Updates ended at 1.8".
 */
export function statusFromServer(
  status: PortalStatus,
  best: PortalLicenseSummary,
  seats: Seats | null,
  now: number,
  developer: string | null = null,
  lastCovered: string | null = null,
): ProductStatus {
  const tier = tierLabel(best.tier);
  switch (status) {
    case "suspended":
      return {
        kind: "suspended",
        label: "Suspended",
        tone: "danger",
        note: `Suspended by ${developer ?? "the developer"}.`,
        attention: true,
      };
    case "expired":
      return {
        kind: "expired",
        label: t("part.status.expired"),
        tone: "danger",
        note: lastCovered
          ? `Updates ended at ${lastCovered}`
          : best.expiresAt
            ? `Ended ${formatDay(best.expiresAt)}`
            : "Ended",
        attention: true,
      };
    case "device_limit":
      return {
        kind: "deviceLimit",
        label: t("core.codes.device_limit.title"),
        tone: "danger",
        note: seats
          ? devicesText(seats.inUse, seats.limit)
          : "Every device is in use",
        attention: true,
      };
    case "expires_soon": {
      const at = best.expiresAt ?? now;
      const days = Math.max(1, Math.ceil((at - now) / DAY));
      return {
        kind: "expiresSoon",
        label: days === 1 ? "Expires tomorrow" : `Expires in ${days} days`,
        tone: "warning",
        note: [tier, `ends ${formatDay(at, false)}`]
          .filter(Boolean)
          .join(" · "),
        attention: true,
      };
    }
    default:
      return licenseStatus(best, now, seats);
  }
}

/** Platforms a downloads view offers a file for, in display order. */
function platformsFromDownloads(d: PortalDownloads): PlatformKey[] {
  const set = new Set<PlatformKey>();
  for (const p of d.platforms) {
    const k = normalisePlatform(p.platform);
    if (k && p.files.length > 0) set.add(k);
  }
  for (const st of d.stores)
    if (st.live)
      for (const p of st.platforms) {
        const k = normalisePlatform(p);
        if (k) set.add(k);
      }
  return PLATFORM_ORDER.filter((p) => set.has(p));
}

/**
 * One product per library item (PX-08), in the Worker's order. Licence summaries attach by product
 * (the product page's switcher); releases and downloads views attach by slug.
 */
export function buildLibrary(
  items: readonly PortalLibraryItem[],
  licenses: readonly PortalLicenseSummary[],
  releases: readonly PortalRelease[],
  now: number,
  downloads?: ReadonlyMap<string, PortalDownloads | null>,
): LibraryProduct[] {
  const out: LibraryProduct[] = [];
  for (const item of items) {
    const slug = item.product;
    const ownReleases = releases
      .filter((r) => r.product === slug)
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    const d = downloads?.get(slug);
    const usable = d && d.available ? d : null;
    let platforms: PlatformKey[];
    if (usable) platforms = platformsFromDownloads(usable);
    else {
      const set = new Set<PlatformKey>();
      for (const r of ownReleases)
        for (const a of r.artifacts) {
          const p = normalisePlatform(a.platform);
          if (p) set.add(p);
        }
      platforms = PLATFORM_ORDER.filter((p) => set.has(p));
    }
    const presentation = presentationFrom(item);
    const common = {
      slug,
      presentation,
      releases: ownReleases,
      latestVersion: usable?.latest?.version ?? ownReleases[0]?.version ?? null,
      platforms,
      downloads: d,
      stores: (usable?.stores ?? []).filter((st) => st.live && st.url),
    };
    if (isEntryItem(item)) {
      out.push({
        ...common,
        kind: "entry",
        name: item.name || slug,
        licenses: [],
        best: null,
        status: FREE_TO_USE,
        addedAt: item.addedAt ?? 0,
        // An entry's date is the Worker's own (when it was added): a new product in the library.
        justAdded: isJustAdded(item.addedAt, now),
        deviceCount: 0,
        seats: null,
      });
      continue;
    }
    const own = licenses.filter((l) => l.product === slug);
    const best =
      own.find((l) => l.id === item.license.id) ?? summaryFromItem(item);
    const list = own.some((l) => l.id === best.id) ? own : [best, ...own];
    const seats: Seats | null =
      item.license.deviceLimit > 0
        ? {
            limit: item.license.deviceLimit,
            inUse: item.license.activeSeatCount,
          }
        : null;
    const lastCovered =
      usable?.recommended && !usable.recommended.latest
        ? usable.recommended.version
        : null;
    out.push({
      ...common,
      kind: "license",
      name: item.name || best.productName || slug,
      licenses: list,
      best,
      status: statusFromServer(
        item.status,
        best,
        seats,
        now,
        presentation.developer,
        lastCovered,
      ),
      addedAt: item.addedAt ?? Math.max(...list.map((l) => l.activatedAt)),
      // The Worker's own date only: the activation fallback above is not a first contact.
      justAdded: isJustAdded(item.addedAt, now),
      deviceCount: seats ? seats.inUse : item.license.deviceCount,
      seats,
    });
  }
  return out;
}

// ── the device in hand ────────────────────────────────────────────────────────────────────────

export interface DeviceInHand {
  os: PlatformKey | null;
  phone: boolean;
}

/** The visitor's OS from the user agent. Never the CPU architecture (§0.1 rule 8). */
export function detectDevice(
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === "undefined"
    ? 0
    : navigator.maxTouchPoints,
): DeviceInHand {
  if (/iPhone|iPad|iPod/.test(ua)) return { os: "ios", phone: true };
  // iPadOS reports a Mac user agent; touch points give it away.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1)
    return { os: "ios", phone: true };
  if (/Android/.test(ua)) return { os: "android", phone: true };
  if (/Windows/.test(ua)) return { os: "windows", phone: false };
  if (/Macintosh|Mac OS X/.test(ua)) return { os: "macos", phone: false };
  if (/Linux|X11|CrOS/.test(ua)) return { os: "linux", phone: false };
  return { os: null, phone: false };
}

// ── the one next action (§5.4) ────────────────────────────────────────────────────────────────

export type QuickAction =
  | {
      kind: "download";
      label: string;
      /** The second line of the hero's primary: "Version 1.4.2 · Universal · 2.1 GB". */
      detail: string;
      release: PortalRelease;
      artifact: PortalArtifact;
    }
  | {
      kind: "link";
      label: string;
      href: string;
      icon: "downloads" | "open" | "details" | "store" | "device";
      external?: boolean;
    }
  | {
      /** G23 on a phone: email the account's own address the download for `platform`. */
      kind: "email";
      label: string;
      platform: PlatformKey;
    };

export function formatSize(bytes: number | null): string | null {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function archName(a: PortalArtifact): string | null {
  const arch = (a.arch ?? "").toLowerCase();
  if (!arch || arch === "any" || arch === "universal") return "Universal";
  if (a.platform === "macos")
    return arch === "arm64"
      ? "Apple silicon"
      : arch === "x86_64"
        ? "Intel"
        : arch;
  return arch === "x86_64" ? "x64" : arch;
}

/** Covered builds for one OS in one release. */
function buildsFor(r: PortalRelease, os: PlatformKey): PortalArtifact[] {
  return r.artifacts.filter(
    (a) => a.canDownload && normalisePlatform(a.platform) === os,
  );
}

/** The one artifact the quick action may start, or null when the choice is the person's. */
function pickBuild(builds: PortalArtifact[]): PortalArtifact | null {
  if (builds.length === 1) return builds[0]!;
  const universal = builds.find((a) => archName(a) === "Universal");
  // Two Mac builds and no Universal one: both are shown on the page, Apple silicon first; the
  // site never guesses the CPU.
  return universal ?? null;
}

/** The phone stores, by the OS they serve. */
const PHONE_STORE: Partial<Record<PlatformKey, readonly string[]>> = {
  ios: ["app-store"],
  android: ["play"],
};

/** "Get it on the App Store" / "Get it on Google Play" / "Get it on Steam". */
export function storeActionLabel(s: PortalStoreLink): string {
  if (s.kind === "app-store") return "Get it on the App Store";
  if (s.kind === "play") return "Get it on Google Play";
  return `Get it on ${s.label}`;
}

/** A live store with a page for the device in hand; on a phone, only that phone's own store. */
export function storeFor(
  p: LibraryProduct,
  device: DeviceInHand,
): PortalStoreLink | null {
  if (!device.os) return null;
  const os = device.os;
  const kinds = device.phone ? PHONE_STORE[os] : null;
  if (device.phone && !kinds) return null;
  return (
    p.stores.find(
      (s) => s.platforms.includes(os) && (!kinds || kinds.includes(s.kind)),
    ) ?? null
  );
}

const DESKTOP: readonly PlatformKey[] = ["macos", "windows", "linux"];

function asArtifact(f: PortalDownloadFile, access: string): PortalArtifact {
  return {
    artifactId: f.artifactId,
    name: f.name,
    kind: f.role,
    platform: f.platform,
    arch: f.arch,
    sizeBytes: f.sizeBytes,
    sha256: f.sha256,
    access,
    canDownload: f.canDownload,
    reason: f.reason,
  };
}

function asRelease(
  p: LibraryProduct,
  releaseId: string,
  version: string,
): PortalRelease {
  return (
    p.releases.find((r) => r.releaseId === releaseId) ?? {
      product: p.slug,
      productName: p.name,
      releaseId,
      version,
      title: null,
      notes: null,
      publishedAt: null,
      sourceUrl: null,
      artifacts: [],
    }
  );
}

/** §5.4 from the downloads view: the Worker detected the platform and picked the build. */
function actionFromDownloads(
  p: LibraryProduct,
  d: PortalDownloads,
  device: DeviceInHand,
  productHref: (section?: "get" | "license" | "devices") => string,
): QuickAction | null {
  const seeDownloads: QuickAction = {
    kind: "link",
    label: "See downloads",
    href: productHref("get"),
    icon: "downloads",
  };
  const store = storeFor(p, device);
  const storeAction: QuickAction | null = store?.url
    ? {
        kind: "link",
        label: storeActionLabel(store),
        href: store.url,
        icon: "store",
        external: true,
      }
    : null;
  const coveredOn = (os: PlatformKey): boolean =>
    d.platforms.some(
      (x) =>
        normalisePlatform(x.platform) === os &&
        x.files.some((f) => f.canDownload),
    );
  const anyCovered =
    d.platforms.some((x) => x.files.some((f) => f.canDownload)) ||
    d.extras.some((f) => f.canDownload);
  if (device.phone) {
    if (storeAction) return storeAction;
    if (device.os && coveredOn(device.os)) return seeDownloads;
    const desktop = DESKTOP.find(coveredOn);
    if (desktop)
      return {
        kind: "email",
        label: "Email me the download",
        platform: desktop,
      };
    return anyCovered ? seeDownloads : null;
  }
  const rec = d.recommended;
  const os = device.os ?? normalisePlatform(d.detected.platform);
  const files =
    rec && normalisePlatform(rec.platform) === os
      ? rec.files.filter((f) => f.canDownload)
      : [];
  if (os && files.length > 0) {
    const label = rec!.latest
      ? `Download for ${osName(os)}`
      : `Download ${rec!.version}`;
    if (files.length > 1)
      // Two Mac builds and no Universal one: both are on the page, Apple silicon first.
      return { ...seeDownloads, label };
    const f = files[0]!;
    const artifact = asArtifact(f, d.access ?? "licensed");
    return {
      kind: "download",
      label,
      detail: [
        `Version ${rec!.version}`,
        rec!.universal ? "Universal" : archName(artifact),
        formatSize(f.sizeBytes),
      ]
        .filter(Boolean)
        .join(" · "),
      release: asRelease(p, f.releaseId, rec!.version),
      artifact,
    };
  }
  if (storeAction) return storeAction;
  return anyCovered ? seeDownloads : null;
}

export function quickAction(
  p: LibraryProduct,
  device: DeviceInHand,
  productHref: (section?: "get" | "license" | "devices") => string,
): QuickAction {
  if (p.status.kind === "deviceLimit") {
    return {
      kind: "link",
      label: t("signin.choice.freeDevice"),
      href: productHref("devices"),
      icon: "device",
    };
  }
  if (p.status.kind === "signedInApp") {
    const store = storeFor(p, device);
    if (device.phone && store?.url)
      return {
        kind: "link",
        label: storeActionLabel(store),
        href: store.url,
        icon: "store",
        external: true,
      };
    return p.presentation.website
      ? {
          kind: "link",
          label: `Open ${p.name}`,
          href: p.presentation.website,
          icon: "open",
          external: true,
        }
      : {
          kind: "link",
          label: "View details",
          href: productHref(),
          icon: "details",
        };
  }
  if (p.downloads && p.downloads.available) {
    const fromView = actionFromDownloads(p, p.downloads, device, productHref);
    if (fromView) return fromView;
    return {
      kind: "link",
      label: "View details",
      href: productHref("license"),
      icon: "details",
    };
  }
  const covered = p.releases.filter((r) =>
    r.artifacts.some((a) => a.canDownload),
  );
  if (covered.length === 0) {
    return {
      kind: "link",
      label: "View details",
      href: productHref("license"),
      icon: "details",
    };
  }
  const seeDownloads: QuickAction = {
    kind: "link",
    label: "See downloads",
    href: productHref("get"),
    icon: "downloads",
  };
  // Phones get no installer (§5.4); without the downloads view there are no store links, so
  // the action opens the product's downloads.
  if (device.phone || !device.os) return seeDownloads;
  const os = device.os;
  const latest = p.releases[0];
  for (const r of covered) {
    const builds = buildsFor(r, os);
    if (builds.length === 0) continue;
    const pick = pickBuild(builds);
    if (!pick) return { ...seeDownloads, label: `Download for ${osName(os)}` };
    const isLatest = r === latest;
    return {
      kind: "download",
      label: isLatest ? `Download for ${osName(os)}` : `Download ${r.version}`,
      detail: [
        `Version ${r.version}`,
        archName(pick),
        formatSize(pick.sizeBytes),
      ]
        .filter(Boolean)
        .join(" · "),
      release: r,
      artifact: pick,
    };
  }
  return seeDownloads;
}

/**
 * Whether a quick action is the product's download for the device in hand (PX-24): the build
 * itself, the two-build "Download for macOS" that opens both, "Email me the download" on a phone
 * (G23), or the store that has the product for this device. A just-added product's tile leads
 * with it (solid, EXPERIENCE §0.6 P1 step 7). "See downloads", "View details", "Free a device"
 * and "Open <product>" are not downloads: a tile with one of them keeps its outlined action.
 */
export function isDownloadAction(action: QuickAction): boolean {
  if (action.kind === "download" || action.kind === "email") return true;
  if (action.icon === "store") return true;
  return action.icon === "downloads" && action.label !== "See downloads";
}

export function osName(os: PlatformKey): string {
  return {
    macos: "macOS",
    windows: "Windows",
    linux: "Linux",
    ios: "iPhone",
    android: "Android",
    web: "the web",
  }[os];
}

/** The OS name a device row shows for its stored platform, header-only Apple values included;
 *  null when the platform is unknown. */
export function deviceOsName(p: string | null): string | null {
  const k = deviceFamily(p);
  if (k === null) return null;
  if (k === "tvos") return "Apple TV";
  if (k === "visionos") return "Apple Vision Pro";
  if (k === "watchos") return "Apple Watch";
  return osName(k);
}

/**
 * "Version 2.0 isn't covered. Renew with Kiln Games to get it." when the Worker recommends an
 * older covered build because the newest one is outside the licence (§5.4, mockup 20).
 */
export function coverageNote(p: LibraryProduct): string | null {
  const d = p.downloads;
  if (!d?.recommended || d.recommended.latest || !d.latest) return null;
  const who = p.presentation.developer;
  return `Version ${d.latest.version} isn't covered.${who ? ` Renew with ${who} to get it.` : ""}`;
}

/** "Windows and Linux only" when nothing is built for the device in hand. */
export function platformsOnlyNote(
  p: LibraryProduct,
  device: DeviceInHand,
): string | null {
  if (!device.os || p.platforms.length === 0) return null;
  if (p.platforms.includes(device.os)) return null;
  const names = p.platforms.map((x) =>
    x === "ios" ? "iPhone and iPad" : osName(x),
  );
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} only`;
}

// ── Needs attention (§4.15) ───────────────────────────────────────────────────────────────────

export interface AttentionItem {
  product: LibraryProduct;
  /** "Your Studio license ends on 13 Oct." The action says what to do. */
  text: string;
  action: { label: string; href: string; external: boolean };
}

/**
 * The device-limit reason. The card's title already names the product, so the text does not.
 * "Both devices are in use." The card's action ("Free a device") says what to do, once.
 */
function devicesInUse(limit: number): string {
  if (limit === 1) return "Its one device is in use.";
  const all = limit === 2 ? "Both devices" : `All ${limit} devices`;
  return `${all} are in use.`;
}

/** A date that never breaks across lines ("11 Sep 2026"): its spaces are non-breaking. */
function unbroken(day: string): string {
  return day.replace(/ /g, "\u00a0");
}

/**
 * Only items the person can act on: a device limit (free a device, G5), or an expiring,
 * expired or suspended license with a renewal or contact link (G16). Without a link there is
 * nothing to press, so the item is not shown (never a dead-end "Needs attention"). Steam keys
 * join with G8.
 */
export function attentionItems(
  products: readonly LibraryProduct[],
  devicesHref?: (slug: string) => string,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const p of products) {
    // An entry (PS-04) has no licence to expire, suspend or fill: never anything to act on.
    if (p.kind === "entry") continue;
    if (p.status.kind === "deviceLimit" && p.seats && devicesHref) {
      out.push({
        product: p,
        text: devicesInUse(p.seats.limit),
        action: {
          label: t("signin.choice.freeDevice"),
          href: devicesHref(p.slug),
          external: false,
        },
      });
      continue;
    }
    const { supportUrl, supportEmail, developer } = p.presentation;
    const link = supportUrl ?? (supportEmail ? `mailto:${supportEmail}` : null);
    if (!link) continue;
    const who = developer ?? "the developer";
    const tier = tierLabel(p.best.tier);
    if (p.status.kind === "expiresSoon" && p.best.expiresAt) {
      out.push({
        product: p,
        text: `Your ${tier ? `${tier} ` : ""}license ends on ${unbroken(formatDay(p.best.expiresAt, false))}.`,
        action: { label: `Renew with ${who}`, href: link, external: true },
      });
    } else if (p.status.kind === "expired") {
      out.push({
        product: p,
        text: `Your license ended on ${unbroken(formatDay(p.best.expiresAt ?? 0))}.`,
        action: { label: `Renew with ${who}`, href: link, external: true },
      });
    } else if (p.status.kind === "suspended") {
      out.push({
        product: p,
        text: `${who[0]!.toUpperCase()}${who.slice(1)} suspended this license.`,
        action: {
          label: t("status.contact", { developer: who }),
          href: link,
          external: true,
        },
      });
    }
  }
  return out;
}
