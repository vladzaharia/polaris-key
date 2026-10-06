// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen:services` (tools/gen-services.ts) from tools/services.json, the
// one declaration of the opt-in services. `pnpm gen:services -- --check` fails the green
// gate on any difference. To change a service, edit the table and regenerate.

/** The opt-in services. Core is not a service — it is always on. */
export type ServiceSlug =
  | "license"
  | "config"
  | "release"
  | "distribution"
  | "update"
  | "identity"
  | "sync";

/** Canonical order. Iterate this rather than `Object.keys` so output is stable. */
export const SERVICE_SLUGS: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
];

/**
 * What a product runs when it has never said otherwise, in canonical order. Every other service
 * is opt-in because it needs coordinates (a linked repo, an IdP) a default cannot invent.
 */
export const DEFAULT_ENABLED_SERVICES: readonly ServiceSlug[] = [
  "license",
  "config",
];

/**
 * Coherence edges: a service may only be enabled while every service it lists is. Each edge
 * `<a> → <b>` has a LITERAL `<a>_requires_<b>` error code in the validators (rule 9 reads
 * codes from source), which a test asserts.
 */
export const SERVICE_REQUIRES: Readonly<
  Record<ServiceSlug, readonly ServiceSlug[]>
> = {
  license: [],
  config: [],
  release: [],
  distribution: ["release"],
  update: ["distribution"],
  identity: [],
  sync: ["config", "identity"],
};

/** The legacy `.pkey/product` `modules:` vocabulary (design spec §2.1). */
export type LegacyModule = "licensing" | "edgeMint" | "releases" | "oidc";

/** What a `modules:` block may name: a legacy module name or a service slug. */
export type ProductModule = LegacyModule | ServiceSlug;

/**
 * Every module name a `modules:` block may use, mapped to the service slug(s) it enables:
 * legacy names first (in table order), then each slug mapping to itself.
 */
export const MODULE_SERVICES: Readonly<
  Record<ProductModule, readonly ServiceSlug[]>
> = {
  licensing: ["license"],
  edgeMint: ["config"],
  releases: ["release", "distribution", "update"],
  oidc: ["identity"],
  license: ["license"],
  config: ["config"],
  release: ["release"],
  distribution: ["distribution"],
  update: ["update"],
  identity: ["identity"],
  sync: ["sync"],
};
