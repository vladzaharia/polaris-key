/**
 * The docs plan's features (README §3.2.1): the unit the Developers door is organised by.
 *
 * `features/<id>/` holds everything about one feature, its console screens included. Each feature
 * keeps its primary service's accent through `section.ts`; a feature that spans several services
 * (Ship builds) names the accent of each sub-area. `services` is the feature's share of the
 * service table: `features.test.ts` checks that every row of `tools/services.json` belongs to
 * exactly one feature, so a new service cannot ship without a docs home. ST-38 replaces this map
 * with `console.group`; the docs never wait on it.
 */

export const FEATURE_IDS = [
  "licensing",
  "managed-config",
  "ship-builds",
  "sign-in",
  "cloud-sync",
  "commerce",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

export interface Feature {
  id: FeatureId;
  /** The visible name (the owner-approved feature name). */
  label: string;
  /** Rows of `tools/services.json` this feature documents. */
  services: readonly string[];
  /** The service slug whose accent the feature's pages take. */
  accent: string;
  /** Sub-area directory -> the service slug whose accent it takes, where it differs. */
  areas?: Readonly<Record<string, string>>;
}

export const FEATURES: Readonly<Record<FeatureId, Feature>> = {
  licensing: {
    id: "licensing",
    label: "Licensing",
    services: ["license"],
    accent: "license",
  },
  "managed-config": {
    id: "managed-config",
    label: "Managed config",
    services: ["config"],
    accent: "config",
  },
  "ship-builds": {
    id: "ship-builds",
    label: "Ship builds",
    services: ["release", "distribution", "update"],
    accent: "release",
    areas: {
      releases: "release",
      channels: "distribution",
      updates: "update",
      packages: "distribution",
      packs: "release",
      commerce: "distribution",
    },
  },
  "sign-in": {
    id: "sign-in",
    label: "Sign-in",
    services: ["identity"],
    accent: "identity",
  },
  "cloud-sync": {
    id: "cloud-sync",
    label: "Cloud Sync",
    services: ["sync"],
    accent: "sync",
  },
  // No page yet: Commerce moves out of Ship builds in its own package. The directory is
  // reserved, and a feature with no pages is left out of the sidebar.
  commerce: {
    id: "commerce",
    label: "Commerce",
    services: [],
    accent: "distribution",
  },
};

export function isFeatureId(value: string): value is FeatureId {
  return (FEATURE_IDS as readonly string[]).includes(value);
}
