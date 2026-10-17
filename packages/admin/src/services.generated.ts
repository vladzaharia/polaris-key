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
  | "commerce";

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
  | "sync"
  | "commerce";

/** The lucide-react icon each service's row uses. `ServicesCard` maps every name to a
 *  component, so a new icon here is a type error until it is imported there. */
export type ServiceIconName =
  | "KeyRound"
  | "SlidersHorizontal"
  | "Package"
  | "Waypoints"
  | "CircleArrowUp"
  | "UserRound"
  | "Cloud"
  | "ShoppingBag";

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
  /** The feature the console shows it under. */
  group: FeatureId;
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
    group: "licensing",
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
    group: "managed-config",
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
    group: "ship-builds",
  },
  {
    slug: "distribution",
    label: "Distribution",
    summary:
      "How releases reach devices and channels — transports, availability, and rollouts.",
    accent: "distribution",
    icon: "Waypoints",
    docs: "/docs/services/distribution/",
    defaultEnabled: false,
    requires: ["release"],
    group: "ship-builds",
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
    group: "ship-builds",
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
    group: "sign-in",
  },
  {
    slug: "sync",
    label: "Cloud Sync",
    summary:
      "A signed-in person's settings, saves and other records, synced across devices.",
    accent: "sync",
    icon: "Cloud",
    docs: "/docs/services/sync/",
    defaultEnabled: false,
    requires: ["config", "identity"],
    group: "cloud-sync",
  },
  {
    slug: "commerce",
    label: "Commerce",
    summary:
      "Storefronts, offers and store purchases that grant licences and add-ons.",
    accent: "commerce",
    icon: "ShoppingBag",
    docs: "/docs/services/commerce/",
    defaultEnabled: false,
    requires: ["license"],
    group: "commerce",
  },
];

/** The console's features (ST-38): the grouping of slugs an operator turns on. */
export type FeatureId =
  | "licensing"
  | "managed-config"
  | "ship-builds"
  | "sign-in"
  | "cloud-sync"
  | "commerce";

/** Every switch or fact a feature's row holds below its own switch. The console renders each
 *  `setting` and `fact` id itself, so a new one is a type error until it does. */
export type FeatureSwitchId =
  | "minted-tokens"
  | "in-app-updates"
  | "packages"
  | "customer-portal";

export interface FeatureSwitchRow {
  id: FeatureSwitchId;
  label: string;
  /** `service`: a slug of the feature, on by default with it; `setting`: an operator setting;
   *  `fact`: a read-only status. */
  kind: "service" | "setting" | "fact";
  /** The slug a `service` switch controls; `null` otherwise. */
  service: ServiceSlug | null;
}

export interface FeatureRow {
  id: FeatureId;
  label: string;
  /** The first slug's accent and icon. */
  accent: ServiceAccentToken;
  icon: ServiceIconName;
  /** Every slug of the feature, in canonical order. */
  services: readonly ServiceSlug[];
  /** What the feature's own switch writes: its slugs, less those a `service` switch controls. */
  primary: readonly ServiceSlug[];
  switches: readonly FeatureSwitchRow[];
}

/** The features, in canonical order. */
export const FEATURES: readonly FeatureRow[] = [
  {
    id: "licensing",
    label: "Licensing",
    accent: "license",
    icon: "KeyRound",
    services: ["license"],
    primary: ["license"],
    switches: [],
  },
  {
    id: "managed-config",
    label: "Managed config",
    accent: "config",
    icon: "SlidersHorizontal",
    services: ["config"],
    primary: ["config"],
    switches: [
      {
        id: "minted-tokens",
        label: "Minted tokens",
        kind: "fact",
        service: null,
      },
    ],
  },
  {
    id: "ship-builds",
    label: "Ship builds",
    accent: "release",
    icon: "Package",
    services: ["release", "distribution", "update"],
    primary: ["release", "distribution"],
    switches: [
      {
        id: "in-app-updates",
        label: "In-app updates",
        kind: "service",
        service: "update",
      },
      { id: "packages", label: "Packages", kind: "setting", service: null },
    ],
  },
  {
    id: "sign-in",
    label: "Sign-in",
    accent: "identity",
    icon: "UserRound",
    services: ["identity"],
    primary: ["identity"],
    switches: [
      {
        id: "customer-portal",
        label: "Customer portal",
        kind: "setting",
        service: null,
      },
    ],
  },
  {
    id: "cloud-sync",
    label: "Cloud Sync",
    accent: "sync",
    icon: "Cloud",
    services: ["sync"],
    primary: ["sync"],
    switches: [],
  },
  {
    id: "commerce",
    label: "Commerce",
    accent: "commerce",
    icon: "ShoppingBag",
    services: ["commerce"],
    primary: ["commerce"],
    switches: [],
  },
];
