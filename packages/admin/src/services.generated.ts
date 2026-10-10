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

/** A service section's `data-service` accent token (D-17). The platform section's `core` is
 *  not a service and is added by the nav model, not here. */
export type ServiceAccentToken =
  | "license"
  | "config"
  | "release"
  | "distribution"
  | "update"
  | "identity"
  | "sync";

/** The lucide-react icon each service's row uses. `ServicesCard` maps every name to a
 *  component, so a new icon here is a type error until it is imported there. */
export type ServiceIconName =
  | "KeyRound"
  | "SlidersHorizontal"
  | "Package"
  | "Waypoints"
  | "CircleArrowUp"
  | "UserRound"
  | "Cloud";

export interface ServiceTableRow {
  slug: ServiceSlug;
  label: string;
  /** The Services card text. */
  summary: string;
  accent: ServiceAccentToken;
  icon: ServiceIconName;
  /** The service's docs section. */
  docs: string;
  defaultEnabled: boolean;
  requires: readonly ServiceSlug[];
}

/** The service table, in canonical order. */
export const SERVICE_TABLE: readonly ServiceTableRow[] = [
  {
    slug: "license",
    label: "License",
    summary:
      "Licenses, keys, tiers, device seats, and the signed license document.",
    accent: "license",
    icon: "KeyRound",
    docs: "/docs/services/license/",
    defaultEnabled: true,
    requires: [],
  },
  {
    slug: "config",
    label: "Config",
    summary:
      "The managed config catalog, profiles, overrides, and secret delivery.",
    accent: "config",
    icon: "SlidersHorizontal",
    docs: "/docs/services/config/",
    defaultEnabled: true,
    requires: [],
  },
  {
    slug: "release",
    label: "Release",
    summary:
      "The truth store: repo sync, channels, artifacts, and release health.",
    accent: "release",
    icon: "Package",
    docs: "/docs/services/release/",
    defaultEnabled: false,
    requires: [],
  },
  {
    slug: "distribution",
    label: "Distribution",
    summary:
      "How releases reach devices and outlets — transports, availability, and rollouts.",
    accent: "distribution",
    icon: "Waypoints",
    docs: "/docs/services/distribution/",
    defaultEnabled: false,
    requires: ["release"],
  },
  {
    slug: "update",
    label: "Update",
    summary:
      "The feed over Release’s truth store — appcasts, /version, and eligibility.",
    accent: "update",
    icon: "CircleArrowUp",
    docs: "/docs/services/update/",
    defaultEnabled: false,
    requires: ["distribution"],
  },
  {
    slug: "identity",
    label: "Identity",
    summary:
      "OIDC sign-in and browser sessions for this product. The customer portal is platform-wide and runs either way.",
    accent: "identity",
    icon: "UserRound",
    docs: "/docs/services/identity/",
    defaultEnabled: false,
    requires: [],
  },
  {
    slug: "sync",
    label: "Cloud Sync",
    summary:
      "A signed-in person's settings, collections and saves, synced across devices.",
    accent: "sync",
    icon: "Cloud",
    docs: "/docs/services/sync/",
    defaultEnabled: false,
    requires: ["config", "identity"],
  },
];
