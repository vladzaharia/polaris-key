import type {
  PortalArtifact,
  PortalDownloadFile,
  PortalDownloads,
  PortalLicenseDetail,
  PortalLicenseSummary,
  PortalProduct,
  PortalRelease,
  PortalStoreLink,
} from "../api.js";
import type { PlatformKey } from "../components/Glyphs.js";
import type { ProductSection } from "../router.js";
import {
  ACCOUNT_WIDE,
  devicesText,
  formatSize,
  isAccountWide,
  normalisePlatform,
  tierLabel,
  type DeviceInHand,
  type LibraryProduct,
} from "./library.js";

/**
 * The product page's model on today's API (PORTAL.md §4.20, PX-04): which sections exist, the
 * Get it panel's files, the license facts. Absent sections are omitted, with their TOC entry and
 * phone pill (P14).
 */

/** Desktop TOC order, then the phone's task order (§4.20). */
export const DESKTOP_ORDER: readonly ProductSection[] = [
  "get",
  "sync",
  "new",
  "license",
  "devices",
  "package",
  "help",
];
export const PHONE_ORDER: readonly ProductSection[] = [
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
  // Every licence, key or account-wide, has devices to remove remotely (owner, 2026-10-05).
  set.add("devices");
  if (extra.packageAccess) set.add("package");
  const pres = p.presentation;
  if (pres.supportUrl || pres.supportEmail || pres.website) set.add("help");
  return DESKTOP_ORDER.filter((s) => set.has(s));
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
): FileRowModel {
  const platform = normalisePlatform(a.platform);
  return {
    artifact: a,
    release,
    platform,
    title: archTitle(a, platform),
    meta: [release.version, ext(a.name), formatSize(a.sizeBytes)]
      .filter(Boolean)
      .join(" · "),
    notIncluded: notIncludedReason(a, licenseUsable),
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
): PlatformGroup[] {
  return groupRows(r.artifacts.map((a) => fileRow(a, r, licenseUsable)));
}

function groupRows(rows: FileRowModel[]): PlatformGroup[] {
  const groups: PlatformGroup[] = [];
  for (const p of GROUP_ORDER) {
    const own = rows
      .filter((x) => x.platform === p)
      .sort((a, b) => (ARCH_RANK[a.title] ?? 9) - (ARCH_RANK[b.title] ?? 9));
    if (own.length)
      groups.push({ platform: p, label: GROUP_LABEL[p], rows: own });
  }
  const extras = rows.filter((x) => x.platform === null);
  if (extras.length)
    groups.push({ platform: null, label: "Extras", rows: extras });
  return groups;
}

export interface GetItModel {
  /** The release the panel describes: the newest one with a covered build, else the newest. */
  release: PortalRelease;
  /** The newest release, when it isn't covered and an older one is shown instead. */
  newerNotCovered: { version: string } | null;
  /** The channel's newest release, for the subtitle. */
  latest: { version: string; publishedAt: number | null };
  /** Covered builds for the device in hand (Universal or Apple silicon first). */
  recommended: FileRowModel[];
  groups: PlatformGroup[];
  /** Store outlets reporting a live release (G2, "Also yours on"); empty without PX-W2. */
  stores: PortalStoreLink[];
}

export function getItModel(
  releases: readonly PortalRelease[],
  device: DeviceInHand,
  /** Whether any of the account's licences for the product is usable (status, expiry). */
  licenseUsable = true,
): GetItModel | null {
  const newest = releases[0];
  if (!newest) return null;
  const covered = releases.find((r) => r.artifacts.some((a) => a.canDownload));
  const release = covered ?? newest;
  const groups = groupFiles(release, licenseUsable);
  const recommended =
    device.os && !device.phone
      ? (groups.find((g) => g.platform === device.os)?.rows ?? []).filter(
          (r) => r.notIncluded === null,
        )
      : [];
  return {
    release,
    newerNotCovered: covered && covered !== newest ? newest : null,
    latest: { version: newest.version, publishedAt: newest.publishedAt },
    recommended,
    groups,
    stores: [],
  };
}

/**
 * Get it from the per-product downloads view (PX-W2): the Worker already picked the build for
 * the device (Universal named as such, two Mac builds both offered), the older covered release
 * when the newest isn't (§5.4), and the reason each uncovered file isn't included.
 */
export function getItFromDownloads(
  d: PortalDownloads,
  device: DeviceInHand,
): GetItModel | null {
  if (!d.available || !d.latest) return null;
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
    );
  const rec = d.recommended;
  const recommended =
    rec && !device.phone ? rec.files.filter((f) => f.canDownload).map(row) : [];
  const groups = groupRows([
    ...d.platforms.flatMap((p) => p.files.map(row)),
    ...d.extras.map(row),
  ]);
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
    newerNotCovered: rec && !rec.latest ? { version: d.latest.version } : null,
    latest: { version: d.latest.version, publishedAt: d.latest.publishedAt },
    recommended,
    groups,
    stores: d.stores.filter((s) => s.live && (s.url || s.command)),
  };
}

/** "1.x", "1.0 and later", "Up to 2.0", "All versions" from the license's version bounds. */
/** The tier as the License card's pill names it: a licence with no tier is "Standard". */
export function tierName(l: Pick<PortalLicenseSummary, "tier">): string {
  return tierLabel(l.tier) ?? "Standard";
}

/** The licence picker's option: tier first, then how it's held ("Pro · Key", "Standard ·
 * Account-wide"), and the status only when it wants attention ("Pro · Key · Expired"). */
export function licenseOptionLabel(
  l: PortalLicenseSummary,
  status: { label: string; attention: boolean },
): string {
  return [
    tierName(l),
    isAccountWide(l) ? ACCOUNT_WIDE : "Key",
    status.attention ? status.label : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The seat limit activation enforces on licence `id`: the product view's per-licence
 * `deviceLimit` (PX-W1), else the library's seats when `id` is the best licence; `null` when
 * neither has answered (the limit is never guessed).
 */
export function seatLimitFor(
  p: LibraryProduct,
  view: PortalProduct | undefined,
  id: string,
): number | null {
  const own = view?.licenses.find((l) => l.id === id);
  if (own) return own.deviceLimit > 0 ? own.deviceLimit : null;
  return id === p.best.id ? (p.seats?.limit ?? null) : null;
}

/**
 * Whether licence `l`'s device counter is shown. A key licence's counter goes away when the
 * account also holds an account-wide licence for the product, which covers the devices it signs
 * in on (owner, 2026-10-05); the device list stays either way.
 */
export function showsDeviceCount(
  p: Pick<LibraryProduct, "licenses">,
  l: PortalLicenseSummary,
): boolean {
  return isAccountWide(l) || !p.licenses.some(isAccountWide);
}

/**
 * The words beside the tier pill on the License card: "0 of 5 devices" for a key licence,
 * "Account-wide · 1 of 5 devices" for an account-bound one ("Account-wide" alone while the limit
 * is unknown), and null when the counter is hidden.
 */
export function licenseCountLine(
  l: PortalLicenseSummary,
  inUse: number,
  limit: number | null,
  showCount: boolean,
): string | null {
  const count = showCount ? devicesText(inUse, limit) : null;
  if (isAccountWide(l))
    return [ACCOUNT_WIDE, limit != null ? count : null]
      .filter(Boolean)
      .join(" · ");
  return count;
}

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

/** The release notes as paragraphs and bullet lists (plain text; never HTML). */
export function noteBlocks(
  notes: string,
): { kind: "p" | "ul"; lines: string[] }[] {
  const blocks: { kind: "p" | "ul"; lines: string[] }[] = [];
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const kind = bullet ? "ul" : "p";
    const text = (bullet ? bullet[1]! : line).replace(/^#+\s*/, "");
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && kind === "ul") last.lines.push(text);
    else blocks.push({ kind, lines: [text] });
  }
  return blocks;
}
