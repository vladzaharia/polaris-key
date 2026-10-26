// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen services` (tools/gen-services.ts) from tools/services.json, the
// one declaration of the opt-in services. `pnpm gen services --check` fails the green
// gate on any difference. To change a service, edit the table and regenerate.

/** The opt-in services. Core is not a service — it is always on. */
export type ServiceSlug =
  | "license"
  | "config"
  | "release"
  | "distribution"
  | "update"
  | "identity"
  | "sync"
  | "commerce"
  | "connect";

/** Canonical order. Iterate this rather than `Object.keys` so output is stable. */
export const SERVICE_SLUGS: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
  "commerce",
  "connect",
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
  commerce: ["license"],
  connect: ["identity"],
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
  commerce: ["commerce"],
  connect: ["connect"],
};

/** The console's features: the grouping of slugs an operator turns on (the wizard's "What is it for?"). */
export type FeatureId =
  | "licensing"
  | "managed-config"
  | "ship-builds"
  | "sign-in"
  | "cloud-sync"
  | "commerce"
  | "cloud-connect";

export interface FeatureRow {
  id: FeatureId;
  label: string;
  /** What the feature's own switch writes: its slugs, less those a `service` switch controls. */
  primary: readonly ServiceSlug[];
}

/** The features, in canonical order. */
export const FEATURES: readonly FeatureRow[] = [
  { id: "licensing", label: "Licensing", primary: ["license"] },
  { id: "managed-config", label: "Managed config", primary: ["config"] },
  {
    id: "ship-builds",
    label: "Ship builds",
    primary: ["release", "distribution"],
  },
  { id: "sign-in", label: "Sign-in", primary: ["identity"] },
  { id: "cloud-sync", label: "Cloud Sync", primary: ["sync"] },
  { id: "commerce", label: "Commerce", primary: ["commerce"] },
  { id: "cloud-connect", label: "Cloud Connect", primary: ["connect"] },
];
