/**
 * Every raw enum the console shows, as words (docs/design/ADMIN.md §5.8: "every raw enum gets a
 * label"). States with a tone live in `lib/status.ts`; this file holds the plain labels: policy
 * modes, sign-in methods, sources, outlet kinds, channel semantics.
 *
 * `label(table, value)` never returns a raw slug silently: an unknown value is humanised
 * (`in-review` → "In review"), and `null`/`undefined` read "None" (SVC-5, LIC-8, OVR-5).
 */

import { findChannel } from "@polaris-key/manifest";
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
  authenticated: "Authenticated",
  licensed: "Licensed",
  entitled: "Entitled",
};

/** What each access mode means, for `RadioCards` and `Select` option descriptions. */
export const ACCESS_DESCRIPTIONS: Record<string, string> = {
  public: "Anyone, with no device token.",
  authenticated: "A device with a valid token and a usable license.",
  licensed: "A device whose license is usable.",
  entitled:
    "A device whose own license covers the requested channel and version.",
};

/** The same, for a pack: its `entitled` is the pack's gate flag, not the channel and version. */
export const PACK_ACCESS_DESCRIPTIONS: Record<string, string> = {
  ...ACCESS_DESCRIPTIONS,
  entitled: "A device whose license holds the pack's gate flag.",
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
 * An outlet kind's name, from the channel catalogue (A-19b): `direct` reads "Polaris Locker"
 * (S-21 §6.8), the id staying `direct` on the wire. An id the catalogue lacks is humanised.
 */
export function outletKindName(kind: string | null | undefined): string {
  if (kind === null || kind === undefined || kind === "") return "None";
  return findChannel(kind)?.label ?? humanize(kind);
}

/** How a `direct` install was put on the device (`OUTLET_SUBKINDS`); a package manager is a catalogue channel. */
const OUTLET_SUBKIND_LABELS: Record<string, string> = {
  npm: "npm",
  pnpm: "pnpm",
  npx: "npx",
  chocolatey: "Chocolatey",
  flatpak: "Flatpak",
  appimage: "AppImage",
};

/** A subkind's name: the catalogue's for a package manager (Homebrew, Scoop), else the local table. */
export function outletSubkindLabel(subkind: string): string {
  return findChannel(subkind)?.label ?? label(OUTLET_SUBKIND_LABELS, subkind);
}

/** An outlet kind's label, with its subkind when there is one: "Polaris Locker · via Homebrew". */
export function outletLabel(kind: string, subkind?: string | null): string {
  const head = outletKindName(kind);
  return subkind ? `${head} · via ${outletSubkindLabel(subkind)}` : head;
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
