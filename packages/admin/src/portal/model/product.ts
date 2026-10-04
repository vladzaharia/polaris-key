import type {
  PortalArtifact,
  PortalLicenseDetail,
  PortalRelease,
} from "../api.js";
import type { PlatformKey } from "../components/Glyphs.js";
import type { ProductSection } from "../router.js";
import {
  formatSize,
  normalisePlatform,
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
 * The sections this product has. Cloud Sync (G26) and Package access (G13) have no data source
 * yet and are always absent; Help needs the developer's support links (G16).
 */
export function presentSections(
  p: LibraryProduct,
  releasesOn: boolean,
): ProductSection[] {
  const set = new Set<ProductSection>();
  const accountBound = p.status.kind === "signedInApp";
  if (releasesOn && p.releases.length > 0) {
    set.add("get");
    set.add("new");
  }
  set.add("license");
  if (!accountBound) set.add("devices");
  const pres = p.presentation;
  if (pres.supportUrl || pres.supportEmail || pres.website) set.add("help");
  return DESKTOP_ORDER.filter((s) => set.has(s));
}

export interface FileRowModel {
  artifact: PortalArtifact;
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

/** The reason a file isn't downloadable, in words (never only a tooltip, PA-6). */
export function notIncludedReason(a: PortalArtifact): string | null {
  if (a.canDownload) return null;
  if (a.access === "licensed") return "Needs an active license";
  if (a.access === "entitled")
    return "Your license doesn't include this version";
  return "Not available here yet";
}

export function fileRow(a: PortalArtifact, version: string): FileRowModel {
  const platform = normalisePlatform(a.platform);
  return {
    artifact: a,
    platform,
    title: archTitle(a, platform),
    meta: [version, ext(a.name), formatSize(a.sizeBytes)]
      .filter(Boolean)
      .join(" · "),
    notIncluded: notIncludedReason(a),
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
export function groupFiles(r: PortalRelease): PlatformGroup[] {
  const rows = r.artifacts.map((a) => fileRow(a, r.version));
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
  newerNotCovered: PortalRelease | null;
  /** Covered builds for the device in hand (Universal or Apple silicon first). */
  recommended: FileRowModel[];
  groups: PlatformGroup[];
}

export function getItModel(
  releases: readonly PortalRelease[],
  device: DeviceInHand,
): GetItModel | null {
  const newest = releases[0];
  if (!newest) return null;
  const covered = releases.find((r) => r.artifacts.some((a) => a.canDownload));
  const release = covered ?? newest;
  const groups = groupFiles(release);
  const recommended =
    device.os && !device.phone
      ? (groups.find((g) => g.platform === device.os)?.rows ?? []).filter(
          (r) => r.notIncluded === null,
        )
      : [];
  return {
    release,
    newerNotCovered: covered && covered !== newest ? newest : null,
    recommended,
    groups,
  };
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
