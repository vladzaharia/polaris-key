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
  | "identity";

/** Canonical order. Iterate this rather than `Object.keys` so output is stable. */
export const SERVICE_SLUGS: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
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
};

/** A service section's `data-service` accent token (D-17). The platform section's `core` is
 *  not a service and is added by the nav model, not here. */
export type ServiceAccentToken =
  | "license"
  | "config"
  | "release"
  | "distribution"
  | "update"
  | "identity";

/** The lucide-react icon each service's row uses. `ServicesCard` maps every name to a
 *  component, so a new icon here is a type error until it is imported there. */
export type ServiceIconName =
  | "KeyRound"
  | "Settings2"
  | "Package"
  | "Truck"
  | "RefreshCw"
  | "UserRound";

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
    icon: "Settings2",
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
    icon: "Truck",
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
    icon: "RefreshCw",
    docs: "/docs/services/update/",
    defaultEnabled: false,
    requires: ["distribution"],
  },
  {
    slug: "identity",
    label: "Identity",
    summary:
      "OIDC sign-in, browser sessions, and the customer portal for this product.",
    accent: "identity",
    icon: "UserRound",
    docs: "/docs/services/identity/",
    defaultEnabled: false,
    requires: [],
  },
];
