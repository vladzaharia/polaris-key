import type { PlatformKey } from "../components/Glyphs.js";

/**
 * Get it's copy for stores and install sources (PORTAL.md §4.20; P0-48), on the product page and
 * in the focused download flow.
 *
 * The catalog (`lib/copy.ts` `t()`) holds no `getIt.*` keys yet, so, like `profile.ts`, the strings
 * live here under the keys they will take, and the sentences built from data are the functions
 * below the table. US spelling, sentence
 * case, no jargon (§6.1): "Other ways to install", never "install sources".
 */
export const GET_IT_COPY = {
  "getIt.alsoYoursOn": "Also yours on",
  "getIt.otherWays": "Other ways to install",
  "getIt.newTab": "(opens in a new tab)",
  "getIt.sourceUrl": "Source URL",
  "getIt.repositoryUrl": "Repository URL",
  "getIt.fingerprint": "Repository fingerprint (SHA-256)",
  "getIt.noFingerprint":
    "No repository fingerprint is published. Check it with the developer before you trust the repository.",
  "getIt.obtainiumWeb": "Open via obtainium.imranr.dev",
  "getIt.otherFiles": "To download the files, open this page on your computer.",
  "getIt.flow.sourcesBelow": "Other ways to install it are below.",
} as const;

/** The product name the source's own app goes by, for a row's title ("AltStore", "Homebrew"). */
const SOURCE_NAME: Readonly<Record<string, string>> = {
  homebrew: "Homebrew",
  scoop: "Scoop",
  winget: "winget",
  altstore: "AltStore",
  sidestore: "SideStore",
  "altstore-pal": "AltStore PAL",
  fdroid: "F-Droid",
  obtainium: "Obtainium",
};

/** A source's name: the app it is added to, else the Worker's label. */
export function sourceName(s: { kind: string; label: string }): string {
  return SOURCE_NAME[s.kind] ?? s.label;
}

/** "Version 2.4.1". */
export function versionLine(version: string): string {
  return `Version ${version}`;
}

/** "Open this page on your computer to download Tidewater Studio." */
export function openOnComputer(product: string): string {
  return `Open this page on your computer to download ${product}.`;
}

/**
 * The phone lead's heading: "Install on this iPhone" (or iPad, read from the user agent: an iPad
 * reports a Mac one with touch), "Install on this Android device".
 */
export function installOnThis(
  os: PlatformKey,
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): string {
  if (os === "ios")
    return /iPad|Macintosh/.test(ua)
      ? "Install on this iPad"
      : "Install on this iPhone";
  if (os === "android") return "Install on this Android device";
  return "Install on this device";
}

/** The copy button's accessible name: "Copy Homebrew command", "Copy source URL". */
export function copyLabel(
  what: "command" | "source" | "repository" | "fingerprint",
  name: string,
): string {
  switch (what) {
    case "command":
      return `Copy ${name} command`;
    case "source":
      return "Copy source URL";
    case "repository":
      return "Copy repository URL";
    case "fingerprint":
      return "Copy repository fingerprint";
  }
}

/** Under a QR code: which device scans it, and what it opens. */
export function scanHint(platform: PlatformKey | null, app: string): string {
  const device =
    platform === "ios"
      ? "iPhone or iPad"
      : platform === "android"
        ? "Android device"
        : "phone";
  return `Scan with your ${device} to add it in ${app}.`;
}

/** The QR image's text alternative. */
export function qrAlt(label: string): string {
  return `QR code: ${label}`;
}

/** The sources list's accessible name: "Other ways to install on macOS". */
export function otherWaysOn(platform: string): string {
  return `Other ways to install on ${platform}`;
}
