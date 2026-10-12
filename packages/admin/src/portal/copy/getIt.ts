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
  "getIt.flow.desktopBuilds": "You're viewing desktop builds.",
  "getIt.flow.emailMe": "Email me the download",
  "getIt.flow.otherBuilds": "Other platforms and architectures",
  "getIt.flow.channel": "Channel",
  "getIt.flow.sha256": "SHA-256",
  "getIt.flow.fullSha256": "Full SHA-256",
  "getIt.flow.copySha256": "Copy SHA-256",
  "getIt.flow.hint.pkg": "Open the .pkg and follow the installer.",
  "getIt.flow.hint.installer": "Run the installer and follow the steps.",
  "getIt.flow.hint.appimage": "Make it executable, then run it.",
  "getIt.flow.hint.package": "Install it with your package manager.",
  "getIt.flow.hint.apk": "Open the .apk on your Android device to install it.",
  "getIt.flow.hint.flatpak": "Install it with Flatpak.",
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

/** The focused download's primary on a computer: "Download for macOS". */
export function downloadFor(os: string): string {
  return `Download for ${os}`;
}

/**
 * That primary's accessible name. It begins with the visible words (label in name), then says
 * what they get: "Download for macOS: Orbit Survey 1.4.2, Universal".
 */
export function downloadName(
  os: string,
  product: string,
  version: string,
  arch: string,
): string {
  return `${downloadFor(os)}: ${product} ${version}, ${arch}`;
}

/** The phone's primary: "Email me the download: Orbit Survey for macOS". */
export function emailName(product: string, os: string): string {
  return `${GET_IT_COPY["getIt.flow.emailMe"]}: ${product} for ${os}`;
}

/** The toast after the email is sent. */
export function emailSent(product: string, os: string): string {
  return `We sent you the link to download ${product} for ${os}.`;
}

/** Under the title when the license's last covered version isn't the newest. */
export function lastCovered(newest: string): string {
  return `This is the last version your license covers. Version ${newest} isn't included.`;
}

/**
 * The line under a build's details (PORTAL.md §4.25 item 4): the one step that opens the file,
 * read from its format ("dmg", "tar.gz", ".dmg" too). Null when the format has no step of its
 * own: an .ipa installs through one of the install sources, listed as "Other ways to install".
 */
export function installHint(
  format: string | null,
  productName: string,
): string | null {
  switch (format?.replace(/^\./, "").toLowerCase()) {
    case "dmg":
      return `Open the .dmg and drag ${productName} to Applications.`;
    case "pkg":
      return GET_IT_COPY["getIt.flow.hint.pkg"];
    case "exe":
    case "msi":
    case "msix":
      return GET_IT_COPY["getIt.flow.hint.installer"];
    case "zip":
    case "tar.gz":
    case "tar.xz":
      return `Unzip it and open ${productName}.`;
    case "appimage":
      return GET_IT_COPY["getIt.flow.hint.appimage"];
    case "deb":
    case "rpm":
      return GET_IT_COPY["getIt.flow.hint.package"];
    case "apk":
      return GET_IT_COPY["getIt.flow.hint.apk"];
    case "flatpak":
      return GET_IT_COPY["getIt.flow.hint.flatpak"];
    default:
      return null;
  }
}
