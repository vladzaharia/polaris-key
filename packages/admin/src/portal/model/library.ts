import type {
  PortalArtifact,
  PortalDownloadFile,
  PortalDownloads,
  PortalLibraryItem,
  PortalLicenseSummary,
  PortalPresentation,
  PortalRelease,
  PortalStatus,
  PortalStoreLink,
} from "../api.js";
import { PLATFORM_ORDER, type PlatformKey } from "../components/Glyphs.js";

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
  | "active";

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
  /** Same-origin `/media/…` art (PX-W1's proxy), or null for the letter-on-tint fallback. */
  iconUrl: string | null;
  headerUrl: string | null;
}

/** The best licence's seats as activation counts them (G5); null when the Worker didn't say. */
export interface Seats {
  limit: number;
  inUse: number;
}

export interface LibraryProduct {
  slug: string;
  name: string;
  presentation: Presentation;
  licenses: PortalLicenseSummary[];
  /** The license the product page and tile describe (best by §5.3 precedence). */
  best: PortalLicenseSummary;
  status: ProductStatus;
  /** When the product joined the library: its newest license's activation. */
  addedAt: number;
  /** Devices using a seat on the best license. */
  deviceCount: number;
  /** The seat limit and use (G5), as the Worker counted them on the best licence. */
  seats: Seats | null;
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

const DAY = 86_400;
export const EXPIRES_SOON_DAYS = 14;

const PRECEDENCE: readonly StatusKind[] = [
  "suspended",
  "expired",
  "deviceLimit",
  "keyNotActivated",
  "expiresSoon",
  "offlineGrace",
  "signedInApp",
  "active",
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

/** Same-origin only: the proxy's `/media/…` paths, never a developer host (CSP, §G1). */
function mediaUrl(v: string | null | undefined): string | null {
  return typeof v === "string" && v.startsWith("/media/") ? v : null;
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
export const FROM_SIGNING_IN = "From signing in";

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

/** What a licence's origin is read from: the summary, its keys' known last characters (G7) and
 * the store of an active purchase on it (`purchase.store`, PX-W6; store name only). */
export interface OriginFacts {
  keys?: readonly { last4?: string }[];
  store?: string | null;
}

/**
 * The licence's origin for a meta line, in plain words (owner, 2026-10-05): "From signing in",
 * "Steam key ending 3WPLDA" (or "Steam key" while the key's last characters aren't kept, G7),
 * "From Steam" for a store-bound licence with no key, "Key ending 3WPLDA" or "Added with a
 * key", else "From the developer".
 */
export function licenseOrigin(
  l: Pick<PortalLicenseSummary, "identityProvider" | "keyCount">,
  facts: OriginFacts = {},
): string {
  const keys = facts.keys ?? [];
  const store = facts.store ? storeName(facts.store) : null;
  const hasKey = l.keyCount > 0 || keys.length > 0;
  if (hasKey) {
    const last = keys.find((k) => k.last4)?.last4;
    if (store) return last ? `${store} key ending ${last}` : `${store} key`;
    return last ? `Key ending ${last}` : "Added with a key";
  }
  // "From the App Store", "From Steam", "From Google Play".
  if (store)
    return `From ${facts.store === "app-store" ? "the App Store" : store}`;
  if (isSignInLicense(l)) return FROM_SIGNING_IN;
  return "From the developer";
}

/**
 * The licence picker's short origin: "Sign-in", "Key …3WPLDA", "Steam key …3WPLDA", "Steam",
 * "Key"; null for a keyless licence from the developer (the tier says enough).
 */
export function shortOrigin(
  l: Pick<PortalLicenseSummary, "identityProvider" | "keyCount">,
  facts: OriginFacts = {},
): string | null {
  const keys = facts.keys ?? [];
  const store = facts.store ? storeName(facts.store) : null;
  if (l.keyCount > 0 || keys.length > 0) {
    const last = keys.find((k) => k.last4)?.last4;
    const word = store ? `${store} key` : "Key";
    return last ? `${word} …${last}` : word;
  }
  if (store) return store;
  if (isSignInLicense(l)) return "Sign-in";
  return null;
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
      label: "Expired",
      tone: "danger",
      note: `Ended ${formatDay(l.expiresAt)}`,
      attention: true,
    };
  }
  if (seats && seats.limit > 0 && seats.inUse >= seats.limit) {
    return {
      kind: "deviceLimit",
      label: "Device limit reached",
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
    label: "Active",
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

/** The licence summary a library item stands for, when `GET /api/licenses` hasn't listed it. */
function summaryFromItem(item: PortalLibraryItem): PortalLicenseSummary {
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
        label: "Expired",
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
        label: "Device limit reached",
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
    const own = licenses.filter((l) => l.product === slug);
    const best =
      own.find((l) => l.id === item.license.id) ?? summaryFromItem(item);
    const list = own.some((l) => l.id === best.id) ? own : [best, ...own];
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
    const seats: Seats | null =
      item.license.deviceLimit > 0
        ? {
            limit: item.license.deviceLimit,
            inUse: item.license.activeSeatCount,
          }
        : null;
    const presentation = presentationFrom(item);
    const lastCovered =
      usable?.recommended && !usable.recommended.latest
        ? usable.recommended.version
        : null;
    out.push({
      slug,
      name: item.name || best.productName || slug,
      presentation,
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
      deviceCount: seats ? seats.inUse : item.license.deviceCount,
      seats,
      releases: ownReleases,
      latestVersion: usable?.latest?.version ?? ownReleases[0]?.version ?? null,
      platforms,
      downloads: d,
      stores: (usable?.stores ?? []).filter((st) => st.live && st.url),
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
      label: "Free up a device",
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
  /** "Your Studio license ends on 13 Oct. Updates stop after that." */
  text: string;
  action: { label: string; href: string; external: boolean };
}

/**
 * Only items the person can act on: a device limit (free up a device, G5), or an expiring,
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
    if (p.status.kind === "deviceLimit" && p.seats && devicesHref) {
      out.push({
        product: p,
        text: `All ${devicesText(p.seats.limit)} are in use. Remove one to use ${p.name} on another.`,
        action: {
          label: "Free up a device",
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
        text: `Your ${tier ? `${tier} ` : ""}license ends on ${formatDay(p.best.expiresAt, false)}. Updates stop after that.`,
        action: { label: `Renew with ${who}`, href: link, external: true },
      });
    } else if (p.status.kind === "expired") {
      out.push({
        product: p,
        text: `Your license ended on ${formatDay(p.best.expiresAt ?? 0)}.`,
        action: { label: `Renew with ${who}`, href: link, external: true },
      });
    } else if (p.status.kind === "suspended") {
      out.push({
        product: p,
        text: `${who[0]!.toUpperCase()}${who.slice(1)} suspended this license.`,
        action: { label: `Contact ${who}`, href: link, external: true },
      });
    }
  }
  return out;
}
