/**
 * Human-readable labels for a build or an artifact: platform and architecture, together.
 *
 * Every surface that shows a build or a release file to a person (the console, the customer
 * portal, the public download page, the CLI and the publish Action) names it through
 * {@link buildLabel}, so one file reads the same everywhere and a bare architecture ("arm64")
 * never stands in for a build. The stored and signed values are untouched: these labels are
 * display text only and never travel on the wire.
 *
 * Products are data (AGENTS rule 5): the tables below name platforms and architectures, never
 * a product. A value the tables do not know passes through verbatim.
 */

/** How a surface addresses its reader: operators (`console`) or end users (`consumer`). */
export type LabelAudience = "console" | "consumer";

export interface BuildLabelInput {
  /** The build's platform (`macos`, `windows`, …); null or `any` for a platform-independent build. */
  platform?: string | null;
  /** The build's architecture (`arm64`, `x86_64`, `universal`, `any`, …). */
  arch?: string | null;
  /** The build's format (`zip`, `dmg`, …), appended to the long form when given. */
  format?: string | null;
}

export interface BuildLabelOptions {
  /** `consumer` uses the download page's wording ("iPhone and iPad"). Default `console`. */
  audience?: LabelAudience;
}

export interface BuildLabel {
  /** The platform's display name ("macOS", "All platforms"). */
  platform: string;
  /** The architecture's display name ("Apple silicon"), or null when the platform implies it. */
  arch: string | null;
  /** "macOS Apple silicon" — for buttons, chips and narrow cells. */
  short: string;
  /** "macOS · Apple silicon (arm64)" — for titles, tooltips, aria-labels and logs. */
  long: string;
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  macos: "macOS",
  ios: "iOS / iPadOS",
  ipados: "iPadOS",
  android: "Android",
  windows: "Windows",
  linux: "Linux",
  web: "Web",
  tvos: "tvOS",
  visionos: "visionOS",
  watchos: "watchOS",
  steamos: "SteamOS",
  xbox: "Xbox",
  playstation: "PlayStation",
  ps4: "PlayStation 4",
  ps5: "PlayStation 5",
  switch: "Nintendo Switch",
};

const CONSUMER_PLATFORM_NAMES: Readonly<Record<string, string>> = {
  ios: "iPhone and iPad",
};

/** What a build for every platform is called. */
export const ALL_PLATFORMS_LABEL = "All platforms";
/** What a build whose platform could not be determined is called. */
export const UNKNOWN_PLATFORM_LABEL = "Unknown platform";

/** The arch names a platform's own vendor uses. */
const ARCH_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  macos: {
    arm64: "Apple silicon",
    x86_64: "Intel",
    universal: "Universal",
  },
  windows: { x86_64: "x64", arm64: "Arm64", x86: "x86" },
};

/** The conventional names, for Linux, Android and any platform without its own table. */
const CONVENTIONAL_ARCH_NAMES: Readonly<Record<string, string>> = {
  arm64: "ARM64",
  x86_64: "x86_64",
  armv7: "armv7",
  x86: "x86",
  wasm32: "WebAssembly",
  universal: "Universal",
};

/**
 * Archs a platform implies, so naming them adds nothing: every iOS / iPadOS build is arm64 and
 * every web build is WebAssembly or platform-neutral.
 */
const IMPLIED_ARCHES: Readonly<Record<string, readonly string[]>> = {
  ios: ["arm64", "universal", "any"],
  web: ["wasm32", "universal", "any"],
};

function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isAnyPlatform(platform: string | null | undefined): boolean {
  return !present(platform) || platform === "any";
}

/** `macos` → "macOS". An unknown platform passes through verbatim; none → "All platforms". */
export function platformLabel(
  platform: string | null | undefined,
  opts: BuildLabelOptions = {},
): string {
  if (isAnyPlatform(platform)) return ALL_PLATFORMS_LABEL;
  const p = platform as string;
  if (opts.audience === "consumer" && CONSUMER_PLATFORM_NAMES[p])
    return CONSUMER_PLATFORM_NAMES[p]!;
  return PLATFORM_NAMES[p] ?? p;
}

/**
 * `arm64` on `macos` → "Apple silicon". Null when there is nothing to say: no arch, an arch
 * that matches every machine on a platform-independent build, or one the platform implies.
 * `any` on a named platform reads as "Universal". An unknown arch passes through verbatim.
 */
export function archLabel(
  arch: string | null | undefined,
  platform?: string | null,
): string | null {
  if (!present(arch)) return null;
  if (isAnyPlatform(platform)) {
    if (arch === "any" || arch === "universal") return null;
    return CONVENTIONAL_ARCH_NAMES[arch] ?? arch;
  }
  const p = platform as string;
  if (IMPLIED_ARCHES[p]?.includes(arch)) return null;
  const a = arch === "any" ? "universal" : arch;
  return ARCH_NAMES[p]?.[a] ?? CONVENTIONAL_ARCH_NAMES[a] ?? arch;
}

/**
 * The label for a build or an artifact. `{ platform: "macos", arch: "arm64" }` →
 * `{ short: "macOS Apple silicon", long: "macOS · Apple silicon (arm64)" }`.
 *
 * The raw arch follows in parentheses when its display name differs from it beyond case. A
 * missing platform with a concrete arch reads "Unknown platform · arm64": an arch is never
 * shown alone. Infer the platform (the artifact's build, {@link platformFromFileName}) before
 * calling when one can be determined.
 */
export function buildLabel(
  input: BuildLabelInput,
  opts: BuildLabelOptions = {},
): BuildLabel {
  const arch = archLabel(input.arch, input.platform);
  const platform =
    isAnyPlatform(input.platform) && arch !== null
      ? UNKNOWN_PLATFORM_LABEL
      : platformLabel(input.platform, opts);
  const raw = present(input.arch) ? input.arch : null;
  const archLong =
    arch === null
      ? null
      : raw !== null &&
          raw !== "any" &&
          arch.toLowerCase() !== raw.toLowerCase()
        ? `${arch} (${raw})`
        : arch;
  const short = arch === null ? platform : `${platform} ${arch}`;
  const long = [platform, archLong, present(input.format) ? input.format : null]
    .filter((p): p is string => p !== null)
    .join(" · ");
  return { platform, arch, short, long };
}

/** File-name extensions that settle a platform on their own (longest first). */
const PLATFORM_EXTENSIONS: readonly (readonly [string, string])[] = [
  [".app.zip", "macos"],
  [".app.tar.gz", "macos"],
  [".dmg", "macos"],
  [".pkg", "macos"],
  [".exe", "windows"],
  [".msi", "windows"],
  [".msix", "windows"],
  [".msixbundle", "windows"],
  [".appx", "windows"],
  [".appimage", "linux"],
  [".deb", "linux"],
  [".rpm", "linux"],
  [".flatpak", "linux"],
  [".snap", "linux"],
  [".apk", "android"],
  [".aab", "android"],
  [".ipa", "ios"],
];

/** Name tokens (split on anything not a letter or digit) that name a platform. */
const PLATFORM_TOKENS: Readonly<Record<string, string>> = {
  macos: "macos",
  mac: "macos",
  osx: "macos",
  darwin: "macos",
  windows: "windows",
  win: "windows",
  win32: "windows",
  win64: "windows",
  linux: "linux",
  android: "android",
  ios: "ios",
  ipados: "ios",
  web: "web",
  wasm: "web",
};

/**
 * The platform a file name declares, or null. A platform-specific extension wins (`.app.zip`,
 * `.dmg`, `.exe`, `.AppImage`, `.apk`, `.ipa`, …); otherwise a name token does
 * (`djdl-macos-arm64.zip`, `tool_darwin_amd64.tar.gz`), and two tokens that disagree settle
 * nothing. Display and sniffing only: a declared platform always wins over this.
 */
export function platformFromFileName(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [ext, platform] of PLATFORM_EXTENSIONS) {
    if (lower.endsWith(ext)) return platform;
  }
  const found = new Set<string>();
  for (const token of lower.split(/[^a-z0-9]+/)) {
    const p = PLATFORM_TOKENS[token];
    if (p) found.add(p);
  }
  return found.size === 1 ? [...found][0]! : null;
}
