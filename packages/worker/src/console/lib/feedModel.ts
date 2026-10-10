/**
 * The package-feed model the Feeds console reads (F-11, plans/F-01.md §6.9): what each ecosystem
 * supports, where its feed answers, and how a settings write is validated. Pure: no database,
 * no environment. The admin handlers (`../handlers/feeds.ts`) and their tests share it.
 *
 * NOTHING HERE IS PER-ECOSYSTEM. Every answer is read from the ecosystem's feed adapter
 * (`services/distribution/registry/<ecosystem>/index.ts`, the `FeedAdapter` contract): its label,
 * its feed path, its capabilities (which the admin API exposes as `capabilities`), the namespace
 * keys its ingest rules declare in `@polaris-key/manifest` and the extension settings it accepts.
 * A new feed changes nothing in this file.
 *
 * Yank semantics follow each protocol (notes/S-12 §8.2), as each adapter declares them. A verb the
 * protocol has no state for is refused with `unsupported_by_ecosystem` rather than recorded as a
 * console-only fiction.
 */

import {
  PACKAGE_ECOSYSTEMS,
  packageNamespaceEmpty,
  type PackageEcosystem,
} from "@polaris-key/manifest";
import {
  feedCapabilityView,
  requireFeedAdapter,
  type FeedCapabilityView,
} from "../../services/distribution/public.js";

/** What one ecosystem's protocol can express, as the admin API exposes it. */
export type FeedCapabilities = FeedCapabilityView;

export { PACKAGE_ECOSYSTEMS, type PackageEcosystem };

function perEcosystem<T>(
  pick: (ecosystem: PackageEcosystem) => T,
): Readonly<Record<PackageEcosystem, T>> {
  return Object.fromEntries(
    PACKAGE_ECOSYSTEMS.map((e) => [e, pick(e)]),
  ) as Record<PackageEcosystem, T>;
}

/** Every ecosystem's capabilities, from its adapter (what the admin API exposes). */
export const FEED_CAPABILITIES: Readonly<
  Record<PackageEcosystem, FeedCapabilities>
> = perEcosystem((e) => feedCapabilityView(requireFeedAdapter(e)));

/**
 * Every ecosystem's extension settings (`ext_json` keys its adapter accepts), which the console's
 * ecosystem panel renders (F-12). `yankHidesFromIndex` is the Yank policy section's, not the
 * panel's, so it is listed in `capabilities.yankPolicy` instead.
 */
export const FEED_EXTENSIONS: Readonly<
  Record<PackageEcosystem, readonly string[]>
> = perEcosystem((e) =>
  Object.keys(requireFeedAdapter(e).settings.ext).filter(
    (k) => k !== "yankHidesFromIndex",
  ),
);

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
  return `${origin}${requireFeedAdapter(ecosystem).feedPath(encodeURIComponent(owner))}`;
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

/** The access modes, in the ladder's order. Every one can be set since registry auth (F-21). */
export const FEED_ACCESS_MODES = [
  "public",
  "authenticated",
  "licensed",
  "entitled",
] as const;
export const SETTABLE_ACCESS_MODES: readonly string[] = FEED_ACCESS_MODES;

const MAX_LIST = 32;
const MAX_ITEM = 128;

/** Is the namespace empty (so the feed cannot be enabled)? OCI's namespace is the owner itself. */
export function namespaceEmpty(
  ecosystem: PackageEcosystem,
  ns: Record<string, unknown>,
): boolean {
  return packageNamespaceEmpty(ecosystem, ns);
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
  const fields = requireFeedAdapter(ecosystem).ingest.namespace.fields;
  if (Object.keys(ns).some((k) => !Object.hasOwn(fields, k))) return null;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const v = ns[key];
    if (field.kind === "string") {
      if (v === undefined || v === "") continue;
      if (typeof v !== "string" || !field.pattern.test(v)) return null;
      out[key] = v;
    } else {
      if (v === undefined) continue;
      const parsed = stringList(v, field.pattern);
      if (parsed === null) return null;
      if (parsed.length) out[key] = parsed;
    }
  }
  return out;
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
  const checks = requireFeedAdapter(ecosystem).settings.ext;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const check = Object.hasOwn(checks, key) ? checks[key] : undefined;
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

/** A label for every ecosystem, for audit summaries (the adapters' labels). */
export const ECOSYSTEM_LABELS: Readonly<Record<PackageEcosystem, string>> =
  perEcosystem((e) => requireFeedAdapter(e).label);
