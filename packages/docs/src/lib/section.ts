/**
 * Which brand section a docs page belongs to (docs/design/BRAND.md §3, §5).
 *
 * Pages under `features/<feature>/` take the feature's accent through `data-service="<slug>"`
 * (Ship builds names one accent per sub-area, `AREAS` below). Every other page is the platform
 * (core). The features and their slugs come from `tools/services.json`'s `console.group`
 * (`features.generated.ts`, ST-38), the same table the console and `@polaris-key/brand` key their
 * accents by.
 */

import { FEATURES, isFeatureId, type FeatureId } from "./features.generated";

/**
 * A feature's sub-area directory -> the service slug whose accent it takes, where it differs from
 * the feature's own. Docs layout, not the service table: Ship builds spans three services.
 */
export const AREAS: Partial<
  Record<FeatureId, Readonly<Record<string, string>>>
> = {
  "ship-builds": {
    releases: "release",
    channels: "distribution",
    updates: "update",
    packages: "distribution",
    packs: "release",
    commerce: "distribution",
  },
};

export interface DocsSection {
  /** The `data-service` value: a service slug, or `core` for the platform. */
  slug: string;
  /** The visible section name ("Licensing", "Core"). */
  label: string;
}

export const CORE: DocsSection = { slug: "core", label: "Core" };

/** The section for a Starlight route id such as `features/licensing/model`. */
export function sectionFor(routeId: string): DocsSection {
  const match = /^features\/([^/]+)(?:\/([^/]+))?/.exec(routeId);
  if (match === null || !isFeatureId(match[1]!)) return CORE;
  const feature = FEATURES[match[1]!];
  const area =
    match[2] === undefined ? undefined : AREAS[feature.id]?.[match[2]];
  return { slug: area ?? feature.accent, label: feature.label };
}

/** True when the page is in a feature section (not core). */
export function isServiceSection(section: DocsSection): boolean {
  return section.slug !== CORE.slug;
}
