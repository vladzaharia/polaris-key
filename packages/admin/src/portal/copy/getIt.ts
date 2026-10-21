import type { PlatformKey } from "../components/Glyphs.js";
import { t, type PortalKey } from "../../lib/copy.js";

/**
 * Get it's copy for stores and install sources (PORTAL.md §4.20; P0-48), on the product page and
 * in the focused download flow. Every string is a `getIt.*` key in the kit copy catalog (P0-36,
 * PX-28a), in all nine locales; this file keeps the names the callers already import. US spelling,
 * sentence case, no jargon (§6.1): "Other ways to install", never "install sources".
 */
const FIXED = [
  "getIt.alsoYoursOn",
  "getIt.otherWays",
  "getIt.newTab",
  "getIt.sourceUrl",
  "getIt.repositoryUrl",
  "getIt.fingerprint",
  "getIt.noFingerprint",
  "getIt.obtainiumWeb",
  "getIt.otherFiles",
  "getIt.flow.sourcesBelow",
  "getIt.flow.desktopBuilds",
  "getIt.flow.emailMe",
  "getIt.flow.otherBuilds",
  "getIt.flow.channel",
  "getIt.flow.sha256",
  "getIt.flow.fullSha256",
  "getIt.flow.copySha256",
  "getIt.flow.hint.pkg",
  "getIt.flow.hint.installer",
  "getIt.flow.hint.appimage",
  "getIt.flow.hint.package",
  "getIt.flow.hint.apk",
  "getIt.flow.hint.flatpak",
] as const satisfies readonly PortalKey[];

/** The fixed strings, read through the catalog on each use. */
export const GET_IT_COPY = Object.defineProperties(
  {},
  Object.fromEntries(
    FIXED.map((key) => [key, { enumerable: true, get: () => t(key) }]),
  ),
) as { readonly [K in (typeof FIXED)[number]]: string };

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
  return t("getIt.version", { version });
}

/** "Open this page on your computer to download Tidewater Studio." */
export function openOnComputer(product: string): string {
  return t("getIt.openOnComputer", { product });
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
    return t(
      /iPad|Macintosh/.test(ua)
        ? "getIt.installOn.ipad"
        : "getIt.installOn.iphone",
    );
  if (os === "android") return t("getIt.installOn.android");
  return t("getIt.installOn.device");
}

/** The copy button's accessible name: "Copy Homebrew command", "Copy source URL". */
export function copyLabel(
  what: "command" | "source" | "repository" | "fingerprint",
  name: string,
): string {
  switch (what) {
    case "command":
      return t("getIt.copy.command", { name });
    case "source":
      return t("getIt.copy.source");
    case "repository":
      return t("getIt.copy.repository");
    case "fingerprint":
      return t("getIt.copy.fingerprint");
  }
}

/** Under a QR code: which device scans it, and what it opens. */
export function scanHint(platform: PlatformKey | null, app: string): string {
  return t(
    platform === "ios"
      ? "getIt.scan.apple"
      : platform === "android"
        ? "getIt.scan.android"
        : "getIt.scan.phone",
    { app },
  );
}

/** The QR image's text alternative. */
export function qrAlt(label: string): string {
  return t("getIt.qrAlt", { name: label });
}

/** The sources list's accessible name: "Other ways to install on macOS". */
export function otherWaysOn(platform: string): string {
  return t("getIt.otherWaysOn", { platform });
}

/** The focused download's primary on a computer: "Download for macOS". */
export function downloadFor(os: string): string {
  return t("getIt.downloadFor", { platform: os });
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
  return t("getIt.downloadName", {
    platform: os,
    product,
    version,
    name: arch,
  });
}

/** The phone's primary: "Email me the download: Orbit Survey for macOS". */
export function emailName(product: string, os: string): string {
  return t("getIt.flow.emailName", { product, platform: os });
}

/** The toast after the email is sent. */
export function emailSent(product: string, os: string): string {
  return t("getIt.flow.emailSent", { product, platform: os });
}

/** Under the title when the license's last covered version isn't the newest. */
export function lastCovered(newest: string): string {
  return t("getIt.lastCovered", { version: newest });
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
      return t("getIt.flow.hint.dmg", { product: productName });
    case "pkg":
      return t("getIt.flow.hint.pkg");
    case "exe":
    case "msi":
    case "msix":
      return t("getIt.flow.hint.installer");
    case "zip":
    case "tar.gz":
    case "tar.xz":
      return t("getIt.flow.hint.zip", { product: productName });
    case "appimage":
      return t("getIt.flow.hint.appimage");
    case "deb":
    case "rpm":
      return t("getIt.flow.hint.package");
    case "apk":
      return t("getIt.flow.hint.apk");
    case "flatpak":
      return t("getIt.flow.hint.flatpak");
    default:
      return null;
  }
}
