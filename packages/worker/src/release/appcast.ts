/// <reference types="@cloudflare/workers-types" />

/**
 * Sparkle appcast generation.
 *
 * The first product baked appcast.xml at build time with Sparkle's `generate_appcast`.
 * Here the Worker GENERATES it on the fly from GitHub release + asset metadata so any product
 * gets a feed for free. The mandatory `sparkle:edSignature` is NOT recomputed (the
 * Worker never holds the private key) — it is read from a sibling `<dmg>.sig` asset
 * that the release pipeline uploads alongside the DMG, exactly as Sparkle expects.
 * The `sparkle:version` (build) and `sparkle:shortVersionString` come from the tag.
 *
 * Output is deterministic given its inputs (no `Date.now()`), so it snapshot-tests.
 */

import type { Release, ReleaseAsset } from "./github.js";

export interface AppcastItemInput {
  /** Human title, e.g. `djdl 1.2.3`. */
  title: string;
  /** Marketing version string (CFBundleShortVersionString), e.g. `1.2.3`. */
  shortVersion: string;
  /** Build version (CFBundleVersion); falls back to shortVersion when unknown. */
  build: string;
  /** Full enclosure URL the updater downloads (points back at this gateway). */
  url: string;
  /** Enclosure byte length. */
  length: number;
  /** RFC-1123 pubDate string (already formatted; kept explicit for determinism). */
  pubDate: string;
  /** Base64 EdDSA signature from the sibling `.sig` asset. Omitted when no sidecar exists,
   *  in which case the enclosure renders WITHOUT a `sparkle:edSignature` attribute. */
  edSignature?: string;
  /** Optional minimum macOS version (sparkle:minimumSystemVersion). */
  minimumSystemVersion?: string;
  /** Optional HTML release notes embedded as the item <description>. */
  descriptionHtml?: string;
}

export interface AppcastInput {
  /** Channel feed title, e.g. `djdl` or `djdl (beta)`. */
  channelTitle: string;
  /** Feed link (the product site / origin). */
  link: string;
  items: AppcastItemInput[];
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/** Render one `<item>`. The DMG enclosure carries the Sparkle EdDSA attributes. */
function renderItem(item: AppcastItemInput): string {
  const minSys = item.minimumSystemVersion
    ? `\n      <sparkle:minimumSystemVersion>${xmlEscape(item.minimumSystemVersion)}</sparkle:minimumSystemVersion>`
    : "";
  const desc = item.descriptionHtml
    ? `\n      <description><![CDATA[${item.descriptionHtml}]]></description>`
    : "";
  // When the pipeline didn't publish a sibling `.sig`, omit the attribute rather than 404 —
  // the feed is still valid; Sparkle clients that require signing simply won't auto-update.
  const ed = item.edSignature
    ? ` sparkle:edSignature="${xmlEscape(item.edSignature)}"`
    : "";
  return `    <item>
      <title>${xmlEscape(item.title)}</title>
      <pubDate>${xmlEscape(item.pubDate)}</pubDate>
      <sparkle:version>${xmlEscape(item.build)}</sparkle:version>
      <sparkle:shortVersionString>${xmlEscape(item.shortVersion)}</sparkle:shortVersionString>${minSys}${desc}
      <enclosure url="${xmlEscape(item.url)}" type="application/octet-stream" length="${item.length}"${ed} />
    </item>`;
}

/** Render the full appcast document. Deterministic given its inputs. */
export function renderAppcast(input: AppcastInput): string {
  const items = input.items.map(renderItem).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xmlEscape(input.channelTitle)}</title>
    <link>${xmlEscape(input.link)}</link>
${items}
  </channel>
</rss>
`;
}

/** Parse `vX.Y.Z` / `X.Y.Z` to a bare semver string for the `shortVersionString`. */
export function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

/** Format an ISO timestamp (or null) to an RFC-1123 pubDate. Falls back to epoch. */
function rfc1123(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date(0);
  return d.toUTCString();
}

/**
 * Build the appcast item input for a release + its DMG asset, reading the EdDSA
 * signature the caller already fetched from the sibling `.sig` asset. The enclosure
 * `url` is supplied by the caller (it points back through this gateway).
 */
export function buildAppcastItem(
  release: Release,
  dmg: ReleaseAsset,
  edSignature: string | null | undefined,
  enclosureUrl: string,
  opts: {
    title?: string;
    minimumSystemVersion?: string;
    descriptionHtml?: string;
  } = {},
): AppcastItemInput {
  const shortVersion = versionFromTag(release.tag_name);
  return {
    title: opts.title ?? `${shortVersion}`,
    shortVersion,
    build: shortVersion,
    url: enclosureUrl,
    length: dmg.size,
    pubDate: rfc1123(release.published_at),
    ...(edSignature ? { edSignature } : {}),
    ...(opts.minimumSystemVersion
      ? { minimumSystemVersion: opts.minimumSystemVersion }
      : {}),
    ...(opts.descriptionHtml ? { descriptionHtml: opts.descriptionHtml } : {}),
  };
}

/** The conventional sibling-signature asset name for a DMG (`<dmg>.sig`). */
export function sigAssetName(dmgName: string): string {
  return `${dmgName}.sig`;
}
