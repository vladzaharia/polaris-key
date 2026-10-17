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

/** Where a product comes from. */
export const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  manual: "Manual",
};

/**
 * The catalog's types in the console's one vocabulary (U-30): a Setting, a Secret or a Minted
 * token. The wire keeps `kind` and `delivery` (a minted token is `kind: "secret"` with
 * `delivery: "edgeMint"`); only the words change.
 */
export const KIND_LABELS: Record<string, string> = {
  config: "Setting",
  secret: "Secret",
  flag: "Flag",
};

/** An entry's type label: a secret delivered as `edgeMint` is a Minted token. */
export function typeLabel(entry: { kind: string; delivery?: string }): string {
  if (entry.kind === "secret" && entry.delivery === "edgeMint")
    return "Minted token";
  return KIND_LABELS[entry.kind] ?? entry.kind;
}

/**
 * A setting's in-app visibility over the stored `managementDefault` (default, enforced, hidden):
 * Editable people can change it, Read-only they see but cannot, Hidden they never see.
 */
export const IN_APP_LABELS: Record<string, string> = {
  default: "Editable",
  enforced: "Read-only",
  hidden: "Hidden",
};

/** Catalog management states, in the In the app words. */
export const MANAGEMENT_LABELS: Record<string, string> = IN_APP_LABELS;

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

/** The facet value of an entry's In the app cell: a setting's visibility, else `code`. */
export function inAppState(entry: {
  kind: string;
  managementDefault?: string;
}): "default" | "enforced" | "hidden" | "code" {
  if (entry.kind !== "config") return "code";
  const m = entry.managementDefault;
  return m === "enforced" || m === "hidden" ? m : "default";
}

/** The In the app cell: a setting's visibility, or "Code only" for a secret and a minted token. */
export function inAppLabel(entry: {
  kind: string;
  managementDefault?: string;
}): string {
  const state = inAppState(entry);
  return state === "code" ? "Code only" : IN_APP_LABELS[state]!;
}
