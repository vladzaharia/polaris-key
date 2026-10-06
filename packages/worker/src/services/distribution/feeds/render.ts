/**
 * The storefront feed RENDERERS (P2b-05, README §3.8 "Storefront feeds"): pure functions from the
 * selected releases (`select.ts`) to the document each native client reads. No I/O, no clock, no
 * randomness: the same input renders the same bytes, so every feed golden-tests and its strong
 * ETag (the body's SHA-256) moves only when the content does.
 *
 * Each renderer follows its client's documented quirks (notes/E1 §B1–§B4, notes/E2 §B3 and §C2,
 * notes/E3 §A4 and §B2):
 *
 *   - AltStore / SideStore (`renderAltStoreSource`, `flavour: "classic"`): versions newest first,
 *     unique by (version, buildVersion); `appPermissions` from the IPA's extracted metadata
 *     (AltStore refuses an install whose permissions differ); BOTH `versions[]` and the legacy
 *     app-level `version`, `versionDate`, `versionDescription`, `downloadURL`, `size` (SideStore
 *     issue #735); and NO `marketplaceID`, which makes SideStore treat a source as notarized and
 *     refuse it.
 *   - AltStore PAL (`flavour: "pal"`): the same document WITH `marketplaceID`.
 *   - Both name the art Polaris Key hosts (HA-07): `iconURL`, `headerURL` and `screenshots` come
 *     from `input.art` (image-host URLs, resolved by `art.ts`) when it is given.
 *   - Obtainium (`renderObtainiumConfig`): the app-config JSON `obtainium://app/<json>` carries.
 *     `additionalSettings` is a JSON STRING. Key names were checked against Obtainium's source
 *     (`lib/models/app.dart` `App.fromJson`, `lib/app_sources/fdroidrepo.dart`,
 *     `lib/app_sources/direct_apk_link.dart`, `AppSource.sourceIdentifier` = the class name) on
 *     2026-10-01.
 *   - Scoop (`renderScoopManifest`): one version, `architecture.{64bit,arm64}.{url,hash}`,
 *     `bin`/`shortcuts` from the manifest, and `checkver`/`autoupdate` pointing back at the feed
 *     itself, so a bucket can track it or a user can `scoop install <url>`.
 *   - Flathub (`renderFlathubChecker`): `{version, releases: [{arch, url, sha256, size}]}`, the
 *     JSON an `x-checker-data` `type: json` checker reads for an extra-data source. A template over
 *     release data — no generated prose — and never a manifest: Polaris Key does not open,
 *     comment on or automate a Flathub pull request (S-07 row 12).
 *
 * Products are data: nothing here names a product or a store beyond the outlet-kind vocabulary.
 */

import { listingImageUrl, listingScreenshotUrls } from "@polaris-key/manifest";

/** One release as a feed lists it: a release, the outlet's build of it, and its payload. */
export interface RenderEntry {
  releaseId: string;
  version: string;
  /** Epoch seconds, or `null` when the source never said. */
  publishedAt: number | null;
  title: string | null;
  /** Release notes, or `null` (also when the product's metadata is not public). */
  notes: string | null;
  buildId: string;
  platform: string | null;
  arch: string;
  buildNumber: string | null;
  minOs: string | null;
  metadata: Record<string, unknown> | null;
  /** The payload's file name. */
  name: string;
  sha256: string | null;
  size: number | null;
  /** The immutable byte URL (`delivery.deliveryUrl`), absolute. */
  url: string;
}

/**
 * The store-page metadata a feed shows (the outlet's merged `.pkey/distribution` listing). Without
 * hosted art (`ListingArt`), the art is read through `listingImageUrl` / `listingScreenshotUrls`: a
 * stored row holds normalised asset refs (HA-04) or, when written before HA-04, the legacy URL
 * strings, and only an https ref has a URL a feed can name.
 */
export interface RenderListing {
  name?: string;
  subtitle?: string;
  description?: string;
  icon?: unknown;
  header?: unknown;
  /** Pre-HA-04 rows only. */
  iconUrl?: unknown;
  /** Pre-HA-04 rows only. */
  headerUrl?: unknown;
  tintColor?: string;
  category?: string;
  screenshots?: unknown[];
  website?: string;
  developerName?: string;
}

/**
 * The art a source names when Polaris Key hosts it (HA-07, `art.ts`): already resolved per field to
 * an image-host URL or, where no hosted copy stands for the listing's ref, the listing's own URL.
 * Absent (`null`), the renderer reads the listing's art as before (HA-10's rollback).
 */
export interface ListingArt {
  icon?: string;
  header?: string;
  screenshots: string[];
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** An ISO 8601 date for epoch seconds (UTC, second precision), or `undefined`. */
export function isoDate(seconds: number | null): string | undefined {
  if (seconds === null || !Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Drop `undefined` members so the serialised key set is exactly what is known. */
function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

// ── AltStore / SideStore / PAL ──────────────────────────────────────────────────────────────

/** AltStore's category vocabulary (notes/E1 §B1); anything else is left out (AltStore: other). */
const ALTSTORE_CATEGORIES = new Set([
  "developer",
  "entertainment",
  "games",
  "lifestyle",
  "other",
  "photo-video",
  "social",
  "utilities",
]);

export interface AltStoreInput {
  flavour: "classic" | "pal";
  /** The source's own URL (`sourceURL`). */
  sourceUrl: string;
  /** A stable, source-unique identifier (`identifier`). */
  identifier: string;
  /** The product's display name, the fallback when the listing has none. */
  productName: string;
  listing: RenderListing | null;
  /** The outlet's declared bundle id, the fallback when no IPA metadata names one. */
  bundleId: string | null;
  /** PAL only: the AltStore PAL marketplace id. */
  marketplaceId?: string;
  /** Newest first. Entries without iOS metadata are skipped (AltStore needs its permissions). */
  entries: readonly RenderEntry[];
  /** The art on hosted copies (HA-07), or absent/`null` to read the listing's own URLs. */
  art?: ListingArt | null;
}

interface IosMeta {
  bundleIdentifier: string;
  version: string;
  buildVersion: string;
  minOSVersion?: string;
  appPermissions: { entitlements: string[]; privacy: Record<string, string> };
}

function iosMeta(m: Record<string, unknown> | null): IosMeta | null {
  if (!m || typeof m.bundleIdentifier !== "string") return null;
  const p = m.appPermissions as IosMeta["appPermissions"] | undefined;
  if (
    typeof m.version !== "string" ||
    typeof m.buildVersion !== "string" ||
    !p ||
    !Array.isArray(p.entitlements) ||
    !p.privacy ||
    typeof p.privacy !== "object"
  )
    return null;
  return m as unknown as IosMeta;
}

/** The AltStore/SideStore (classic) or AltStore PAL source document. */
export function renderAltStoreSource(input: AltStoreInput): unknown {
  const l = input.listing ?? {};
  const name = str(l.name) ?? input.productName;
  const art = input.art ?? null;
  const screenshots = art ? art.screenshots : listingScreenshotUrls(l);
  const iconURL = art ? art.icon : listingImageUrl(l, "icon");
  const headerURL = art ? art.header : listingImageUrl(l, "header");
  const seen = new Set<string>();
  const versions: Record<string, unknown>[] = [];
  let newest: IosMeta | null = null;
  for (const e of input.entries) {
    const m = iosMeta(e.metadata);
    if (!m) continue;
    // Each entry must differ in version or buildVersion (AltStore compares the first).
    const key = `${m.version}\u0000${m.buildVersion}`;
    if (seen.has(key)) continue;
    // One app per source: a build of another bundle id does not belong in this app's history.
    if (newest && m.bundleIdentifier !== newest.bundleIdentifier) continue;
    seen.add(key);
    newest ??= m;
    versions.push(
      compact({
        version: m.version,
        buildVersion: m.buildVersion,
        date: isoDate(e.publishedAt),
        localizedDescription: e.notes ?? undefined,
        downloadURL: e.url,
        size: e.size ?? undefined,
        sha256: e.sha256 ?? undefined,
        minOSVersion: m.minOSVersion,
      }),
    );
  }

  const apps: unknown[] = [];
  if (newest && versions.length > 0) {
    const head = versions[0] as Record<string, unknown>;
    const permissions = {
      entitlements: [...newest.appPermissions.entitlements].sort(),
      privacy: Object.fromEntries(
        Object.entries(newest.appPermissions.privacy).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
    };
    apps.push(
      compact({
        name,
        bundleIdentifier: newest.bundleIdentifier ?? input.bundleId,
        ...(input.flavour === "pal"
          ? { marketplaceID: input.marketplaceId }
          : {}),
        developerName: str(l.developerName),
        subtitle: str(l.subtitle),
        localizedDescription: str(l.description) ?? str(l.subtitle) ?? name,
        iconURL,
        tintColor: str(l.tintColor)?.replace(/^#/, ""),
        category:
          l.category && ALTSTORE_CATEGORIES.has(l.category)
            ? l.category
            : undefined,
        screenshots: screenshots.length ? screenshots : undefined,
        versions,
        appPermissions: permissions,
        // The legacy app-level copy of the newest version (SideStore issue #735).
        version: head.version,
        versionDate: head.date,
        versionDescription: head.localizedDescription,
        downloadURL: head.downloadURL,
        size: head.size,
      }),
    );
  }

  return compact({
    name,
    identifier: input.identifier,
    sourceURL: input.sourceUrl,
    subtitle: str(l.subtitle),
    description: str(l.description),
    iconURL,
    headerURL,
    website: str(l.website),
    tintColor: str(l.tintColor)?.replace(/^#/, ""),
    apps,
    news: [],
  });
}

// ── Obtainium ───────────────────────────────────────────────────────────────────────────────

export type ObtainiumInput =
  | {
      /** The channel has an `fdroid-repo` outlet: track that repository. */
      source: "fdroid-repo";
      packageName: string;
      name: string;
      author: string;
      /** The repository URL (`…/fdroid/<channel>/repo`). */
      repoUrl: string;
      /** Stable prefers the stable versions of the repo; any other channel takes the newest. */
      stable: boolean;
    }
  | {
      /** No repository: Obtainium's Direct APK Link to the channel's moving builds URL. */
      source: "direct";
      packageName: string;
      name: string;
      author: string;
      /** `…/distribution/builds/<channel>/<buildId>`, whose strong ETag is the SHA-256. */
      apkUrl: string;
    };

/** The app config `obtainium://app/<url-encoded JSON>` carries (Obtainium's `App.fromJson`). */
export function renderObtainiumConfig(input: ObtainiumInput): unknown {
  if (input.source === "fdroid-repo") {
    return {
      id: input.packageName,
      url: input.repoUrl,
      author: input.author,
      name: input.name,
      overrideSource: "FDroidRepo",
      additionalSettings: JSON.stringify({
        appIdOrName: input.packageName,
        pickHighestVersionCode: !input.stable,
        trySelectingSuggestedVersionCode: input.stable,
      }),
    };
  }
  return {
    id: input.packageName,
    url: input.apkUrl,
    author: input.author,
    name: input.name,
    overrideSource: "DirectAPKLink",
    // The builds route's ETag is the payload's SHA-256, so ETag pseudo-versioning moves exactly
    // when the bytes do (a partial-hash read would fetch part of the APK on every check).
    additionalSettings: JSON.stringify({
      defaultPseudoVersioningMethod: "ETag",
    }),
  };
}

// ── Scoop ───────────────────────────────────────────────────────────────────────────────────

/** Scoop's architecture keys for this repo's `RELEASE_ARCHES`. `universal`/`any` run as 64-bit. */
const SCOOP_ARCH: Record<string, "64bit" | "arm64" | undefined> = {
  x86_64: "64bit",
  universal: "64bit",
  any: "64bit",
  arm64: "arm64",
};

export interface ScoopInput {
  /** The manifest's own URL (`checkver`, `autoupdate.hash`). */
  feedUrl: string;
  productName: string;
  listing: RenderListing | null;
  bin?: string | string[];
  shortcuts?: [string, string][];
  /** The newest release's Windows builds (one release). */
  entries: readonly RenderEntry[];
}

/** Replace every occurrence of `version` in `url` with Scoop's `$version` placeholder. */
function versionTemplate(url: string, version: string): string | null {
  if (!version || !url.includes(version)) return null;
  return url.split(version).join("$version");
}

/** A Scoop app manifest, or `null` when no Windows build has a hash and a URL. */
export function renderScoopManifest(input: ScoopInput): unknown | null {
  const arch: Record<string, { url: string; hash: string }> = {};
  const autoArch: Record<string, unknown> = {};
  let version: string | null = null;
  for (const e of input.entries) {
    const key = SCOOP_ARCH[e.arch];
    if (!key || arch[key] || !e.sha256) continue;
    version ??= e.version;
    if (e.version !== version) continue;
    arch[key] = { url: e.url, hash: e.sha256 };
    const template = versionTemplate(e.url, e.version);
    if (template)
      autoArch[key] = {
        url: template,
        hash: { url: input.feedUrl, jsonpath: `$.architecture.${key}.hash` },
      };
  }
  if (!version) return null;
  const l = input.listing ?? {};
  const keys = Object.keys(arch).sort() as Array<"64bit" | "arm64">;
  return compact({
    version,
    description: str(l.subtitle) ?? str(l.name) ?? input.productName,
    homepage: str(l.website),
    architecture: Object.fromEntries(keys.map((k) => [k, arch[k]])),
    bin: input.bin,
    shortcuts: input.shortcuts,
    checkver: { url: input.feedUrl, jsonpath: "$.version" },
    autoupdate:
      Object.keys(autoArch).length === keys.length
        ? {
            architecture: Object.fromEntries(keys.map((k) => [k, autoArch[k]])),
          }
        : undefined,
  });
}

// ── Flathub ─────────────────────────────────────────────────────────────────────────────────

/** Flatpak's architecture names. */
const FLATPAK_ARCH: Record<string, string | undefined> = {
  x86_64: "x86_64",
  arm64: "aarch64",
};

/**
 * The checker JSON for Flathub's External Data Checker (`x-checker-data: {type: json, url,
 * version-query: .version, url-query: …}`), or `null` when no Linux build qualifies.
 */
export function renderFlathubChecker(
  entries: readonly RenderEntry[],
): unknown | null {
  let version: string | null = null;
  const releases: Array<{
    arch: string;
    url: string;
    sha256: string;
    size: number;
  }> = [];
  for (const e of entries) {
    const arch = FLATPAK_ARCH[e.arch];
    if (!arch || !e.sha256 || e.size === null) continue;
    version ??= e.version;
    if (e.version !== version || releases.some((r) => r.arch === arch))
      continue;
    releases.push({ arch, url: e.url, sha256: e.sha256, size: e.size });
  }
  if (!version) return null;
  releases.sort((a, b) => (a.arch < b.arch ? -1 : a.arch > b.arch ? 1 : 0));
  return { version, releases };
}
