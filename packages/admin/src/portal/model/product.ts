import type {
  PortalArtifact,
  PortalDownloadFile,
  PortalDownloads,
  PortalInstallSource,
  PortalLicenseDetail,
  PortalLicenseSummary,
  PortalProduct,
  PortalProductDevice,
  PortalRelease,
  PortalStoreLink,
} from "../api.js";
import type { PlatformKey } from "../components/Glyphs.js";
import {
  resolveHash,
  type PortalRoute,
  type ProductSection,
} from "../router.js";
import {
  formatSize,
  isSignInLicense,
  normalisePlatform,
  shortOrigin,
  type OriginFacts,
  tierLabel,
  type DeviceInHand,
  type LibraryProduct,
  type LicensedProduct,
  type Presentation,
  type QuickAction,
} from "./library.js";

/**
 * The product page's model on today's API (PORTAL.md §4.20, PX-04): which sections exist, the
 * Get it panel's files, the license facts. Absent sections are omitted, with their TOC entry and
 * phone pill (P14).
 */

/**
 * The sections in the page's order, the one order both navs list (§4.20; owner polish
 * 2026-10-07): the phone's task order, which is also the order the desktop page reads in as it
 * scrolls, since the side column (License, Devices) starts beside Get it and the main column
 * carries on below with Cloud Sync, What's new, Package access and Help.
 */
export const SECTION_ORDER: readonly ProductSection[] = [
  "get",
  "license",
  "devices",
  "sync",
  "new",
  "package",
  "help",
];

export const SECTION_LABEL: Record<ProductSection, string> = {
  get: "Get it",
  sync: "Cloud Sync",
  new: "What's new",
  license: "License",
  devices: "Devices",
  package: "Package access",
  help: "Help",
};

/**
 * The sections this product has. Cloud Sync (G26) has no data source yet and is always absent;
 * Package access (G13, F-21) shows when the selected licence's product has a private feed;
 * Help needs the developer's support links (G16).
 */
export function presentSections(
  p: LibraryProduct,
  releasesOn: boolean,
  extra: { packageAccess?: boolean } = {},
): ProductSection[] {
  const set = new Set<ProductSection>();
  if (releasesOn && p.releases.length > 0) {
    set.add("get");
    set.add("new");
  }
  set.add("license");
  // Every licence, from a key or from signing in, has devices to remove remotely (owner, 2026-10-05).
  set.add("devices");
  if (extra.packageAccess) set.add("package");
  const pres = p.presentation;
  if (pres.supportUrl || pres.supportEmail || pres.website) set.add("help");
  return SECTION_ORDER.filter((s) => set.has(s));
}

export interface FileRowModel {
  artifact: PortalArtifact;
  /** The release this file belongs to (the token mint names it). */
  release: PortalRelease;
  platform: PlatformKey | null;
  /** "Universal", "Apple silicon", "x64", or the file name for an extra. */
  title: string;
  /** "1.4.2 · .dmg · 3.1 GB". */
  meta: string;
  /** Why it can't be downloaded, as visible text; null when it can. */
  notIncluded: string | null;
  /**
   * A file that isn't hosted here (`not_hosted`): where to get it instead, "Get it from Steam"
   * or "Get it from <developer>" (§0.6 P3, §11.2). Never "Not included": the license covers it.
   */
  elsewhere: Elsewhere | null;
}

/** "Get it from Steam" with the store's page, or "Get it from <developer>" with their site. */
export interface Elsewhere {
  label: string;
  /** An https link to follow; null when the developer gave none (the words still say who). */
  href: string | null;
}

/** Where a file this site doesn't host comes from (§0.6 P3, §11.2). */
export interface ElsewhereContext {
  /** Live store links for the product ("Also yours on"). */
  stores?: readonly PortalStoreLink[];
  developer?: string | null;
  website?: string | null;
}

function httpsOrNull(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

/**
 * Where to get a file that isn't hosted here: a live store that carries the file's platform (any
 * live store for an extra), else the developer's website, else the developer's name alone.
 */
export function elsewhereFor(
  platform: PlatformKey | null,
  ctx: ElsewhereContext = {},
): Elsewhere {
  const live = (ctx.stores ?? []).filter((s) => s.live && httpsOrNull(s.url));
  const store =
    live.find((s) =>
      platform
        ? s.platforms.some((p) => normalisePlatform(p) === platform)
        : true,
    ) ?? null;
  if (store) return { label: `Get it from ${store.label}`, href: store.url };
  const who = ctx.developer ?? "the developer";
  return { label: `Get it from ${who}`, href: httpsOrNull(ctx.website) };
}

function ext(name: string): string | null {
  const m = name.match(/(\.(?:tar\.gz|tar\.xz|[a-z0-9]{1,8}))$/i);
  return m ? m[1]!.toLowerCase() : null;
}

function archTitle(a: PortalArtifact, platform: PlatformKey | null): string {
  const arch = (a.arch ?? "").toLowerCase();
  if (!platform) return a.name;
  if (!arch || arch === "any" || arch === "universal") return "Universal";
  if (platform === "macos")
    return arch === "arm64"
      ? "Apple silicon"
      : arch === "x86_64"
        ? "Intel"
        : arch;
  if (platform === "windows")
    return arch === "x86_64" ? "x64" : arch === "arm64" ? "Arm64" : arch;
  return arch === "x86_64" ? "x86_64" : arch === "arm64" ? "ARM64" : arch;
}

/**
 * The reason a file isn't downloadable, in words (never only a tooltip, PA-6). The per-product
 * downloads view (PX-W2) says why; `/api/releases` only says "no", and its "no" also covers a
 * file nothing here can serve yet (no redirectable source, G3), so without a reason the words
 * claim no more than is known: a usable licence on a `licensed` file, or any `entitled` file, is
 * "Not available here yet", never "your license doesn't include this".
 */
export function notIncludedReason(
  a: PortalArtifact,
  licenseUsable = true,
): string | null {
  if (a.canDownload) return null;
  switch (a.reason) {
    case "license_inactive":
      return "Needs an active license";
    case "not_entitled":
      return "Your license doesn't include this version";
    case "not_hosted":
      return "Not available here yet";
  }
  if (a.access === "licensed" && !licenseUsable)
    return "Needs an active license";
  return "Not available here yet";
}

export function fileRow(
  a: PortalArtifact,
  release: PortalRelease,
  licenseUsable = true,
  ctx?: ElsewhereContext,
): FileRowModel {
  const platform = normalisePlatform(a.platform);
  const elsewhere =
    !a.canDownload && a.reason === "not_hosted"
      ? elsewhereFor(platform, ctx)
      : null;
  return {
    artifact: a,
    release,
    platform,
    title: archTitle(a, platform),
    meta: [release.version, ext(a.name), formatSize(a.sizeBytes)]
      .filter(Boolean)
      .join(" · "),
    // A `not_hosted` file says where it is instead ("Get it from Steam"), never "here yet".
    notIncluded: elsewhere
      ? elsewhere.label
      : notIncludedReason(a, licenseUsable),
    elsewhere,
  };
}

const ARCH_RANK: Record<string, number> = {
  Universal: 0,
  "Apple silicon": 1,
  Intel: 2,
};

export interface PlatformGroup {
  platform: PlatformKey | null;
  /** "macOS", "Windows", "Linux", or "Extras" for files with no platform. */
  label: string;
  rows: FileRowModel[];
  /** The platform's install sources, offered after its files ("Other ways to install", P0-48);
   *  always empty for Extras. */
  sources: PortalInstallSource[];
}

const GROUP_LABEL: Record<PlatformKey, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iPhone and iPad",
  android: "Android",
  web: "Web",
};
const GROUP_ORDER: readonly PlatformKey[] = [
  "macos",
  "windows",
  "linux",
  "ios",
  "android",
  "web",
];

/** All platforms grouped by OS, then Extras (§4.20). */
export function groupFiles(
  r: PortalRelease,
  licenseUsable = true,
  ctx?: ElsewhereContext,
): PlatformGroup[] {
  return groupRows(r.artifacts.map((a) => fileRow(a, r, licenseUsable, ctx)));
}

function groupRows(rows: FileRowModel[]): PlatformGroup[] {
  const groups: PlatformGroup[] = [];
  for (const p of GROUP_ORDER) {
    const own = rows
      .filter((x) => x.platform === p)
      .sort((a, b) => (ARCH_RANK[a.title] ?? 9) - (ARCH_RANK[b.title] ?? 9));
    if (own.length)
      groups.push({
        platform: p,
        label: GROUP_LABEL[p],
        rows: own,
        sources: [],
      });
  }
  const extras = rows.filter((x) => x.platform === null);
  if (extras.length)
    groups.push({ platform: null, label: "Extras", rows: extras, sources: [] });
  return groups;
}

/**
 * Each install source under its platform, after that platform's files (P0-48, §2.5 "all
 * applicable ones per platform"): a platform with sources and no files gets a group of its own,
 * so a Mac user reads Homebrew under macOS and never an iPhone source without its OS. The
 * device's own OS comes first; Extras stays last.
 */
function placeSources(
  groups: PlatformGroup[],
  sources: readonly PortalInstallSource[],
  os: PlatformKey | null,
): PlatformGroup[] {
  const out = groups.map((g) => ({ ...g, sources: [...g.sources] }));
  for (const s of sources)
    for (const raw of s.platforms) {
      const p = normalisePlatform(raw);
      if (!p) continue;
      let g = out.find((x) => x.platform === p);
      if (!g) {
        g = { platform: p, label: GROUP_LABEL[p], rows: [], sources: [] };
        out.push(g);
      }
      if (!g.sources.some((x) => x.id === s.id)) g.sources.push(s);
    }
  const rank = (g: PlatformGroup) =>
    g.platform === null
      ? GROUP_ORDER.length + 1
      : g.platform === os
        ? -1
        : GROUP_ORDER.indexOf(g.platform);
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * The install sources a downloads view offers (P0-48): its `installSources`, then any live store
 * with a command and no page (winget), which is installed the same way, with a command to copy,
 * and so is never an "Also yours on" pill.
 */
function installSourcesOf(d: PortalDownloads): PortalInstallSource[] {
  const commands = d.stores
    .filter((s) => s.live && !httpsOrNull(s.url) && s.command)
    .map((s) => ({ ...s, url: null, fingerprint: null, qr: null }));
  return [
    ...(d.installSources ?? []).filter((s) => s.deepLink || s.url || s.command),
    ...commands,
  ];
}

/** On a phone, what installs on the device in hand (P0-48): see {@link GetItModel.here}. */
function hereFor(
  device: DeviceInHand,
  stores: readonly PortalStoreLink[],
  groups: readonly PlatformGroup[],
): GetItModel["here"] {
  if (!device.phone || !device.os) return null;
  const os = device.os;
  const own = stores.filter((s) =>
    s.platforms.some((p) => normalisePlatform(p) === os),
  );
  const sources = (groups.find((g) => g.platform === os)?.sources ?? []).filter(
    (s) => s.deepLink || httpsOrNull(s.url),
  );
  return own.length || sources.length ? { os, stores: own, sources } : null;
}

export interface GetItModel {
  /** The release the panel describes: the newest one with a covered build, else the newest. */
  release: PortalRelease;
  /** The newest release, when it isn't covered and an older one is shown instead. */
  newerNotCovered: { version: string } | null;
  /** The channel's newest release, for the subtitle. */
  latest: { version: string; publishedAt: number | null };
  /**
   * The one OS the recommendation is for (§0.6 P3): the same value the header's action used, so
   * the label and the build always agree. Null on a phone or when nothing is known.
   */
  os: PlatformKey | null;
  /** Covered builds for `os` (Universal or Apple silicon first); empty when there's no match. */
  recommended: FileRowModel[];
  /** Every platform's files, then its install sources (P0-48); the device's own OS first. */
  groups: PlatformGroup[];
  /** Store outlets with a page reporting a live release (G2, "Also yours on"); empty without
   *  PX-W2. Install sources are not stores: they sit under their platform in `groups`. */
  stores: PortalStoreLink[];
  /**
   * On a phone, what installs on the phone in hand, to lead with ("Install on this iPhone",
   * P0-48): its OS's live stores and the install sources it can open. `null` on a computer, or
   * when the phone has neither (the page then says to open it on a computer).
   */
  here: {
    os: PlatformKey;
    stores: PortalStoreLink[];
    sources: PortalInstallSource[];
  } | null;
}

export function getItModel(
  releases: readonly PortalRelease[],
  device: DeviceInHand,
  /** Whether any of the account's licences for the product is usable (status, expiry). */
  licenseUsable = true,
  ctx?: ElsewhereContext,
): GetItModel | null {
  const newest = releases[0];
  if (!newest) return null;
  const covered = releases.find((r) => r.artifacts.some((a) => a.canDownload));
  const release = covered ?? newest;
  const groups = placeSources(
    groupFiles(release, licenseUsable, ctx),
    [],
    device.os,
  );
  const os = device.phone ? null : device.os;
  const recommended = os
    ? (groups.find((g) => g.platform === os)?.rows ?? []).filter(
        (r) => r.notIncluded === null,
      )
    : [];
  return {
    release,
    newerNotCovered: covered && covered !== newest ? newest : null,
    latest: { version: newest.version, publishedAt: newest.publishedAt },
    os,
    recommended,
    groups,
    stores: [],
    here: null,
  };
}

/**
 * Get it from the per-product downloads view (PX-W2): the Worker already picked the build for
 * the device (Universal named as such, two Mac builds both offered), the older covered release
 * when the newest isn't (§5.4), and the reason each uncovered file isn't included. The Worker's
 * recommendation is used only when it is for `device.os` (pass `resolveDevice`'s answer), so
 * the label above it can never name another OS.
 */
export function getItFromDownloads(
  d: PortalDownloads,
  device: DeviceInHand,
  ctx: Omit<ElsewhereContext, "stores"> = {},
): GetItModel | null {
  if (!d.available || !d.latest) return null;
  const where: ElsewhereContext = { ...ctx, stores: d.stores };
  const releases = new Map<string, PortalRelease>();
  const releaseOf = (f: PortalDownloadFile): PortalRelease => {
    let r = releases.get(f.releaseId);
    if (!r) {
      r = {
        product: d.product.slug,
        productName: d.product.name,
        releaseId: f.releaseId,
        version: f.version,
        title: null,
        notes: null,
        publishedAt: null,
        sourceUrl: null,
        artifacts: [],
      };
      releases.set(f.releaseId, r);
    }
    return r;
  };
  const row = (f: PortalDownloadFile): FileRowModel =>
    fileRow(
      {
        artifactId: f.artifactId,
        name: f.name,
        kind: f.role,
        platform: f.platform,
        arch: f.arch,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
        access: d.access ?? "licensed",
        canDownload: f.canDownload,
        reason: f.reason,
      },
      releaseOf(f),
      true,
      where,
    );
  const os = device.phone ? null : device.os;
  const rec =
    d.recommended && os && normalisePlatform(d.recommended.platform) === os
      ? d.recommended
      : null;
  const recommended = rec
    ? rec.files.filter((f) => f.canDownload).map(row)
    : [];
  const groups = placeSources(
    groupRows([
      ...d.platforms.flatMap((p) => p.files.map(row)),
      ...d.extras.map(row),
    ]),
    installSourcesOf(d),
    device.os,
  );
  const stores = d.stores.filter((s) => s.live && httpsOrNull(s.url));
  const headline = rec ? recommended[0]?.release : undefined;
  return {
    release: headline ?? {
      product: d.product.slug,
      productName: d.product.name,
      releaseId: d.latest.releaseId,
      version: d.latest.version,
      title: d.latest.title,
      notes: null,
      publishedAt: d.latest.publishedAt,
      sourceUrl: null,
      artifacts: [],
    },
    newerNotCovered:
      d.recommended && !d.recommended.latest
        ? { version: d.latest.version }
        : null,
    latest: { version: d.latest.version, publishedAt: d.latest.publishedAt },
    os,
    recommended,
    groups,
    // "Also yours on" is the live stores alone. Only a store answers "where else" for a file not
    // hosted here (`where` above): an install source serves the very files listed (P0-48).
    stores,
    here: hereFor(device, stores, groups),
  };
}

// ── one OS source (§0.6 P3) ───────────────────────────────────────────────────────────────────

/** The low-entropy User-Agent Client Hints a Chromium browser exposes to script. */
export interface UaHints {
  platform?: string;
  mobile?: boolean;
}

const HINT_OS: Record<string, PlatformKey> = {
  macos: "macos",
  windows: "windows",
  linux: "linux",
  android: "android",
  ios: "ios",
};

/** `navigator.userAgentData`, where the browser has it (Chromium); never the high-entropy calls. */
export function readUaHints(): UaHints | null {
  if (typeof navigator === "undefined") return null;
  const data = (navigator as Navigator & { userAgentData?: UaHints })
    .userAgentData;
  return data && typeof data.platform === "string" ? data : null;
}

/**
 * The one OS the product page works from (§0.6 P3): the Worker's detection (which already reads
 * `Sec-CH-UA-Platform`, then the User-Agent), refined in the browser by what only the browser can
 * tell: the UA-CH platform when the browser exposes it, and an iPad behind a Mac user agent
 * (`touchAmbiguous` and a touch screen). Without a downloads view it is the browser's own guess.
 * The header's action and the Get it panel both take this value, so they never disagree.
 */
export function resolveDevice(
  d: PortalDownloads | null | undefined,
  device: DeviceInHand,
  hints: UaHints | null = null,
): DeviceInHand {
  const hinted = hints?.platform
    ? (HINT_OS[hints.platform.toLowerCase()] ?? null)
    : null;
  if (hinted)
    return {
      os: hinted,
      phone: hints?.mobile === true || hinted === "ios" || hinted === "android",
    };
  const server = d ? normalisePlatform(d.detected.platform) : null;
  if (!server) return device;
  if (d!.detected.touchAmbiguous && device.os === "ios") return device;
  return { os: server, phone: server === "ios" || server === "android" };
}

const DEVICE_NOUN: Record<PlatformKey, string> = {
  macos: "Mac",
  windows: "Windows PC",
  linux: "Linux computer",
  ios: "iPhone or iPad",
  android: "Android device",
  web: "browser",
};

/** "Recommended for your Mac": the label names the same OS the build is for. */
export function recommendedLabel(os: PlatformKey): string {
  return `Recommended for your ${DEVICE_NOUN[os]}`;
}

// ── the one next action, never pointing at the page you are on (§0.6 P3) ──────────────────────

/**
 * The quick action as shown. A product with no download offers "Get it from <developer>" with
 * their site rather than "View details"; on the product's own page a "View details" that would
 * only point back at that page is dropped (null), so the header shows no lead instead of a
 * self-link.
 */
export function settleAction(
  p: Pick<LibraryProduct, "slug"> & { presentation: Presentation },
  action: QuickAction,
  here: PortalRoute | null,
): QuickAction | null {
  if (action.kind !== "link" || action.icon !== "details") return action;
  const site = httpsOrNull(p.presentation.website);
  if (site)
    return {
      kind: "link",
      label: `Get it from ${p.presentation.developer ?? "the developer"}`,
      href: site,
      icon: "open",
      external: true,
    };
  const target = resolveHash(action.href).route;
  const onIt =
    here?.kind === "product" &&
    target.kind === "product" &&
    here.product === target.product &&
    here.product === p.slug;
  return onIt ? null : action;
}

// ── one device source (§0.6 P4) ───────────────────────────────────────────────────────────────

type ProductLicense = PortalProduct["licenses"][number];

/** A licence's seats as activation counts them, read the same way on every page. */
export interface DeviceSeats {
  /** The seat limit; null when the licence has none. */
  limit: number | null;
  /** Devices holding a seat (the Worker's count: authorised and not dormant). */
  inUse: number;
  /** Every seat is taken. */
  full: boolean;
  /** The devices holding a seat, least recently seen first. */
  holders: PortalProductDevice[];
  /** Authorised devices past the dormancy window: they hold no seat. */
  dormantIds: ReadonlySet<string>;
}

/**
 * The one device source (§0.6 P4) for the product page and the free-device flow: the product
 * view's per-licence seats (`GET /api/products/<p>`), where the Worker has already decided which
 * devices are dormant. Both pages call this, so "2 of 3 in use" reads the same on each.
 */
export function deviceSeats(license: ProductLicense): DeviceSeats {
  const limit = license.deviceLimit > 0 ? license.deviceLimit : null;
  const inUse = license.activeSeatCount;
  const holders = license.devices
    .filter((d) => !d.dormant)
    .sort((a, b) => a.lastSeen - b.lastSeen);
  return {
    limit,
    inUse,
    full: limit !== null && inUse >= limit,
    holders,
    dormantIds: new Set(
      license.devices.filter((d) => d.dormant).map((d) => d.deviceId),
    ),
  };
}

/** The selected licence's seats from the product view, or null while it isn't known. */
export function seatsFor(
  product: PortalProduct | undefined,
  licenseId: string,
): DeviceSeats | null {
  const l = product?.licenses.find((x) => x.id === licenseId);
  return l ? deviceSeats(l) : null;
}

/**
 * The licence detail as the Devices card shows it, with the seat source applied: a device the
 * Worker counts as dormant holds no seat, so it is shown as not using one (not as "in use").
 */
export function withSeats(
  detail: PortalLicenseDetail,
  seats: DeviceSeats | null,
): PortalLicenseDetail {
  if (!seats || seats.dormantIds.size === 0) return detail;
  return {
    ...detail,
    devices: detail.devices.map((d) =>
      d.status === "authorized" && seats.dormantIds.has(d.deviceId)
        ? { ...d, status: "dormant" }
        : d,
    ),
  };
}

/** The tier as the License card's pill names it: a licence with no tier is "Standard". */
export function tierName(l: Pick<PortalLicenseSummary, "tier">): string {
  return tierLabel(l.tier) ?? "Standard";
}

/** The licence picker's option: tier first, then its short origin ("Pro · Key …3WPLDA",
 * "Standard · Sign-in", "Standard · Steam key"), and the status only when it wants attention
 * ("Pro · Key · Expired"). Never a licence type: every licence is account-bound (owner,
 * 2026-10-05). */
export function licenseOptionLabel(
  l: PortalLicenseSummary,
  status: { label: string; attention: boolean },
  facts: OriginFacts = {},
): string {
  return [
    tierName(l),
    shortOrigin(l, facts),
    status.attention ? status.label : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The store of the active purchase on licence `id` (`purchase.store`, PX-W6), or null. */
export function storeFor(
  view: PortalProduct | undefined,
  id: string,
): string | null {
  const p = view?.licenses.find((l) => l.id === id)?.purchase;
  return p && p.source === "store" ? (p.store ?? null) : null;
}

/**
 * The seat limit activation enforces on licence `id`: the product view's per-licence
 * `deviceLimit` (PX-W1), else the library's seats when `id` is the best licence; `null` when
 * neither has answered (the limit is never guessed).
 */
export function seatLimitFor(
  p: LicensedProduct,
  view: PortalProduct | undefined,
  id: string,
): number | null {
  const own = view?.licenses.find((l) => l.id === id);
  if (own) return own.deviceLimit > 0 ? own.deviceLimit : null;
  return id === p.best.id ? (p.seats?.limit ?? null) : null;
}

/**
 * Whether licence `l`'s device counter is shown. A key or seat licence's counter goes away when
 * the account also holds a sign-in licence for the product, which covers the devices it signs in
 * on (owner, 2026-10-05); the device list and Remove stay either way.
 */
export function showsDeviceCount(
  p: Pick<LibraryProduct, "licenses">,
  l: PortalLicenseSummary,
): boolean {
  return isSignInLicense(l) || !p.licenses.some(isSignInLicense);
}

/** "1.x", "1.0 and later", "Up to 2.0", "All versions" from the license's version bounds. */
export function coversVersions(
  l:
    | PortalLicenseDetail
    | { minVersion: string | null; maxVersion: string | null },
): string {
  const { minVersion: min, maxVersion: max } = l;
  if (min && max) return `${min} to ${max}`;
  if (max) return `Up to ${max}`;
  if (min) return `${min} and later`;
  return "All versions";
}
