/**
 * Every raw enum the console shows, as words (docs/design/ADMIN.md §5.8: "every raw enum gets a
 * label"). States with a tone live in `lib/status.ts`; this file holds the plain labels: policy
 * modes, sign-in methods, sources, outlet kinds, channel semantics.
 *
 * `label(table, value)` never returns a raw slug silently: an unknown value is humanised
 * (`in-review` → "In review"), and `null`/`undefined` read "None" (SVC-5, LIC-8, OVR-5).
 */

import { humanize } from "./status.js";

/** Registration policy (`RegistrationPolicy`). */
export const REGISTRATION_LABELS: Record<string, string> = {
  open: "Open",
  "requires-identity": "Identity required",
  "requires-license": "License required",
};

/** Release and delivery access modes (`ReleaseAccess`). */
export const ACCESS_LABELS: Record<string, string> = {
  public: "Public",
  authenticated: "Signed-in devices",
  licensed: "Licensed",
  entitled: "Entitled",
};

/** What each access mode means, for `RadioCards` and `Select` option descriptions. */
export const ACCESS_DESCRIPTIONS: Record<string, string> = {
  public: "Anyone can download, with no device token.",
  authenticated: "Any registered device with a valid token.",
  licensed: "Devices with an active license.",
  entitled: "Devices whose license grants a specific entitlement flag.",
};

/** License and portal sign-in methods. */
export const SIGN_IN_LABELS: Record<string, string> = {
  manual: "Manual",
  oidc: "Single sign-on",
  email: "Email link",
  magic: "Email link",
};

/** Who owns a value (`SettingsSource`, `servicesSource`). */
export const SOURCE_LABELS: Record<string, string> = {
  manifest: "From manifest",
  admin: "Set in console",
  default: "Code default",
  deploy: "Deploy var",
  runtime: "Set in console",
};

/** Where a product comes from. */
export const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  manual: "Manual",
};

/** Config catalog kinds ("kind", never "type", per the glossary). */
export const KIND_LABELS: Record<string, string> = {
  config: "Config",
  secret: "Secret",
  flag: "Flag",
};

/** Catalog management states. */
export const MANAGEMENT_LABELS: Record<string, string> = {
  default: "Default",
  enforced: "Enforced",
  hidden: "Hidden",
};

/** Fingerprint policy modes. */
export const FINGERPRINT_MODE_LABELS: Record<string, string> = {
  off: "Off",
  lenient: "Lenient",
  normal: "Normal",
  strict: "Strict",
};

/** Release channels, with their semantics as descriptions (ChannelPicker). */
export const CHANNEL_LABELS: Record<string, string> = {
  stable: "Stable",
  beta: "Beta",
  pr: "PR builds",
  dev: "Dev",
};

export const CHANNEL_DESCRIPTIONS: Record<string, string> = {
  stable: "General releases",
  beta: "Pre-releases, plus everything on stable",
  pr: "Every PR build",
  dev: "Skips the version window and channel checks",
};

/**
 * Outlet kinds (Distribution). The `direct` kind reads "Polaris Key" (S-21 §6.8): the id stays
 * `direct` on the wire, in the corpus and in every SDK; only the label changes.
 */
export const OUTLET_KIND_LABELS: Record<string, string> = {
  direct: "Polaris Key",
  appstore: "App Store",
  "app-store": "App Store",
  testflight: "TestFlight",
  "google-play": "Google Play",
  play: "Google Play",
  altstore: "AltStore",
  "altstore-pal": "AltStore PAL",
  obtainium: "Obtainium",
  "fdroid-repo": "F-Droid repository",
  flathub: "Flathub",
  scoop: "Scoop",
  steam: "Steam",
  itch: "itch.io",
};

/** How a `direct` install was put on the device (`OUTLET_SUBKINDS`). */
export const OUTLET_SUBKIND_LABELS: Record<string, string> = {
  homebrew: "Homebrew",
  npm: "npm",
  pnpm: "pnpm",
  npx: "npx",
  scoop: "Scoop",
  chocolatey: "Chocolatey",
  flatpak: "Flatpak",
  appimage: "AppImage",
};

/** An outlet kind's label, with its subkind when there is one: "Polaris Key · via Homebrew". */
export function outletLabel(kind: string, subkind?: string | null): string {
  const head = label(OUTLET_KIND_LABELS, kind);
  return subkind
    ? `${head} · via ${label(OUTLET_SUBKIND_LABELS, subkind)}`
    : head;
}

/** Deliverable bindings (packs). */
export const BINDING_LABELS: Record<string, string> = {
  pinned: "Pinned",
  compatible: "Compatible",
};

/** Build platforms. */
export const PLATFORM_LABELS: Record<string, string> = {
  macos: "macOS",
  ios: "iOS",
  ipados: "iPadOS",
  windows: "Windows",
  linux: "Linux",
  android: "Android",
  web: "Web",
};

/** Environments (`/me.environment`). */
export const ENVIRONMENT_LABELS: Record<string, string> = {
  prod: "Production",
  staging: "Staging",
  dev: "Dev",
};

/**
 * The label for a raw value: the table's entry, else the value humanised; `null`, `undefined`
 * and `""` read "None".
 */
export function label(
  table: Record<string, string>,
  value: string | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "None";
  return table[value] ?? humanize(value);
}
