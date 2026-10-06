/**
 * `.pkey/distribution` (P2b-02, README §3.8 "Manifest", §3.12): HOW a product's releases reach
 * devices and outlets. `.pkey/release` stays about WHAT exists; this fourth document carries the
 * product's **outlets** (with their store identities), the **transports** each deliverable uses
 * per outlet, and its store **listing**.
 *
 * Three things it deliberately does not carry:
 *
 *   - **Outlet capabilities** (`codeUpdates`, `downloadedScripts`, `commerce`, …). They default
 *     per outlet KIND (the worker's `services/distribution/capabilities.ts`) and only an operator
 *     may narrow them, following the `requireSparkleSignature` precedent (R6-03): a repo must not
 *     be able to widen what an installed copy may do by pushing one line of YAML. A `capabilities`
 *     key ANYWHERE in the file is an error (`capabilities_not_manifest_writable`), not ignored, so
 *     the author learns it at validate time.
 *   - **Store credentials.** Never in a manifest (P5-01, `outlet_credentials`).
 *   - **Config-catalog keys.** Store ids and URLs belong here, not in `.pkey/schema`.
 *
 * `validateDistribution` is authoritative; `schemas/v1/distribution.schema.json` mirrors its
 * structural half, and `test/schema-parity.test.ts` keeps the two honest — every code emitted
 * below has a mutation-table entry (AGENTS rule 9). The cross-document checks (an `artifact` that
 * names the release document's artifact map, a channel key that names a declared channel, a
 * per-deliverable transport that names a declared deliverable) are validator-only.
 *
 * NOTE: this module imports from `./index.js`, which re-exports it. Nothing at this module's top
 * level may READ an import (the cycle leaves them uninitialised at that point); functions only.
 */

import {
  ARTIFACT_ENTRY_ID_PATTERN,
  RELEASE_PLATFORMS,
  type ValidationMessage,
} from "./index.js";

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────

/**
 * Every outlet kind (README §3.1 "outlet"), the kind type and the outlet-id pattern. They moved
 * to `@polaris-key/protocol/distribution` (P3-02), the one table every SDK and the Worker read;
 * re-exported here with the same values and order. An outlet id that is one of these kinds needs
 * no `kind`; outlet ids are lower-case, start with a letter and have at most 64 characters.
 */
export {
  OUTLET_KINDS,
  OUTLET_ID_PATTERN,
  type OutletKind,
} from "@polaris-key/protocol/distribution";
import {
  OUTLET_KINDS,
  OUTLET_ID_PATTERN,
  type OutletKind,
} from "@polaris-key/protocol/distribution";

/** The most outlets one document may declare. */
export const MAX_OUTLETS = 32;

/** How a deliverable's bytes arrive (README §3.1 "transport"). */
export const TRANSPORTS = [
  "embedded",
  "pkey-cdn",
  "apple-ba",
  "play-pad",
  "steam-depot",
  "msix-optional",
  "flatpak-ext",
  "web",
] as const;
export type Transport = (typeof TRANSPORTS)[number];

/**
 * Whether a transport lets a `compatible` or `standalone` pack float to a newer release after the
 * build ships (CONTENT §6.6; plans/P4-13.md decision 16). A transport that cannot float narrows the
 * pack to pinned on that outlet: the feed lists it in `packSets.outlets.<id>.pinned`. Only
 * `play-pad` narrows today (Play asset packs ship with the app bundle). `apple-ba` keeps floating
 * (the level is in the asset-pack id), `embedded` is a baseline under a CDN overlay. A constant,
 * not a validator rule.
 */
export const TRANSPORT_FLOATS: Readonly<Record<Transport, boolean>> = {
  embedded: true,
  "pkey-cdn": true,
  "apple-ba": true,
  "play-pad": false,
  "steam-depot": true,
  "msix-optional": true,
  "flatpak-ext": true,
  web: true,
};

/** The transport a deliverable uses when nothing says otherwise: our own CDN. */
export const DEFAULT_DISTRIBUTION_TRANSPORT: Transport = "pkey-cdn";

/**
 * Which outlet kinds may carry each transport. `null` = any outlet. `default` is applied to every
 * outlet, so it must be one of the `null` rows.
 */
export const TRANSPORT_OUTLET_KINDS: Readonly<
  Record<Transport, readonly OutletKind[] | null>
> = {
  embedded: null,
  "pkey-cdn": null,
  "apple-ba": ["app-store", "testflight"],
  "play-pad": ["play", "play-testing"],
  "steam-depot": ["steam"],
  "msix-optional": ["ms-store", "app-installer"],
  "flatpak-ext": ["flathub"],
  web: ["web"],
};

/** The outlet the absent document means (with distribution enabled): `direct`, by `pkey-cdn`. */
export const IMPLICIT_OUTLET_ID = "direct";

// ── Identity fields ─────────────────────────────────────────────────────────────────────────

/** A normalised outlet identity. Which fields apply depends on the kind (`OUTLET_IDENTITY_FIELDS`). */
export interface ManifestOutletIdentity {
  /** `app-store` / `testflight`: the App Store Connect app id (digits). */
  appleId?: string;
  /** `app-store` / `testflight` / `altstore` / `altstore-pal`: the iOS bundle id. */
  bundleId?: string;
  /** `testflight`: the join code of the public TestFlight link (`testflight.apple.com/join/<code>`). */
  publicLink?: string;
  /** `altstore` / `altstore-pal` / `obtainium` / `fdroid-repo`: an artifact-map `id` (P2-04). */
  artifact?: string;
  /** `altstore-pal`: the AltStore PAL marketplace id. */
  marketplaceId?: string;
  /** `play` / `play-testing` / `obtainium` / `fdroid-repo`: the Android package name. */
  packageName?: string;
  /** `play` / `play-testing`: declared channel → Play track. */
  tracks?: Record<string, string>;
  /** `ms-store`: the Store product id. */
  productId?: string;
  /**
   * `ms-store`: declared channel → package flight, named by its Partner Center friendly name or
   * its flight id (P5-04). The non-flighted submission is always the `stable` channel.
   */
  flights?: Record<string, string>;
  /** `ms-store` / `app-installer`: the MSIX package family name (`<Name>_<PublisherId>`). */
  packageFamilyName?: string;
  /**
   * `app-installer`: the package's `Publisher`, the signing certificate's subject DN exactly as
   * the MSIX manifest states it (`CN=…`). The `.appinstaller` P3-09 renders names the main
   * package by this and the `<Name>` half of `packageFamilyName`, and App Installer refuses a
   * file whose identity does not match the package byte for byte.
   */
  publisher?: string;
  /** `app-installer`: the `<UpdateSettings>` the rendered `.appinstaller` carries (P3-09). */
  updateSettings?: ManifestAppInstallerUpdateSettings;
  /** `steam`: the numeric app id, as decimal digits. `flathub`: the Flatpak application id. */
  appId?: string;
  /** `steam`: declared channel → Steam branch. */
  branches?: Record<string, string>;
  /** `itch`: the butler `user/game` target. */
  target?: string;
  /** `itch`: the numeric itch.io game id (the receipt's `game.id`), as decimal digits. */
  gameId?: string;
  /** `snap`: the snap name. */
  name?: string;
  /**
   * `snap`: declared channel → the snap channel(s) `snapcraft upload --release` may release to,
   * `[<track>/]<risk>[/<branch>]` (A-18h). The CI allow-list admits no other channel.
   */
  channels?: Record<string, string>;
  /** `winget`: the package identifier. */
  packageIdentifier?: string;
  /** `direct`: the platforms the direct download offers. */
  platforms?: string[];
  /** `direct`: the Homebrew cask token. */
  homebrewCask?: string;
  /** `direct`: the Homebrew formula name (P3-11), for an install whose executable's realpath is
   *  under `Cellar/<formula>/`. */
  homebrewFormula?: string;
  /**
   * `direct`: the product's OWN Homebrew tap, `<owner>/homebrew-<name>` on GitHub (A-18i). The
   * PR plane commits the cask (`Casks/<homebrewCask>.rb`) there and nowhere else; a repository of
   * the `Homebrew` organisation (`homebrew/cask`) is refused: that needs the owner, by hand.
   */
  homebrewTap?: string;
  /**
   * `direct` covering Windows: what the Scoop manifest P2b-05 renders installs — `bin`, the
   * executables (paths inside the archive) Scoop shims onto PATH, and `shortcuts`, Start-menu
   * entries as `[target, name]` pairs.
   */
  scoop?: ManifestScoop;
  /**
   * `direct` covering Windows: the product's OWN Scoop bucket, `<owner>/<repo>` on GitHub (A-18i).
   * The PR plane commits the feed's manifest (`bucket/<product>.json`) there; a repository of the
   * `ScoopInstaller` organisation (the official buckets) is refused.
   */
  scoopBucket?: string;
}

/**
 * `app-installer.updateSettings` (P3-09): App Installer's 2021-schema update behaviour. Absent
 * members take App Installer's defaults (a check on launch every 24 hours, no prompt).
 * `ForceUpdateFromAnyVersion` is deliberately not offered: it permits downgrades.
 */
export interface ManifestAppInstallerUpdateSettings {
  /** `OnLaunch HoursBetweenUpdateChecks`, 0-255. */
  hoursBetweenUpdateChecks?: number;
  /** `OnLaunch ShowPrompt`. */
  showPrompt?: boolean;
  /** `OnLaunch UpdateBlocksActivation`; requires `showPrompt`. */
  updateBlocksActivation?: boolean;
  /** `AutomaticBackgroundTask`: check every 8 hours in the background, without UI. */
  automaticBackgroundTask?: boolean;
}

/** `direct.scoop` (P2b-05). */
export interface ManifestScoop {
  bin?: string | string[];
  shortcuts?: [string, string][];
}
export type OutletIdentityField = keyof ManifestOutletIdentity;

/** The identity fields each kind reads. Any other key on an entry is ignored. */
export const OUTLET_IDENTITY_FIELDS: Readonly<
  Record<OutletKind, readonly OutletIdentityField[]>
> = {
  direct: [
    "platforms",
    "homebrewCask",
    "homebrewFormula",
    "homebrewTap",
    "scoop",
    "scoopBucket",
  ],
  "app-store": ["appleId", "bundleId"],
  testflight: ["appleId", "bundleId", "publicLink"],
  altstore: ["artifact", "bundleId"],
  "altstore-pal": ["artifact", "bundleId", "marketplaceId"],
  play: ["packageName", "tracks"],
  "play-testing": ["packageName", "tracks"],
  obtainium: ["artifact", "packageName"],
  "fdroid-repo": ["artifact", "packageName"],
  "ms-store": ["productId", "packageFamilyName", "flights"],
  "app-installer": ["packageFamilyName", "publisher", "updateSettings"],
  steam: ["appId", "branches"],
  itch: ["target", "gameId"],
  flathub: ["appId"],
  snap: ["name", "channels"],
  winget: ["packageIdentifier"],
  web: [],
};

/** A numeric store id: a positive integer, or the same as a string of digits (no leading 0). */
export const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const MAX_BUNDLE_ID_LENGTH = 155;
/** The join code of a public TestFlight link (P3-03, from which the feed composes `listingUrl`). */
export const TESTFLIGHT_PUBLIC_LINK_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const MARKETPLACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_PACKAGE_NAME_LENGTH = 255;
const PLAY_TRACK_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,99}$/;
const MS_PRODUCT_ID_RE = /^[A-Za-z0-9]{12}$/;
/** A Microsoft Store package flight: its friendly name or its flight id (a GUID). */
const MS_FLIGHT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:()-]{0,99}$/;
/** An MSIX `Publisher`: a certificate subject DN starting `CN=`, printable ASCII, at most 1024. */
export const MSIX_PUBLISHER_PATTERN = /^CN=[\x20-\x7e]{1,1021}$/;
/** `<Name>_<PublisherId>`: a 3–50 character package name and the 13-character publisher id. */
export const PACKAGE_FAMILY_NAME_PATTERN = /^[A-Za-z0-9.-]{3,50}_[a-z0-9]{13}$/;
const STEAM_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ITCH_TARGET_RE = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;
const FLATPAK_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
const MAX_FLATPAK_ID_LENGTH = 255;
const SNAP_NAME_RE = /^[a-z0-9](?:-?[a-z0-9]){0,39}$/;
/** A snap channel: `[<track>/]<risk>[/<branch>]` (A-18h; the CI allow-list's pattern). */
const SNAP_CHANNEL_RE =
  /^(?:[a-z0-9][a-z0-9.-]{0,63}\/)?(?:stable|candidate|beta|edge)(?:\/[a-z0-9][a-z0-9-]{0,63})?$/;
const WINGET_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,31}(\.[A-Za-z0-9][A-Za-z0-9-]{0,31}){1,7}$/;
/** A Homebrew cask token: lower-case letters, digits, `-`, `.` and `@`. */
export const HOMEBREW_CASK_PATTERN = /^[a-z0-9][a-z0-9.@-]{0,99}$/;
/** A Homebrew formula name (plans/P3-01.md §3): lower-case letters, digits, `.`, `@`
 *  (`python@3.12`), `+` (`libsigc++`), `_` and `-`. [I] until checked against Homebrew's own
 *  naming rules. */
export const HOMEBREW_FORMULA_PATTERN = /^[a-z0-9][a-z0-9.@+_-]{0,99}$/;
/**
 * The product's own Homebrew tap (A-18i): `<owner>/homebrew-<name>`, a GitHub repository whose
 * owner is not the `Homebrew` organisation (any case), so `homebrew/cask` and `homebrew/core` can
 * never be a PR-plane target.
 */
export const HOMEBREW_TAP_PATTERN =
  /^(?![Hh][Oo][Mm][Ee][Bb][Rr][Ee][Ww]\/)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/homebrew-[A-Za-z0-9._-]{1,90}$/;
/**
 * The product's own Scoop bucket (A-18i): `<owner>/<repo>` on GitHub, not of the
 * `ScoopInstaller` organisation (the official buckets), any case.
 */
export const SCOOP_BUCKET_PATTERN =
  /^(?![Ss][Cc][Oo][Oo][Pp][Ii][Nn][Ss][Tt][Aa][Ll][Ll][Ee][Rr]\/)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.)[A-Za-z0-9._-]{1,100}$/;
const MAX_CHANNEL_MAP_ENTRIES = 32;
/** A relative path inside a Windows archive: no drive, no leading separator, no `..`. */
export const SCOOP_PATH_PATTERN =
  /^(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9 ._()+-]{1,128}(?:[\\/][A-Za-z0-9 ._()+-]{1,128}){0,7}$/;
/** A Start-menu shortcut name: one line, at most 100 characters, no path separators. */
const SCOOP_SHORTCUT_NAME_RE = /^[^\u0000-\u001f\u007f\\/:*?"<>|]{1,100}$/;
const MAX_SCOOP_ENTRIES = 16;

/** Field checks: `null` = well-formed, otherwise what is wrong ("must …"). */
type FieldCheck = (value: unknown) => string | null;

const pattern =
  (re: RegExp, what: string, max?: number): FieldCheck =>
  (v) =>
    typeof v === "string" &&
    re.test(v) &&
    (max === undefined || v.length <= max)
      ? null
      : `must be ${what}`;

const numericId: FieldCheck = (v) =>
  (typeof v === "number" && Number.isSafeInteger(v) && v > 0) ||
  (typeof v === "string" && NUMERIC_ID_PATTERN.test(v))
    ? null
    : "must be a positive integer or a string of decimal digits with no leading zero";

const channelMap =
  (valueRe: RegExp, what: string): FieldCheck =>
  (v) => {
    if (!isRecord(v) || Object.keys(v).length > MAX_CHANNEL_MAP_ENTRIES)
      return `must be an object of at most ${MAX_CHANNEL_MAP_ENTRIES} channel → ${what} entries`;
    for (const value of Object.values(v)) {
      if (typeof value !== "string" || !valueRe.test(value))
        return `values must each be ${what}`;
    }
    return null;
  };

const platformList: FieldCheck = (v) => {
  const allowed: readonly string[] = RELEASE_PLATFORMS;
  if (
    !Array.isArray(v) ||
    v.length > allowed.length ||
    new Set(v).size !== v.length ||
    !v.every((p) => typeof p === "string" && allowed.includes(p))
  )
    return `must be a list of distinct platforms from ${allowed.join(", ")}`;
  return null;
};

/** The check for one field on one kind (`appId` means different things on steam and flathub). */
function fieldCheck(kind: OutletKind, field: OutletIdentityField): FieldCheck {
  switch (field) {
    case "appleId":
    case "gameId":
      return numericId;
    case "appId":
      return kind === "steam"
        ? numericId
        : pattern(
            FLATPAK_ID_RE,
            "a Flatpak application id (reverse-DNS, such as gg.vlad.Diceroll)",
            MAX_FLATPAK_ID_LENGTH,
          );
    case "bundleId":
      return pattern(
        BUNDLE_ID_RE,
        "a reverse-DNS bundle id (such as gg.vlad.diceroll)",
        MAX_BUNDLE_ID_LENGTH,
      );
    case "artifact":
      return (v) =>
        typeof v === "string" && ARTIFACT_ENTRY_ID_PATTERN.test(v)
          ? null
          : `must be an artifact-map id (${ARTIFACT_ENTRY_ID_PATTERN.source})`;
    case "marketplaceId":
      return pattern(MARKETPLACE_ID_RE, "a marketplace id");
    case "publicLink":
      return pattern(
        TESTFLIGHT_PUBLIC_LINK_PATTERN,
        "the join code of a public TestFlight link (1-32 letters and digits)",
      );
    case "packageName":
      return pattern(
        ANDROID_PACKAGE_RE,
        "an Android package name (such as gg.vlad.diceroll)",
        MAX_PACKAGE_NAME_LENGTH,
      );
    case "tracks":
      return channelMap(PLAY_TRACK_RE, "Play track");
    case "productId":
      return pattern(MS_PRODUCT_ID_RE, "a 12-character Microsoft Store id");
    case "flights":
      return channelMap(MS_FLIGHT_RE, "Microsoft Store package flight");
    case "packageFamilyName":
      return pattern(
        PACKAGE_FAMILY_NAME_PATTERN,
        "an MSIX package family name, <Name>_<PublisherId> with a 13-character publisher id",
      );
    case "branches":
      return channelMap(STEAM_BRANCH_RE, "Steam branch");
    case "target":
      return pattern(ITCH_TARGET_RE, "a butler user/game target");
    case "name":
      return pattern(SNAP_NAME_RE, "a snap name");
    case "channels":
      return channelMap(
        SNAP_CHANNEL_RE,
        "snap channel ([<track>/]<risk>[/<branch>], risk stable, candidate, beta or edge)",
      );
    case "packageIdentifier":
      return pattern(WINGET_ID_RE, "a winget package identifier");
    case "platforms":
      return platformList;
    case "homebrewCask":
      return pattern(
        HOMEBREW_CASK_PATTERN,
        "a Homebrew cask token (lower-case letters, digits, -, . and @)",
      );
    case "homebrewFormula":
      return pattern(
        HOMEBREW_FORMULA_PATTERN,
        "a Homebrew formula name (lower-case letters, digits, ., @, +, _ and -)",
      );
    case "homebrewTap":
      return pattern(
        HOMEBREW_TAP_PATTERN,
        "the product's own Homebrew tap, <owner>/homebrew-<name> on GitHub (never a Homebrew organisation repository)",
      );
    case "scoop":
      return scoopCheck;
    case "scoopBucket":
      return pattern(
        SCOOP_BUCKET_PATTERN,
        "the product's own Scoop bucket, <owner>/<repo> on GitHub (never a ScoopInstaller repository)",
      );
    case "publisher":
      return pattern(
        MSIX_PUBLISHER_PATTERN,
        "the MSIX package Publisher, a certificate subject DN starting CN= (printable ASCII, at most 1024 characters)",
      );
    case "updateSettings":
      return updateSettingsCheck;
  }
}

const UPDATE_SETTINGS_KEYS = [
  "hoursBetweenUpdateChecks",
  "showPrompt",
  "updateBlocksActivation",
  "automaticBackgroundTask",
];

const updateSettingsCheck: FieldCheck = (v) => {
  const shape =
    "must be { hoursBetweenUpdateChecks?: an integer 0-255, showPrompt?, updateBlocksActivation?, automaticBackgroundTask?: booleans }";
  if (
    !isRecord(v) ||
    Object.keys(v).some((k) => !UPDATE_SETTINGS_KEYS.includes(k))
  )
    return shape;
  const hours = v.hoursBetweenUpdateChecks;
  if (
    hours !== undefined &&
    !(
      Number.isSafeInteger(hours) &&
      (hours as number) >= 0 &&
      (hours as number) <= 255
    )
  )
    return shape;
  for (const k of UPDATE_SETTINGS_KEYS.slice(1))
    if (v[k] !== undefined && typeof v[k] !== "boolean") return shape;
  if (v.updateBlocksActivation === true && v.showPrompt !== true)
    return "may set updateBlocksActivation only with showPrompt: true (App Installer ignores it otherwise)";
  return null;
};

const scoopPath = (v: unknown): boolean =>
  typeof v === "string" && SCOOP_PATH_PATTERN.test(v);

const scoopCheck: FieldCheck = (v) => {
  const shape =
    "must be { bin?: a relative path or a list of at most 16, shortcuts?: at most 16 [target, name] pairs }";
  if (
    !isRecord(v) ||
    Object.keys(v).some((k) => k !== "bin" && k !== "shortcuts")
  )
    return shape;
  const bin = v.bin;
  if (
    bin !== undefined &&
    !scoopPath(bin) &&
    !(
      Array.isArray(bin) &&
      bin.length > 0 &&
      bin.length <= MAX_SCOOP_ENTRIES &&
      bin.every(scoopPath)
    )
  )
    return shape;
  const shortcuts = v.shortcuts;
  if (
    shortcuts !== undefined &&
    !(
      Array.isArray(shortcuts) &&
      shortcuts.length <= MAX_SCOOP_ENTRIES &&
      shortcuts.every(
        (s) =>
          Array.isArray(s) &&
          s.length === 2 &&
          scoopPath(s[0]) &&
          typeof s[1] === "string" &&
          SCOOP_SHORTCUT_NAME_RE.test(s[1]),
      )
    )
  )
    return shape;
  return null;
};

// ── Listing ─────────────────────────────────────────────────────────────────────────────────

/** Store-page metadata (README §3.1 "listing"). Every field is optional. */
export interface ManifestListing {
  name?: string;
  subtitle?: string;
  description?: string;
  iconUrl?: string;
  headerUrl?: string;
  tintColor?: string;
  category?: string;
  screenshots?: string[];
  website?: string;
  developerName?: string;
  /**
   * Where a customer gets help with the product (PX-W1, the portal's Help card and its "Renew
   * with <developer>" action). An https URL, like the other URL fields.
   */
  supportUrl?: string;
  /** The product's support address (PX-W1), shown as text in the portal; at most 254 characters. */
  supportEmail?: string;
}

const LISTING_TEXT_FIELDS = [
  "name",
  "subtitle",
  "category",
  "developerName",
] as const;
const LISTING_URL_FIELDS = [
  "iconUrl",
  "headerUrl",
  "website",
  "supportUrl",
] as const;
const MAX_LISTING_TEXT = 200;
const MAX_LISTING_DESCRIPTION = 4000;
const MAX_LISTING_URL = 2048;
const MAX_SCREENSHOTS = 16;
const TINT_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
/** No control characters at all (a single-line field). */
const LINE_RE = /^[^\u0000-\u001f\u007f]+$/;
/** No control characters but tab and newline (the description). */
const PROSE_RE = /^[^\u0000-\u0008\u000b-\u001f\u007f]+$/;
const HTTPS_URL_RE = /^https:\/\/[^\s\u0000-\u001f\u007f]+$/;
/** RFC 5321's 254-character path limit. */
const MAX_LISTING_EMAIL = 254;
/** One `local@domain.tld` address: no whitespace, no control characters, no angle brackets, one `@`. */
const LISTING_EMAIL_RE =
  /^[^\s@<>\u0000-\u001f\u007f]+@[^\s@<>\u0000-\u001f\u007f]+\.[^\s@<>\u0000-\u001f\u007f]+$/;

function isListingUrl(v: unknown): v is string {
  if (
    typeof v !== "string" ||
    v.length > MAX_LISTING_URL ||
    !HTTPS_URL_RE.test(v)
  )
    return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** What is wrong with a listing object, or `null`. */
function listingProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return "must be an object";
  for (const f of LISTING_TEXT_FIELDS) {
    const v = raw[f];
    if (
      v !== undefined &&
      (typeof v !== "string" || v.length > MAX_LISTING_TEXT || !LINE_RE.test(v))
    )
      return `${f} must be one line of 1 to ${MAX_LISTING_TEXT} characters`;
  }
  const d = raw.description;
  if (
    d !== undefined &&
    (typeof d !== "string" ||
      d.length > MAX_LISTING_DESCRIPTION ||
      !PROSE_RE.test(d))
  )
    return `description must be 1 to ${MAX_LISTING_DESCRIPTION} characters with no control characters but tab and newline`;
  for (const f of LISTING_URL_FIELDS) {
    if (raw[f] !== undefined && !isListingUrl(raw[f]))
      return `${f} must be an https URL of at most ${MAX_LISTING_URL} characters`;
  }
  if (
    raw.tintColor !== undefined &&
    (typeof raw.tintColor !== "string" || !TINT_COLOR_RE.test(raw.tintColor))
  )
    return "tintColor must be a #rrggbb colour";
  if (
    raw.supportEmail !== undefined &&
    (typeof raw.supportEmail !== "string" ||
      raw.supportEmail.length > MAX_LISTING_EMAIL ||
      !LISTING_EMAIL_RE.test(raw.supportEmail))
  )
    return `supportEmail must be one email address of at most ${MAX_LISTING_EMAIL} characters`;
  const shots = raw.screenshots;
  if (
    shots !== undefined &&
    (!Array.isArray(shots) ||
      shots.length > MAX_SCREENSHOTS ||
      !shots.every(isListingUrl))
  )
    return `screenshots must be a list of at most ${MAX_SCREENSHOTS} https URLs`;
  return null;
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────

/** What the distribution document is checked against from `.pkey/release`. */
export interface DistributionContext {
  /** The release document's artifact-map ids (`deliverables.app.artifacts[].id`). */
  artifactIds: ReadonlySet<string>;
  /** Every declared channel: stable, beta, the manual channels and the app's own channels. */
  channels: ReadonlySet<string>;
  /** Every declared deliverable and its kind; `app` is always present (implicit or declared). */
  deliverables: ReadonlyMap<string, string>;
}

/**
 * The kind an outlet entry resolves to, or `null` when it names none this build knows. An id
 * that is itself a kind IS that kind: an explicit `kind` there must repeat the id
 * (`outlet_kind_mismatch`), so `app-store: { kind: web }` can never re-kind the App Store outlet
 * into a self-hosted one and widen what its installed copies may do.
 */
function outletKindOf(id: string, entry: unknown): OutletKind | null {
  const kind = isRecord(entry) ? entry.kind : undefined;
  if (isOutletKind(id)) return kind === undefined || kind === id ? id : null;
  return isOutletKind(kind) ? kind : null;
}

export function isOutletKind(value: unknown): value is OutletKind {
  return (
    typeof value === "string" &&
    (OUTLET_KINDS as readonly string[]).includes(value)
  );
}

export function isTransport(value: unknown): value is Transport {
  return (
    typeof value === "string" &&
    (TRANSPORTS as readonly string[]).includes(value)
  );
}

/** May `transport` carry a deliverable on an outlet of `kind`? */
export function transportAllowed(
  transport: Transport,
  kind: OutletKind,
): boolean {
  const kinds = TRANSPORT_OUTLET_KINDS[transport];
  return kinds === null || kinds.includes(kind);
}

/**
 * Validate a `.pkey/distribution` document. Problems are appended to `errors` with
 * `file: "distribution"`; nothing is returned. Called by `validateManifestDocuments` (and so by
 * ingest and `pkey validate`) whenever the document is present.
 */
export function validateDistribution(
  errors: ValidationMessage[],
  doc: unknown,
  ctx: DistributionContext,
): void {
  if (!isRecord(doc)) {
    add(
      errors,
      "distribution",
      "/",
      "invalid_distribution",
      "the distribution document must be an object with outlets, transports and listing.",
    );
    return;
  }
  if (doc.apiVersion !== undefined && doc.apiVersion !== "pkey.dev/v1") {
    add(
      errors,
      "distribution",
      "/apiVersion",
      "invalid_api_version",
      "apiVersion must be pkey.dev/v1 when present.",
    );
  }

  // Capabilities are operator-owned: refused wherever they appear, never ignored.
  for (const path of capabilityPaths(doc)) {
    add(
      errors,
      "distribution",
      path,
      "capabilities_not_manifest_writable",
      "outlet capabilities are operator-owned and cannot be set in .pkey/distribution; they default per outlet kind and an operator narrows them in the console.",
    );
  }

  // ── outlets ──
  const kinds = new Map<string, OutletKind>();
  const outlets = doc.outlets;
  if (outlets !== undefined) {
    if (!isRecord(outlets) || Object.keys(outlets).length > MAX_OUTLETS) {
      add(
        errors,
        "distribution",
        "/outlets",
        "invalid_outlet_id",
        `outlets must be an object of at most ${MAX_OUTLETS} entries keyed by outlet id.`,
      );
    } else {
      for (const [id, entry] of Object.entries(outlets)) {
        validateOutlet(errors, id, entry, ctx, kinds);
      }
    }
  } else {
    kinds.set(IMPLICIT_OUTLET_ID, IMPLICIT_OUTLET_ID);
  }

  // ── transports ──
  const transports = doc.transports;
  if (transports !== undefined) {
    if (!isRecord(transports)) {
      add(
        errors,
        "distribution",
        "/transports",
        "invalid_transport",
        "transports must be an object { default, packs, deliverables }.",
      );
    } else {
      validateTransports(errors, transports, ctx, kinds);
    }
  }

  // ── listing ──
  if (doc.listing !== undefined) {
    const problem = listingProblem(doc.listing);
    if (problem) {
      add(
        errors,
        "distribution",
        "/listing",
        "invalid_listing",
        `listing ${problem}.`,
      );
    }
  }
}

function validateOutlet(
  errors: ValidationMessage[],
  id: string,
  entry: unknown,
  ctx: DistributionContext,
  kinds: Map<string, OutletKind>,
): void {
  if (!OUTLET_ID_PATTERN.test(id)) {
    add(
      errors,
      "distribution",
      `/outlets/${id}`,
      "invalid_outlet_id",
      `outlet ids must match ${OUTLET_ID_PATTERN.source}.`,
    );
    return;
  }
  if (!isRecord(entry)) {
    add(
      errors,
      "distribution",
      `/outlets/${id}`,
      "invalid_outlet_identity",
      `each outlet must be an object (write ${id}: {} for an outlet with no identity fields).`,
    );
    return;
  }
  if (isOutletKind(id) && entry.kind !== undefined && entry.kind !== id) {
    add(
      errors,
      "distribution",
      `/outlets/${id}/kind`,
      "outlet_kind_mismatch",
      `outlet ${id} is itself an outlet kind, so its kind may only be ${id} (or omitted); declare another id, such as ${id}-beta, for an outlet of a different kind.`,
    );
    return;
  }
  const kind = outletKindOf(id, entry);
  if (!kind) {
    add(
      errors,
      "distribution",
      `/outlets/${id}/kind`,
      "unknown_outlet_kind",
      `outlet ${id} needs a kind from ${OUTLET_KINDS.join(", ")} (an outlet id that is itself a kind may omit it).`,
    );
    return;
  }
  kinds.set(id, kind);

  for (const field of OUTLET_IDENTITY_FIELDS[kind]) {
    const value = entry[field];
    if (value === undefined) continue;
    const problem = fieldCheck(kind, field)(value);
    if (problem) {
      add(
        errors,
        "distribution",
        `/outlets/${id}/${field}`,
        "invalid_outlet_identity",
        `outlets.${id}.${field} ${problem}.`,
      );
      continue;
    }
    if (field === "artifact" && !ctx.artifactIds.has(value as string)) {
      add(
        errors,
        "distribution",
        `/outlets/${id}/artifact`,
        "unknown_artifact_ref",
        `outlets.${id}.artifact must name an id in .pkey/release deliverables.app.artifacts.`,
      );
    }
    if (
      field === "tracks" ||
      field === "branches" ||
      field === "flights" ||
      field === "channels"
    ) {
      for (const channel of Object.keys(value as Record<string, unknown>)) {
        if (!ctx.channels.has(channel)) {
          add(
            errors,
            "distribution",
            `/outlets/${id}/${field}/${channel}`,
            "unknown_channel_ref",
            `outlets.${id}.${field} keys must be declared channels (stable, beta, a manual channel or one of deliverables.app.channels).`,
          );
        }
      }
    }
  }

  if (
    kind === "direct" &&
    entry.scoop !== undefined &&
    Array.isArray(entry.platforms) &&
    !entry.platforms.includes("windows")
  ) {
    add(
      errors,
      "distribution",
      `/outlets/${id}/scoop`,
      "invalid_outlet_identity",
      `outlets.${id}.scoop describes a Windows install, so platforms must include windows.`,
    );
  }

  if (entry.listing !== undefined) {
    const problem = listingProblem(entry.listing);
    if (problem) {
      add(
        errors,
        "distribution",
        `/outlets/${id}/listing`,
        "invalid_listing",
        `outlets.${id}.listing ${problem}.`,
      );
    }
  }
}

function validateTransports(
  errors: ValidationMessage[],
  transports: Record<string, unknown>,
  ctx: DistributionContext,
  kinds: ReadonlyMap<string, OutletKind>,
): void {
  const def = transports.default;
  if (def !== undefined) {
    if (!isTransport(def)) {
      add(
        errors,
        "distribution",
        "/transports/default",
        "invalid_transport",
        `transports.default must be one of ${TRANSPORTS.join(", ")}.`,
      );
    } else if (TRANSPORT_OUTLET_KINDS[def] !== null) {
      add(
        errors,
        "distribution",
        "/transports/default",
        "transport_not_allowed",
        "transports.default applies to every outlet, so it must be a transport any outlet can carry (pkey-cdn or embedded).",
      );
    }
  }

  const checkMap = (path: string, raw: unknown): void => {
    if (raw === undefined) return;
    if (!isRecord(raw)) {
      add(
        errors,
        "distribution",
        path,
        "invalid_transport",
        "a transport map must be an object keyed by outlet id.",
      );
      return;
    }
    for (const [outletId, transport] of Object.entries(raw)) {
      if (!isTransport(transport)) {
        add(
          errors,
          "distribution",
          `${path}/${outletId}`,
          "invalid_transport",
          `transports must be one of ${TRANSPORTS.join(", ")}.`,
        );
        continue;
      }
      const kind = kinds.get(outletId);
      if (!kind) {
        add(
          errors,
          "distribution",
          `${path}/${outletId}`,
          "unknown_outlet_ref",
          `transport maps may only name outlets declared under outlets.`,
        );
      } else if (!transportAllowed(transport, kind)) {
        add(
          errors,
          "distribution",
          `${path}/${outletId}`,
          "transport_not_allowed",
          `transport ${transport} cannot carry a deliverable on a ${kind} outlet.`,
        );
      }
    }
  };

  checkMap("/transports/packs", transports.packs);
  const deliverables = transports.deliverables;
  if (deliverables === undefined) return;
  if (!isRecord(deliverables)) {
    add(
      errors,
      "distribution",
      "/transports/deliverables",
      "invalid_transport",
      "transports.deliverables must be an object keyed by deliverable id.",
    );
    return;
  }
  for (const [deliverableId, map] of Object.entries(deliverables)) {
    // A package (F-03, plans/F-01.md §3.3) is served only by its package feed: no outlet carries
    // it, so no transport can name it.
    if (ctx.deliverables.get(deliverableId) === "package") {
      add(
        errors,
        "distribution",
        `/transports/deliverables/${deliverableId}`,
        "invalid_transport_deliverable",
        `${deliverableId} is a package deliverable; packages are served only by package feeds, never through an outlet's transport.`,
      );
      continue;
    }
    if (!ctx.deliverables.has(deliverableId)) {
      add(
        errors,
        "distribution",
        `/transports/deliverables/${deliverableId}`,
        "unknown_deliverable_ref",
        `transports.deliverables keys must name a deliverable declared in .pkey/release (app is always declared).`,
      );
      continue;
    }
    checkMap(`/transports/deliverables/${deliverableId}`, map);
  }
}

/** JSON pointers of every `capabilities` key in the document (iterative: the input is hostile). */
function capabilityPaths(doc: Record<string, unknown>): string[] {
  const found: string[] = [];
  const stack: Array<{ node: unknown; path: string }> = [
    { node: doc, path: "" },
  ];
  while (stack.length) {
    const { node, path } = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    const entries = Array.isArray(node)
      ? node.map((v, i) => [String(i), v] as const)
      : Object.entries(node as Record<string, unknown>);
    for (const [key, child] of entries) {
      const childPath = `${path}/${key}`;
      if (!Array.isArray(node) && key === "capabilities") found.push(childPath);
      stack.push({ node: child, path: childPath });
    }
  }
  return found.sort();
}

// ── Normalised shape ────────────────────────────────────────────────────────────────────────

/** One declared outlet, as validated. */
export interface ManifestOutlet {
  id: string;
  kind: OutletKind;
  /** Only the fields `OUTLET_IDENTITY_FIELDS[kind]` names; numeric ids as decimal-digit strings. */
  identity: ManifestOutletIdentity;
  /** The per-outlet listing override, as written (not merged; see `outletListing`). */
  listing: ManifestListing | null;
}

/** `transports`, normalised. */
export interface ManifestTransports {
  default: Transport;
  /** Outlet id → the transport every pack deliverable uses there. */
  packs: Record<string, Transport>;
  /** Deliverable id → outlet id → transport. */
  deliverables: Record<string, Record<string, Transport>>;
}

/** One resolved (deliverable, outlet) pair: the row `dist_transports` stores. */
export interface ManifestTransportRoute {
  deliverableId: string;
  outletId: string;
  transport: Transport;
}

/** `.pkey/distribution`, normalised (or the implicit document). */
export interface ManifestDistribution {
  /** `false` = no document: the implicit `direct` outlet by `pkey-cdn`. */
  declared: boolean;
  /** Sorted by id. */
  outlets: ManifestOutlet[];
  transports: ManifestTransports;
  listing: ManifestListing | null;
  /** Every declared deliverable × every outlet, with its resolved transport; sorted. */
  routes: ManifestTransportRoute[];
}

/** A deliverable the routes are computed for: its id and kind (`app` | `pack`; a `package` is
 *  skipped, F-03). */
export interface DistributionDeliverable {
  id: string;
  kind: string;
}

/**
 * Normalise a VALIDATED distribution document (`undefined` = absent, the implicit document).
 * Malformed parts are dropped rather than coerced; validation has already reported them.
 * `deliverables` defaults to the implicit `app`.
 */
export function normalizeDistribution(
  doc: unknown,
  deliverables: readonly DistributionDeliverable[] = [
    { id: "app", kind: "app" },
  ],
): ManifestDistribution {
  const root = isRecord(doc) ? doc : {};
  const outlets: ManifestOutlet[] = [];
  if (doc === undefined || root.outlets === undefined) {
    outlets.push({
      id: IMPLICIT_OUTLET_ID,
      kind: IMPLICIT_OUTLET_ID,
      identity: {},
      listing: null,
    });
  } else if (isRecord(root.outlets)) {
    for (const [id, entry] of Object.entries(root.outlets)) {
      if (!OUTLET_ID_PATTERN.test(id) || !isRecord(entry)) continue;
      const kind = outletKindOf(id, entry);
      if (!kind) continue;
      outlets.push({
        id,
        kind,
        identity: normalizeIdentity(kind, entry),
        listing: normalizeListing(entry.listing),
      });
    }
  }
  outlets.sort((a, b) => compare(a.id, b.id));
  const kinds = new Map(outlets.map((o) => [o.id, o.kind]));

  const rawTransports = isRecord(root.transports) ? root.transports : {};
  const transportMap = (raw: unknown): Record<string, Transport> => {
    const out: Record<string, Transport> = {};
    if (!isRecord(raw)) return out;
    for (const [outletId, t] of Object.entries(raw)) {
      const kind = kinds.get(outletId);
      if (kind && isTransport(t) && transportAllowed(t, kind))
        out[outletId] = t;
    }
    return out;
  };
  const def = rawTransports.default;
  const transports: ManifestTransports = {
    default:
      isTransport(def) && TRANSPORT_OUTLET_KINDS[def] === null
        ? def
        : DEFAULT_DISTRIBUTION_TRANSPORT,
    packs: transportMap(rawTransports.packs),
    deliverables: {},
  };
  const known = new Map(deliverables.map((d) => [d.id, d.kind]));
  if (isRecord(rawTransports.deliverables)) {
    for (const [id, map] of Object.entries(rawTransports.deliverables)) {
      if (known.has(id) && known.get(id) !== "package")
        transports.deliverables[id] = transportMap(map);
    }
  }

  const routes: ManifestTransportRoute[] = [];
  for (const d of [...known].sort(([a], [b]) => compare(a, b))) {
    const [deliverableId, kind] = d;
    // A package never has a transport (F-03): feeds serve it, not outlets.
    if (kind === "package") continue;
    for (const o of outlets) {
      routes.push({
        deliverableId,
        outletId: o.id,
        transport:
          transports.deliverables[deliverableId]?.[o.id] ??
          (kind === "pack" ? transports.packs[o.id] : undefined) ??
          transports.default,
      });
    }
  }

  return {
    declared: doc !== undefined,
    outlets,
    transports,
    listing: normalizeListing(root.listing),
    routes,
  };
}

function normalizeIdentity(
  kind: OutletKind,
  entry: Record<string, unknown>,
): ManifestOutletIdentity {
  const out: Record<string, unknown> = {};
  for (const field of OUTLET_IDENTITY_FIELDS[kind]) {
    const value = entry[field];
    if (value === undefined || fieldCheck(kind, field)(value) !== null)
      continue;
    // Numeric ids are stored as their decimal digits whichever way they were written, so every
    // consumer (`dist_outlets.identity_json`, `pkey distribution outlet-ids`) sees one spelling.
    if (typeof value === "number") out[field] = String(value);
    else if (field === "scoop") out[field] = structuredCloneScoop(value);
    else if (Array.isArray(value)) out[field] = [...value];
    else if (isRecord(value)) out[field] = sortedRecord(value);
    else out[field] = value;
  }
  return out as ManifestOutletIdentity;
}

/** A validated `scoop` value, copied with a fixed key order (`bin`, then `shortcuts`). */
function structuredCloneScoop(v: unknown): ManifestScoop {
  const r = v as Record<string, unknown>;
  const out: ManifestScoop = {};
  if (typeof r.bin === "string") out.bin = r.bin;
  else if (Array.isArray(r.bin)) out.bin = [...(r.bin as string[])];
  if (Array.isArray(r.shortcuts))
    out.shortcuts = (r.shortcuts as [string, string][]).map(
      ([t, n]) => [t, n] as [string, string],
    );
  return out;
}

function normalizeListing(raw: unknown): ManifestListing | null {
  if (raw === undefined || listingProblem(raw) !== null) return null;
  const r = raw as Record<string, unknown>;
  const out: ManifestListing = {};
  for (const f of [
    ...LISTING_TEXT_FIELDS,
    "description",
    ...LISTING_URL_FIELDS,
    "tintColor",
    "supportEmail",
  ] as const) {
    if (typeof r[f] === "string") out[f] = r[f] as string;
  }
  if (Array.isArray(r.screenshots)) out.screenshots = [...r.screenshots];
  return out;
}

/** The listing an outlet shows: the document's listing with the outlet's override merged over it. */
export function outletListing(
  dist: ManifestDistribution,
  outletId: string,
): ManifestListing | null {
  const outlet = dist.outlets.find((o) => o.id === outletId);
  if (!dist.listing && !outlet?.listing) return null;
  return { ...(dist.listing ?? {}), ...(outlet?.listing ?? {}) };
}

// ── Identities for runtime outlet detection (`pkey distribution outlet-ids`) ────────────────

/**
 * The `outletIds` object P1-11's export plugin stamps into a build (`PKEY_OUTLET_IDS`; notes/S-06
 * rule 4): the product's store ids a runtime launcher signal must name. Every value is a STRING.
 *
 * `outletId` is the build's own outlet entry. For each mapping the build's entry is used when it
 * has that kind, otherwise the entry whose id IS the kind (`steam`, `itch`, …). `msixFamilyName`
 * comes only from the build's own entry, and only when it is an `ms-store` or `app-installer`
 * outlet. `homebrewFormula` comes from the `direct` entry, and `bundleId` (P3-11) from the
 * build's own entry when it is an `app-store`, `testflight`, `altstore` or `altstore-pal`
 * outlet, else from the first of those kinds' entries that declares one. Returns `null` when the
 * document declares no outlet `outletId`.
 */
export function distributionOutletIds(
  dist: ManifestDistribution,
  outletId: string,
): Record<string, string> | null {
  const build = dist.outlets.find((o) => o.id === outletId);
  if (!build) return null;
  const entryOf = (kind: OutletKind): ManifestOutlet | undefined =>
    build.kind === kind
      ? build
      : dist.outlets.find((o) => o.id === kind && o.kind === kind);
  const out: Record<string, string> = {};
  const put = (key: string, value: string | undefined): void => {
    if (typeof value === "string" && value) out[key] = value;
  };
  put("steamAppId", entryOf("steam")?.identity.appId);
  put("itchGameId", entryOf("itch")?.identity.gameId);
  put("flatpakId", entryOf("flathub")?.identity.appId);
  put("snapName", entryOf("snap")?.identity.name);
  put("caskToken", entryOf("direct")?.identity.homebrewCask);
  put("homebrewFormula", entryOf("direct")?.identity.homebrewFormula);
  if (build.kind === "ms-store" || build.kind === "app-installer")
    put("msixFamilyName", build.identity.packageFamilyName);
  const apple: readonly OutletKind[] = [
    "app-store",
    "testflight",
    "altstore",
    "altstore-pal",
  ];
  put(
    "bundleId",
    (apple.includes(build.kind) ? build.identity.bundleId : undefined) ??
      apple.map((k) => entryOf(k)?.identity.bundleId).find((v) => !!v),
  );
  return sortedRecord(out) as Record<string, string>;
}

// ── helpers (local: `index.ts`'s are private, and this module must not read an import at load) ─

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedRecord(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v).sort(compare)) out[key] = v[key];
  return out;
}

function add(
  list: ValidationMessage[],
  file: ValidationMessage["file"],
  path: string,
  code: string,
  message: string,
): void {
  list.push({ file, path, code, message });
}
