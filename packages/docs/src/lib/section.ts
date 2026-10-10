/**
 * Which brand section a docs page belongs to (docs/design/BRAND.md §3, §5).
 *
 * Pages under `features/<feature>/` take the feature's accent through `data-service="<slug>"`
 * (Ship builds names one accent per sub-area; see `features.ts`). Every other page is the
 * platform (core). The service slugs come from `tools/services.json`, the same table the console
 * and `@polaris-key/brand` key their accents by.
 */

import { FEATURES, isFeatureId } from "./features";

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
  const area = match[2] === undefined ? undefined : feature.areas?.[match[2]];
  return { slug: area ?? feature.accent, label: feature.label };
}

/** True when the page is in a feature section (not core). */
export function isServiceSection(section: DocsSection): boolean {
  return section.slug !== CORE.slug;
}
