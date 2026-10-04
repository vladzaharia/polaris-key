/**
 * Which brand section a docs page belongs to (docs/design/BRAND.md §3, §5).
 *
 * Pages under `services/<slug>/` take that service's accent through `data-service="<slug>"`;
 * `services/core/` and every other page are the platform (core). The service slugs come from
 * `tools/services.json`, the same table the console and `@polaris-key/brand` key their accents
 * by, so a new service gets its docs accent from its table row and nothing here changes.
 */

import table from "../../../../tools/services.json";

export interface DocsSection {
  /** The `data-service` value: a service slug, or `core` for the platform. */
  slug: string;
  /** The visible section name ("License", "Core"). */
  label: string;
}

const SERVICES: readonly DocsSection[] = (
  table as { services: { slug: string; label: string }[] }
).services.map(({ slug, label }) => ({ slug, label }));

export const CORE: DocsSection = { slug: "core", label: "Core" };

/** The section for a Starlight route id such as `services/license/activation`. */
export function sectionFor(routeId: string): DocsSection {
  const match = /^services\/([^/]+)(?:\/|$)/.exec(routeId);
  if (match === null) return CORE;
  return SERVICES.find((s) => s.slug === match[1]) ?? CORE;
}

/** True when the page is in a service section (not core). */
export function isServiceSection(section: DocsSection): boolean {
  return section.slug !== CORE.slug;
}
