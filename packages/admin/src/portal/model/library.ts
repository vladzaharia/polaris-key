import type {
  PortalArtifact,
  PortalLicenseSummary,
  PortalRelease,
} from "../api.js";
import { PLATFORM_ORDER, type PlatformKey } from "../components/Glyphs.js";

/**
 * The Library's model on today's API (PORTAL.md §5.3, §5.4, PX-02): licenses grouped into one
 * product each, the product's one status from its best license, and the one next action.
 *
 * Everything here is computed client-side from `GET /api/licenses` and `GET /api/releases`
 * until `GET /api/library` (G1, G5, PX-W1) returns it server-side. Facts today's API does not
 * carry are never guessed: no seat limit ("2 devices", not "of 3"), no developer name, no
 * Steam-key or device-limit states.
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
  /** Not "Active" or "Signed-in app": counted by the Needs attention filter. */
  attention: boolean;
}

/** The presentation fields a product may carry (G1/G16 names); all optional today. */
export interface Presentation {
  developer: string | null;
  tint: string | null;
  website: string | null;
  supportUrl: string | null;
  supportEmail: string | null;
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
  /** Devices on the best license (no limit until G5). */
  deviceCount: number;
  /** This product's releases, newest first. */
  releases: PortalRelease[];
  latestVersion: string | null;
  platforms: PlatformKey[];
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
  };
}

/** "studio" → "Studio". A tier id is all today's API gives; this is its display fallback. */
export function tierLabel(tier: string | null): string | null {
  if (!tier) return null;
  const words = tier.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : null;
}

export function formatDay(epochSeconds: number, withYear = true): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(epochSeconds * 1000));
}

export function devicesText(n: number): string {
  return `${n} ${n === 1 ? "device" : "devices"}`;
}

/** §5.3: one status per license, first match wins. */
export function licenseStatus(
  l: PortalLicenseSummary,
  now: number,
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
  if (l.identityProvider === "oidc" && l.keyCount === 0) {
    return {
      kind: "signedInApp",
      label: "Signed-in app",
      tone: "neutral",
      note: "Sign in on any device",
      attention: false,
    };
  }
  const until = l.expiresAt !== null ? `until ${formatDay(l.expiresAt)}` : null;
  return {
    kind: "active",
    label: "Active",
    tone: "success",
    note: [tier, until, devicesText(l.deviceCount)].filter(Boolean).join(" · "),
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

/** Group licenses into products; releases attach by product slug. */
export function buildLibrary(
  licenses: readonly PortalLicenseSummary[],
  releases: readonly PortalRelease[],
  now: number,
): LibraryProduct[] {
  const bySlug = new Map<string, PortalLicenseSummary[]>();
  for (const l of licenses) {
    const list = bySlug.get(l.product);
    if (list) list.push(l);
    else bySlug.set(l.product, [l]);
  }
  const out: LibraryProduct[] = [];
  for (const [slug, list] of bySlug) {
    const best = bestLicense(list, now);
    const own = releases
      .filter((r) => r.product === slug)
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    const platforms = new Set<PlatformKey>();
    for (const r of own)
      for (const a of r.artifacts) {
        const p = normalisePlatform(a.platform);
        if (p) platforms.add(p);
      }
    out.push({
      slug,
      name: best.productName || slug,
      presentation: readPresentation(best.productBranding),
      licenses: list,
      best,
      status: licenseStatus(best, now),
      addedAt: Math.max(...list.map((l) => l.activatedAt)),
      deviceCount: best.deviceCount,
      releases: own,
      latestVersion: own[0]?.version ?? null,
      platforms: PLATFORM_ORDER.filter((p) => platforms.has(p)),
    });
  }
  return out.sort((a, b) => b.addedAt - a.addedAt);
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
      icon: "downloads" | "open" | "details";
      external?: boolean;
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

export function quickAction(
  p: LibraryProduct,
  device: DeviceInHand,
  productHref: (section?: "get" | "license") => string,
): QuickAction {
  if (p.status.kind === "signedInApp") {
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
  // Phones get no installer (§5.4): store links (G2) and "Email me the download" (G23) are not
  // available yet, so the action opens the product's downloads.
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
 * Only items the person can act on: an expiring, expired or suspended license with a renewal or
 * contact link (G16). Without one there is nothing to press, so the item is not shown (never a
 * dead-end "Needs attention"). Device limit and Steam keys join with G5 and G8.
 */
export function attentionItems(
  products: readonly LibraryProduct[],
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const p of products) {
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
