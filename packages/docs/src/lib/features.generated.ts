// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen services` (tools/gen-services.ts) from tools/services.json, the
// one declaration of the opt-in services. `pnpm gen services --check` fails the green
// gate on any difference. To change a service, edit the table and regenerate.

/** The features, in canonical order: the unit the Developers door is organised by. */
export const FEATURE_IDS = [
  "licensing",
  "managed-config",
  "ship-builds",
  "sign-in",
  "cloud-sync",
  "commerce",
  "cloud-connect",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

export interface Feature {
  id: FeatureId;
  /** The visible name. */
  label: string;
  /** The service slugs this feature documents, in canonical order. */
  services: readonly string[];
  /** The service slug whose accent the feature's pages take: its first. */
  accent: string;
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
  commerce: {
    id: "commerce",
    label: "Commerce",
    services: ["commerce"],
    accent: "commerce",
  },
  "cloud-connect": {
    id: "cloud-connect",
    label: "Cloud Connect",
    services: ["connect"],
    accent: "connect",
  },
};

export function isFeatureId(value: string): value is FeatureId {
  return (FEATURE_IDS as readonly string[]).includes(value);
}
