/**
 * The package-feed model the Feeds console reads (F-11, plans/F-01.md §6.9): what each ecosystem
 * supports, where its feed answers, and how a settings write is validated. Pure: no database,
 * no environment. The admin handlers (`../handlers/feeds.ts`) and their tests share it.
 *
 * Yank semantics follow each protocol (notes/S-12 §8.2). A verb the protocol has no state for is
 * refused with `unsupported_by_ecosystem` rather than recorded as a console-only fiction:
 *
 *   npm    no yank that keeps lockfiles working; deprecate (npm's `deprecated` message) instead
 *   PyPI   PEP 592 yank: pinned installs still work, resolvers skip the version
 *   Swift  the version leaves the release list and stays fetchable
 *   Maven  no protocol notion; with `yankHidesFromIndex` the version leaves maven-metadata.xml
 *   OCI    the version tag is removed and the digest stays pullable
 *   Godot  the version leaves the asset listings
 */

import {
  PACKAGE_ECOSYSTEMS,
  type PackageEcosystem,
} from "@polaris-key/manifest";

export { PACKAGE_ECOSYSTEMS, type PackageEcosystem };

/** What one ecosystem's protocol can express about a version's state. */
export interface FeedCapabilities {
  /** A yank (and so an unyank) exists in the protocol. */
  yank: boolean;
  /** A deprecation message (and so an undeprecate) exists in the protocol. */
  deprecate: boolean;
  /** The feed's `yankHidesFromIndex` setting applies (the protocol has a list to leave). */
  yankPolicy: boolean;
}

export const FEED_CAPABILITIES: Readonly<
  Record<PackageEcosystem, FeedCapabilities>
> = {
  npm: { yank: false, deprecate: true, yankPolicy: false },
  pypi: { yank: true, deprecate: false, yankPolicy: false },
  swift: { yank: true, deprecate: false, yankPolicy: false },
  maven: { yank: true, deprecate: false, yankPolicy: true },
  oci: { yank: true, deprecate: false, yankPolicy: false },
  godot: { yank: true, deprecate: false, yankPolicy: false },
};

/** The version verbs the Feeds console offers. */
export const VERSION_VERBS = [
  "yank",
  "unyank",
  "deprecate",
  "undeprecate",
] as const;
export type VersionVerb = (typeof VERSION_VERBS)[number];

export function isVersionVerb(v: string): v is VersionVerb {
  return (VERSION_VERBS as readonly string[]).includes(v);
}

/** Does `ecosystem`'s protocol have a state for `verb`? */
export function verbSupported(
  ecosystem: PackageEcosystem,
  verb: VersionVerb,
): boolean {
  const caps = FEED_CAPABILITIES[ecosystem];
  return verb === "yank" || verb === "unyank" ? caps.yank : caps.deprecate;
}

/**
 * The feed's base URL on the registry host, for `owner` (the product slug). OCI's root is the
 * protocol's `/v2/`, with the repository under the owner.
 */
export function feedBaseUrl(
  origin: string | null,
  ecosystem: PackageEcosystem,
  owner: string,
): string | null {
  if (origin === null) return null;
  const o = encodeURIComponent(owner);
  switch (ecosystem) {
    case "pypi":
      return `${origin}/pypi/${o}/simple/`;
    case "oci":
      return `${origin}/v2/${o}/`;
    default:
      return `${origin}/${ecosystem}/${o}/`;
  }
}

/** A feed's settings as the console reads and writes them (`dist_registry_feeds`). */
export interface FeedSettingsView {
  enabled: boolean;
  accessMode: string;
  namespace: Record<string, unknown>;
  maxPackageBytes: number;
  upstream: "none";
  ext: Record<string, unknown>;
  /** 0 = no row yet: the first save creates it. */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** The access modes, in the ladder's order. Only `public` can be set until registry auth (F-21). */
export const FEED_ACCESS_MODES = [
  "public",
  "authenticated",
  "licensed",
  "entitled",
] as const;
export const SETTABLE_ACCESS_MODES: readonly string[] = ["public"];

const NPM_SCOPE = /^@[a-z0-9][a-z0-9._~-]{0,213}$/;
const SWIFT_SCOPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const MAVEN_GROUP = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const PYPI_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GODOT_PUBLISHER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_LIST = 32;
const MAX_ITEM = 128;

/** Is the namespace empty (so the feed cannot be enabled)? OCI's namespace is the owner itself. */
export function namespaceEmpty(
  ecosystem: PackageEcosystem,
  ns: Record<string, unknown>,
): boolean {
  switch (ecosystem) {
    case "npm":
    case "swift":
      return typeof ns.scope !== "string" || ns.scope === "";
    case "maven":
      return !Array.isArray(ns.groupPrefixes) || ns.groupPrefixes.length === 0;
    case "pypi":
      return (
        (!Array.isArray(ns.prefixes) || ns.prefixes.length === 0) &&
        (!Array.isArray(ns.names) || ns.names.length === 0)
      );
    case "godot":
      return typeof ns.publisher !== "string" || ns.publisher === "";
    case "oci":
      return false;
  }
}

function stringList(v: unknown, pattern: RegExp): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_LIST) return null;
  const out: string[] = [];
  for (const item of v) {
    if (
      typeof item !== "string" ||
      item.length > MAX_ITEM ||
      !pattern.test(item)
    )
      return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Validate one ecosystem's namespace. Answers the normalised object (empty strings and lists
 * dropped), or `null` when a value is malformed. Unknown keys are refused, so a typo is not
 * stored as a rule that enforces nothing.
 */
export function parseNamespace(
  ecosystem: PackageEcosystem,
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ns = raw as Record<string, unknown>;
  const allowed: Record<PackageEcosystem, readonly string[]> = {
    npm: ["scope"],
    swift: ["scope"],
    maven: ["groupPrefixes"],
    pypi: ["prefixes", "names"],
    godot: ["publisher"],
    oci: [],
  };
  if (Object.keys(ns).some((k) => !allowed[ecosystem].includes(k))) return null;
  const out: Record<string, unknown> = {};
  const scalar = (key: string, pattern: RegExp): boolean => {
    const v = ns[key];
    if (v === undefined || v === "") return true;
    if (typeof v !== "string" || !pattern.test(v)) return false;
    out[key] = v;
    return true;
  };
  const list = (key: string, pattern: RegExp): boolean => {
    const v = ns[key];
    if (v === undefined) return true;
    const parsed = stringList(v, pattern);
    if (parsed === null) return false;
    if (parsed.length) out[key] = parsed;
    return true;
  };
  switch (ecosystem) {
    case "npm":
      return scalar("scope", NPM_SCOPE) ? out : null;
    case "swift":
      return scalar("scope", SWIFT_SCOPE) ? out : null;
    case "godot":
      return scalar("publisher", GODOT_PUBLISHER) ? out : null;
    case "maven":
      return list("groupPrefixes", MAVEN_GROUP) ? out : null;
    case "pypi":
      return list("prefixes", PYPI_NAME) && list("names", PYPI_NAME)
        ? out
        : null;
    case "oci":
      return out;
  }
}

/**
 * Validate a patch of the per-ecosystem extensions (`ext_json`). Each key is checked against the
 * ecosystem's own; `null` deletes a key. Answers the patch, or the offending key.
 */
export function parseExtPatch(
  ecosystem: PackageEcosystem,
  raw: unknown,
): { ok: true; patch: Record<string, unknown> } | { ok: false; key: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, key: "ext" };
  const checks: Record<string, (v: unknown) => boolean> = {};
  const bool = (v: unknown) => typeof v === "boolean";
  if (FEED_CAPABILITIES[ecosystem].yankPolicy) checks.yankHidesFromIndex = bool;
  if (ecosystem === "pypi") checks.htmlFallback = bool;
  if (ecosystem === "swift") checks.requireSigned = bool;
  if (ecosystem === "oci")
    checks.retainUntaggedDays = (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3650;
  if (ecosystem === "godot") {
    checks.categoryId = (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;
    checks.supportLevel = (v) =>
      typeof v === "string" && /^[a-z][a-z-]{0,31}$/.test(v);
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const check = checks[key];
    if (!check) return { ok: false, key };
    if (value !== null && !check(value)) return { ok: false, key };
    patch[key] = value;
  }
  return { ok: true, patch };
}

/** Apply an ext patch: `null` removes a key. */
export function applyExtPatch(
  ext: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...ext };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** A label for every ecosystem, for audit summaries. */
export const ECOSYSTEM_LABELS: Readonly<Record<PackageEcosystem, string>> = {
  npm: "npm",
  pypi: "PyPI",
  swift: "Swift",
  maven: "Maven",
  oci: "OCI",
  godot: "Godot",
};
