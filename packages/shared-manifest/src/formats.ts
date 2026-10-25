/**
 * Product facts, pure (A-20.1): the known build formats, which file is which format, whether a
 * build's arch satisfies an arch requirement, and whether a build fits a distribution channel.
 *
 * A manifest's `format` stays free text (`ManifestArtifactEntry.format`); this table is what the
 * channel catalogue's `formats` draw on. A format outside it is not an error: it fits with an
 * `unknown-format` note. Nothing here reads the Worker, the network or a clock.
 */
import { CHANNELS, type ChannelEntry } from "./channels.generated.js";

export type FormatKind =
  | "disk-image"
  | "installer"
  | "archive"
  | "package"
  | "store-upload"
  | "web";

export interface KnownFormat {
  /** File-name suffixes, without the dot (`tar.gz` is one suffix). */
  extensions: readonly string[];
  /** The platforms the format is built for. */
  platforms: readonly string[];
  kind: FormatKind;
}

export const KNOWN_FORMATS = {
  dmg: { extensions: ["dmg"], platforms: ["macos"], kind: "disk-image" },
  pkg: { extensions: ["pkg"], platforms: ["macos", "ios"], kind: "installer" },
  zip: {
    extensions: ["zip"],
    platforms: ["macos", "windows", "linux"],
    kind: "archive",
  },
  "tar.gz": {
    extensions: ["tar.gz", "tgz"],
    platforms: ["macos", "windows", "linux"],
    kind: "archive",
  },
  msi: { extensions: ["msi"], platforms: ["windows"], kind: "installer" },
  exe: { extensions: ["exe"], platforms: ["windows"], kind: "installer" },
  msix: { extensions: ["msix"], platforms: ["windows"], kind: "package" },
  msixbundle: {
    extensions: ["msixbundle"],
    platforms: ["windows"],
    kind: "package",
  },
  appinstaller: {
    extensions: ["appinstaller"],
    platforms: ["windows"],
    kind: "package",
  },
  appimage: { extensions: ["appimage"], platforms: ["linux"], kind: "package" },
  deb: { extensions: ["deb"], platforms: ["linux"], kind: "package" },
  flatpak: { extensions: ["flatpak"], platforms: ["linux"], kind: "package" },
  snap: { extensions: ["snap"], platforms: ["linux"], kind: "package" },
  apk: { extensions: ["apk"], platforms: ["android"], kind: "package" },
  aab: { extensions: ["aab"], platforms: ["android"], kind: "store-upload" },
  ipa: { extensions: ["ipa"], platforms: ["ios"], kind: "store-upload" },
  depot: {
    extensions: ["depot"],
    platforms: ["windows", "macos", "linux"],
    kind: "store-upload",
  },
  html: { extensions: ["html"], platforms: ["web"], kind: "web" },
} as const satisfies Record<string, KnownFormat>;

export type KnownFormatId = keyof typeof KNOWN_FORMATS;

/** The format a file name carries, longest suffix first (`tar.gz` before `gz`), or null. */
export function formatOfFile(name: string): KnownFormatId | null {
  const lower = name.toLowerCase();
  let best: { id: KnownFormatId; len: number } | null = null;
  for (const [id, f] of Object.entries(KNOWN_FORMATS) as [
    KnownFormatId,
    KnownFormat,
  ][]) {
    for (const ext of f.extensions) {
      if (
        lower.length > ext.length + 1 &&
        lower.endsWith(`.${ext}`) &&
        (best === null || ext.length > best.len)
      )
        best = { id, len: ext.length };
    }
  }
  return best?.id ?? null;
}

/** Does a build's arch satisfy the accepted list? A `universal` or `any` build fits every list; otherwise the arch must be listed. */
export function archFits(arch: string, accepted: readonly string[]): boolean {
  if (arch === "universal" || arch === "any") return true;
  return accepted.includes(arch);
}

export type FitReason = "format" | "arch" | "unknown-format";

export interface FitBuild {
  platform: string;
  arch: string;
  /** Free text from the manifest; null when unknown. */
  format: string | null;
  /** A file name, used to find the format when `format` is null. */
  name?: string;
}

export interface ChannelFitResult {
  platform: string;
  fits: boolean;
  /** When `fits`, only a `unknown-format` note can appear; otherwise why no build fits. */
  reasons: FitReason[];
}

type FitEntry = Pick<ChannelEntry, "platforms" | "formats"> & {
  arches?: Readonly<Partial<Record<string, readonly string[]>>>;
};

/**
 * Whether a product's builds fit a channel, per platform the channel serves that some build
 * targets. A platform fits when any of its builds does. A build with an unknown or free-text
 * format fits on format, with an `unknown-format` note.
 */
export function channelFit(
  entry: FitEntry,
  builds: readonly FitBuild[],
): ChannelFitResult[] {
  const out: ChannelFitResult[] = [];
  for (const platform of entry.platforms) {
    const mine = builds.filter((b) => b.platform === platform);
    if (mine.length === 0) continue;
    const accepted = entry.arches?.[platform];
    const fitting: FitReason[][] = [];
    const failing = new Set<FitReason>();
    for (const b of mine) {
      const reasons: FitReason[] = [];
      const raw = b.format ?? (b.name ? formatOfFile(b.name) : null);
      const format = raw === null ? null : raw.toLowerCase();
      if (format === null || !Object.hasOwn(KNOWN_FORMATS, format))
        reasons.push("unknown-format");
      else if (!entry.formats.includes(format)) reasons.push("format");
      const bad: FitReason[] = [];
      if (reasons.includes("format")) bad.push("format");
      if (accepted && !archFits(b.arch, accepted)) bad.push("arch");
      if (bad.length === 0) fitting.push(reasons);
      else for (const r of [...bad, ...reasons]) failing.add(r);
    }
    if (fitting.length > 0) {
      const notes = fitting.every((r) => r.includes("unknown-format"))
        ? (["unknown-format"] as FitReason[])
        : [];
      out.push({ platform, fits: true, reasons: notes });
    } else out.push({ platform, fits: false, reasons: [...failing] });
  }
  return out;
}

/** A catalogue channel's fit by id; null for an unknown id. */
export function channelFitById(
  id: string,
  builds: readonly FitBuild[],
): ChannelFitResult[] | null {
  const entry = CHANNELS.find((c) => c.id === id);
  return entry ? channelFit(entry, builds) : null;
}
