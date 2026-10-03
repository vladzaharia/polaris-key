/**
 * The app-updater feed RENDERERS (P3-09, README §3.6 "App-updater feeds"): pure functions from a
 * feed's selection (`Delivery.feedSelection`, P2b-05's rules) plus the facts verified from the
 * stored bytes (`artifactBytes.ts`) to the document each native updater reads. No I/O, no clock,
 * no randomness: the same input renders the same bytes, so every renderer snapshot-tests and a
 * strong ETag (the body's SHA-256) moves only when the content does.
 *
 *   - Sparkle, extended (`renderSparkleAppcast`, notes/E1 §Sparkle 2.9–2.10): `sparkle:version`
 *     is the build number; `criticalUpdate` from the channel's `critical` (the pointer release)
 *     and its floor; `phasedRolloutInterval` while the direct outlet's rollout is active (the
 *     mapping is `phasedSchedule` below); `sparkle:deltas` from `delta` artifacts that name their
 *     `deltaFrom`; `hardwareRequirements` `arm64` for an Apple-silicon-only build; a universal
 *     DMG serves both architectures.
 *   - WinSparkle (`renderWinSparkleAppcast`, notes/E3 §A3.2): one item per release, one
 *     enclosure per Windows installer build with `sparkle:os` and `sparkle:installerArguments`,
 *     versions repeated on the enclosure; WinSparkle has no channels, so the URL is per channel.
 *   - Velopack (`renderVelopackFeed`, notes/E3 §A3.1): `{"Assets": [...]}` with `PackageId`,
 *     `Version`, `Type` (`Full` | `Delta`), `FileName` as the BARE package file name (as `vpk`
 *     writes it), `SHA1`, `SHA256`, `Size` and the notes. Not a URL: Velopack's Rust core
 *     (`velopack_libc`, the Rust crate) downloads `url.join(FileName)` but also saves to
 *     `packages_dir.join(FileName)`, so an absolute URL fails the local write on Windows (os error
 *     123, notes/S-11 §4.2). The client resolves the bare name against the feed URL, which lands
 *     on `…/velopack/<FileName>`: a 302 to the package's immutable delivery URL (`updaterFeeds.ts`).
 *   - App Installer (`renderAppInstaller`, notes/E3 §A2): the 2021 schema; `Uri` is the URL the
 *     file is served from; the main package's `Name` and `Publisher` from `.pkey/distribution`;
 *     the build's four-part version; `OnLaunch`, `ShowPrompt`, `UpdateBlocksActivation` and
 *     `AutomaticBackgroundTask` as the outlet declares them.
 *   - zsync (`rewriteZsync`, notes/E3 §B1): CI's `.zsync` control file with its `URL:` header
 *     pointed at the current AppImage's immutable, Range-capable distribution URL.
 *   - The extended version check (`versionDocument`, plans/P3-01.md §6 "P3-09").
 *
 * Products are data: nothing here names a product beyond the feed vocabulary.
 */

import type { FeedSelectionEntry } from "../../core/hooks.js";
import type { ManifestAppInstallerUpdateSettings } from "@polaris-key/manifest";
import { compareVersions } from "@polaris-key/client-core/version";
import { MINIMUM_SYSTEM_VERSION_RE } from "../release/config.js";
import {
  proseToHtml,
  renderAppcast,
  rfc1123Seconds,
  xmlEscape,
  type AppcastItemInput,
} from "./appcast.js";

// ── Rollouts ─────────────────────────────────────────────────────────────────────────────────

/** Sparkle hard-codes seven update groups (`SUUpdateGroupIdentifier` mod 7). */
export const SPARKLE_GROUPS = 7;
/**
 * The `phasedRolloutInterval` the extended appcast uses: a year. Long on purpose, so the number of
 * groups open does not grow on its own (see `phasedSchedule`).
 */
export const PHASE_INTERVAL_SECONDS = 365 * 86_400;

/**
 * THE ROLLOUT MAPPING (Sparkle). Sparkle phases on the client: group `g` (0-6, random per
 * install, never sent) is offered an item once `now - pubDate >= g * interval`. It cannot express
 * a basis-point bucket, so an active rollout of `bp` opens `k = ceil(bp * 7 / 10000)` groups (at
 * least one) and holds there: `interval` is a year and `pubDate` is backdated to
 * `startedAt - (k - 1) * interval`, so exactly groups `0 … k-1` qualify from the rollout's start
 * until the operator changes `bp` (a new feed). 1-14 % opens one group, 15-28 % two, and so on;
 * 100 % (or `complete`) drops the interval and the real date returns. A paused or halted rollout
 * never reaches this: the release is held and the previous one served. Critical updates are not
 * phased (Sparkle ignores the interval for them, and so does this feed); a release critical only
 * below the floor (`criticalUpdate sparkle:version`) still is, for the installs above it.
 */
export function phasedSchedule(
  bp: number,
  startedAt: number,
): { pubDate: number; interval: number; groups: number } {
  const groups = Math.min(
    SPARKLE_GROUPS,
    Math.max(1, Math.ceil((bp * SPARKLE_GROUPS) / 10000)),
  );
  return {
    pubDate: startedAt - (groups - 1) * PHASE_INTERVAL_SECONDS,
    interval: PHASE_INTERVAL_SECONDS,
    groups,
  };
}

/** The channel policy a feed reads (`release_channel_policy` for the app on this channel). */
export interface ChannelPolicyView {
  critical: boolean;
  pointerReleaseId: string | null;
  minSupported: string | null;
}

// ── Sparkle (extended) ───────────────────────────────────────────────────────────────────────

/** One listed release for the Sparkle appcast, with what was verified from its bytes. */
export interface SparkleSource {
  entry: FeedSelectionEntry;
  /** The verified `sparkle:edSignature` of the payload; absent when unsigned. */
  edSignature?: string;
  /** Verified deltas that name their `deltaFrom`. */
  deltas: Array<{
    url: string;
    size: number;
    deltaFrom: string;
    edSignature?: string;
  }>;
}

export interface SparkleRenderInput {
  channelTitle: string;
  link: string;
  productName: string;
  /** The app's version scheme (`versioning.scheme`), for the floor comparison. */
  scheme: string;
  /** Newest first. */
  sources: readonly SparkleSource[];
  policy: ChannelPolicyView | null;
  /** The operator's `minimumSystemVersion`, for a build that declares no `minOS`. */
  minimumSystemVersion?: string;
}

/** `sparkle:criticalUpdate` for one item: see the file comment. */
function criticalFor(
  entry: FeedSelectionEntry,
  input: SparkleRenderInput,
): { version?: string } | undefined {
  const p = input.policy;
  if (!p) return undefined;
  if (p.critical && p.pointerReleaseId === entry.releaseId) return {};
  const floor = p.minSupported;
  if (!floor || (compareVersions(input.scheme, entry.version, floor) ?? 0) <= 0)
    return undefined;
  // `sparkle:version` on criticalUpdate is compared with the INSTALLED bundle version, which is
  // the build number: the floor release's build number when it is listed, else the floor itself
  // where builds carry no separate number.
  const listed = input.sources.find((s) => s.entry.version === floor)?.entry;
  if (listed) return { version: listed.buildNumber ?? listed.version };
  if (input.sources.every((s) => s.entry.buildNumber === null))
    return { version: floor };
  return undefined;
}

export function sparkleItem(
  s: SparkleSource,
  input: SparkleRenderInput,
): AppcastItemInput {
  const e = s.entry;
  const critical = criticalFor(e, input);
  const phased =
    // A release critical to EVERYONE is never phased (Sparkle bypasses phasing for it). One
    // critical only below the floor still phases for every install at or above it.
    e.rollout && !(critical && critical.version === undefined)
      ? phasedSchedule(e.rollout.bp, e.rollout.startedAt)
      : null;
  const minSys =
    e.minOs && MINIMUM_SYSTEM_VERSION_RE.test(e.minOs)
      ? e.minOs
      : input.minimumSystemVersion;
  return {
    title: `${input.productName} ${e.version}`,
    shortVersion: e.version,
    build: e.buildNumber ?? e.version,
    url: e.url,
    length: e.size ?? 0,
    pubDate: rfc1123Seconds(phased ? phased.pubDate : e.publishedAt),
    ...(s.edSignature ? { edSignature: s.edSignature } : {}),
    ...(minSys ? { minimumSystemVersion: minSys } : {}),
    ...(e.notes ? { descriptionHtml: proseToHtml(e.notes) } : {}),
    ...(e.arch === "arm64" ? { hardwareRequirements: "arm64" } : {}),
    ...(critical ? { criticalUpdate: critical } : {}),
    ...(phased ? { phasedRolloutInterval: phased.interval } : {}),
    ...(s.deltas.length
      ? {
          deltas: s.deltas.map((d) => ({
            url: d.url,
            length: d.size,
            deltaFrom: d.deltaFrom,
            ...(d.edSignature ? { edSignature: d.edSignature } : {}),
          })),
        }
      : {}),
  };
}

export function renderSparkleAppcast(input: SparkleRenderInput): string {
  return renderAppcast({
    channelTitle: input.channelTitle,
    link: input.link,
    items: input.sources.map((s) => sparkleItem(s, input)),
  });
}

// ── WinSparkle ───────────────────────────────────────────────────────────────────────────────

/** WinSparkle's `sparkle:os` for a build's arch. */
export function winSparkleOs(arch: string): string {
  if (arch === "x86_64") return "windows-x64";
  if (arch === "arm64") return "windows-arm64";
  return "windows";
}

/**
 * The silent-install switches for an installer format (notes/E3 §A3.2), or `undefined` when the
 * format does not say which installer it is (a bare `exe`).
 */
export function installerArgumentsFor(
  format: string | null,
): string | undefined {
  switch (format) {
    case "msi":
      return "/passive";
    case "inno":
      return "/SILENT /SP- /NOICONS";
    case "nsis":
      return "/S";
    default:
      return undefined;
  }
}

/** One Windows installer build for the WinSparkle appcast. */
export interface WinSparkleSource {
  entry: FeedSelectionEntry;
  edSignature?: string;
}

export function renderWinSparkleAppcast(input: {
  channelTitle: string;
  link: string;
  productName: string;
  /** Newest release first; the builds of one release adjacent. */
  sources: readonly WinSparkleSource[];
}): string {
  const byRelease = new Map<string, WinSparkleSource[]>();
  for (const s of input.sources) {
    const list = byRelease.get(s.entry.releaseId) ?? [];
    list.push(s);
    byRelease.set(s.entry.releaseId, list);
  }
  const items: AppcastItemInput[] = [];
  // x64 first: a WinSparkle older than 0.8.3 reads only the first enclosure.
  const rank = (a: string): number =>
    a === "x86_64" ? 0 : a === "arm64" ? 1 : 2;
  for (const unordered of byRelease.values()) {
    const builds = [...unordered].sort(
      (a, b) => rank(a.entry.arch) - rank(b.entry.arch),
    );
    const [head, ...rest] = builds as [WinSparkleSource, ...WinSparkleSource[]];
    const e = head.entry;
    const minSys = e.minOs ?? undefined;
    const args = installerArgumentsFor(e.format);
    items.push({
      title: `${input.productName} ${e.version}`,
      shortVersion: e.version,
      build: e.buildNumber ?? e.version,
      url: e.url,
      length: e.size ?? 0,
      pubDate: rfc1123Seconds(e.publishedAt),
      versionOnEnclosure: true,
      os: winSparkleOs(e.arch),
      ...(args ? { installerArguments: args } : {}),
      ...(head.edSignature ? { edSignature: head.edSignature } : {}),
      ...(minSys ? { minimumSystemVersion: minSys } : {}),
      ...(e.notes ? { descriptionHtml: proseToHtml(e.notes) } : {}),
      ...(rest.length
        ? {
            extraEnclosures: rest.map((r) => {
              const a = installerArgumentsFor(r.entry.format);
              return {
                url: r.entry.url,
                length: r.entry.size ?? 0,
                os: winSparkleOs(r.entry.arch),
                ...(a ? { installerArguments: a } : {}),
                ...(r.edSignature ? { edSignature: r.edSignature } : {}),
              };
            }),
          }
        : {}),
    });
  }
  return renderAppcast({
    channelTitle: input.channelTitle,
    link: input.link,
    items,
  });
}

// ── Velopack ─────────────────────────────────────────────────────────────────────────────────

/** One `releases.<channel>.json` asset (Velopack's `VelopackAsset`). */
export interface VelopackAsset {
  PackageId: string;
  Version: string;
  Type: "Full" | "Delta";
  FileName: string;
  SHA1: string;
  SHA256: string;
  Size: number;
  NotesMarkdown: string;
  NotesHTML: string;
}

/**
 * The Velopack package id a package file name carries — `vpk pack` names packages
 * `<packId>-<version>[-<channel>]-full.nupkg` (or `-delta`) — or `null` when the name does not
 * hold `-<version>`. Products never declare it twice: the file is the source.
 */
export function velopackPackageId(
  fileName: string,
  version: string,
): string | null {
  const at = fileName.indexOf(`-${version}`);
  if (at <= 0) return null;
  const id = fileName.slice(0, at);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) ? id : null;
}

/** The Velopack OS token of a `releases.<channel>.json` file → a release platform. */
export const VELOPACK_OS: Readonly<Record<string, string>> = {
  win: "windows",
  osx: "macos",
  linux: "linux",
};
/** The Velopack arch token → a release arch. */
export const VELOPACK_ARCH: Readonly<Record<string, string>> = {
  x64: "x86_64",
  arm64: "arm64",
};

export function velopackNotes(notes: string | null): {
  NotesMarkdown: string;
  NotesHTML: string;
} {
  return {
    NotesMarkdown: notes ?? "",
    NotesHTML: notes ? `<p>${proseToHtml(notes)}</p>` : "",
  };
}

export function renderVelopackFeed(assets: readonly VelopackAsset[]): string {
  return `${JSON.stringify({ Assets: assets }, null, 2)}\n`;
}

// ── App Installer ────────────────────────────────────────────────────────────────────────────

const FOUR_PART_RE = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;
const SEMVER_CORE_RE = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})(?:[-+].*)?$/;

/**
 * The MSIX four-part version of a build: its build number when that is four-part, else the
 * release version's `major.minor.patch` with a `.0` revision. Every part must fit MSIX's 16 bits.
 * `null` when neither gives one.
 */
export function msixVersion(
  entry: Pick<FeedSelectionEntry, "buildNumber" | "version">,
): string | null {
  const parts = (m: RegExpExecArray | null, extra: string[]): string | null => {
    if (!m) return null;
    const nums = [...m.slice(1, 1 + (4 - extra.length)), ...extra].map(Number);
    return nums.every((n) => Number.isSafeInteger(n) && n <= 65535)
      ? nums.join(".")
      : null;
  };
  if (entry.buildNumber) {
    const v = parts(FOUR_PART_RE.exec(entry.buildNumber), []);
    if (v) return v;
  }
  return (
    parts(FOUR_PART_RE.exec(entry.version), []) ??
    parts(SEMVER_CORE_RE.exec(entry.version), ["0"])
  );
}

/** MSIX `ProcessorArchitecture` for a build arch. */
export function msixArchitecture(arch: string): string {
  if (arch === "x86_64") return "x64";
  if (arch === "arm64") return "arm64";
  return "neutral";
}

export interface AppInstallerInput {
  /** The exact URL this file is served from (at most one query pair). */
  uri: string;
  /** The package identity name: the `<Name>` of the outlet's `packageFamilyName`. */
  name: string;
  publisher: string;
  version: string;
  /** The package's immutable, Range-capable distribution URL. */
  packageUri: string;
  /** `.msixbundle` / `.appxbundle`: a `MainBundle`, else a `MainPackage`. */
  bundle: boolean;
  /** A `MainPackage`'s `ProcessorArchitecture`. */
  architecture?: string;
  updateSettings: ManifestAppInstallerUpdateSettings | null;
}

export function renderAppInstaller(input: AppInstallerInput): string {
  const main = input.bundle
    ? `<MainBundle Name="${xmlEscape(input.name)}" Publisher="${xmlEscape(input.publisher)}" Version="${xmlEscape(input.version)}" Uri="${xmlEscape(input.packageUri)}" />`
    : `<MainPackage Name="${xmlEscape(input.name)}" Publisher="${xmlEscape(input.publisher)}" Version="${xmlEscape(input.version)}"${
        input.architecture
          ? ` ProcessorArchitecture="${xmlEscape(input.architecture)}"`
          : ""
      } Uri="${xmlEscape(input.packageUri)}" />`;
  const u = input.updateSettings ?? {};
  const onLaunch = [
    u.hoursBetweenUpdateChecks !== undefined
      ? ` HoursBetweenUpdateChecks="${u.hoursBetweenUpdateChecks}"`
      : "",
    u.showPrompt !== undefined ? ` ShowPrompt="${u.showPrompt}"` : "",
    u.updateBlocksActivation !== undefined
      ? ` UpdateBlocksActivation="${u.updateBlocksActivation}"`
      : "",
  ].join("");
  const background = u.automaticBackgroundTask
    ? "\n    <AutomaticBackgroundTask />"
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2021" Version="${xmlEscape(input.version)}" Uri="${xmlEscape(input.uri)}">
  ${main}
  <UpdateSettings>
    <OnLaunch${onLaunch} />${background}
  </UpdateSettings>
</AppInstaller>
`;
}

// ── zsync ────────────────────────────────────────────────────────────────────────────────────

/** How far into a `.zsync` file its header may run. */
const MAX_ZSYNC_HEADER = 64 * 1024;

/** Headers that would point a zsync client at bytes or a command other than `URL:` (see below). */
const ZSYNC_REFUSED_HEADERS = ["Z-URL:", "Z-Map2:", "Recompress:"] as const;

/**
 * CI's `.zsync` control file with its `URL:` header replaced by `url` (absolute), or `null` when
 * the file has no header, or its `Length:` is not `expectedLength` (it then describes some other
 * AppImage, and a client would rebuild the wrong file). The checksum blocks are untouched.
 *
 * A header that names another place or process to get bytes from is refused outright, not
 * rewritten: `Z-URL:` (a compressed source the client fetches instead of, or as well as, `URL:`),
 * `Z-Map2:` (the block map that goes with it) and `Recompress:` (a gzip command line the zsync
 * client runs over the result). An AppImage's control file (`appimagetool -u`, plain
 * `zsyncmake`) carries none of them, so `URL:` stays the only source a client is pointed at.
 */
export function rewriteZsync(
  bytes: Uint8Array,
  url: string,
  expectedLength: number,
): Uint8Array | null {
  const limit = Math.min(bytes.length, MAX_ZSYNC_HEADER);
  let end = -1;
  for (let i = 0; i + 1 < limit; i++)
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      end = i;
      break;
    }
  if (end < 0) return null;
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, end));
  if (/[^\x20-\x7e\n]/.test(header)) return null;
  const lines = header.split("\n");
  if (lines.some((l) => ZSYNC_REFUSED_HEADERS.some((h) => l.startsWith(h))))
    return null;
  const length = lines.find((l) => l.startsWith("Length: "));
  if (
    !length ||
    length.slice("Length: ".length).trim() !== String(expectedLength)
  )
    return null;
  if (!/^[\x21-\x7e]+$/.test(url)) return null;
  const out: string[] = [];
  let placed = false;
  for (const l of lines) {
    if (l.startsWith("URL:")) {
      if (!placed) out.push(`URL: ${url}`);
      placed = true;
      continue;
    }
    out.push(l);
  }
  if (!placed) out.push(`URL: ${url}`);
  const head = new TextEncoder().encode(`${out.join("\n")}\n`);
  const tail = bytes.subarray(end + 1);
  const result = new Uint8Array(head.length + tail.length);
  result.set(head, 0);
  result.set(tail, head.length);
  return result;
}

// ── The extended version check ───────────────────────────────────────────────────────────────

/** `/update/version` asked with `?platform=`, refined by `?arch=`/`?outlet=`/`?build=` (plans/P3-01.md §6). */
export interface VersionDocument {
  version: string;
  tag: string | null;
  url: string;
  build: string | null;
  sha256: string | null;
  size: number | null;
  downloadUrl: string;
  minOS: string | null;
  critical: boolean;
}

export function versionDocument(input: {
  entry: FeedSelectionEntry;
  policy: ChannelPolicyView | null;
  /** `owner/repo` of the product's GitHub repository, for the release page; `null` without. */
  githubRepo: string | null;
}): VersionDocument {
  const e = input.entry;
  // A descriptor release without a tag is stored as `<deliverable>@<version>`: no tag.
  const tag = e.releaseId.includes("@") ? null : e.releaseId;
  return {
    version: e.version,
    tag,
    url:
      tag && input.githubRepo
        ? `https://github.com/${input.githubRepo}/releases/tag/${encodeURIComponent(tag)}`
        : e.url,
    build: e.buildNumber,
    sha256: e.sha256,
    size: e.size,
    downloadUrl: e.url,
    minOS: e.minOs,
    critical:
      input.policy !== null &&
      input.policy.critical &&
      input.policy.pointerReleaseId === e.releaseId,
  };
}
