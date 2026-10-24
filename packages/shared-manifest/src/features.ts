/**
 * The features' rules (ST-46.1), moved here from the console's New product wizard so `pkey init`
 * asks the same question with the same rules: which features need which, what turning one off
 * clears, and the services a set of features turns on. Pure; the tables are generated.
 */

import {
  FEATURES,
  SERVICE_REQUIRES,
  SERVICE_SLUGS,
  type FeatureId,
  type ServiceSlug,
} from "./services.generated.js";

/** The features a feature needs on first: the owners of the services its own services require. */
export function featureNeeds(id: FeatureId): FeatureId[] {
  const f = FEATURES.find((x) => x.id === id)!;
  const out = new Set<FeatureId>();
  for (const s of f.primary)
    for (const req of SERVICE_REQUIRES[s]) {
      const owner = FEATURES.find((x) => x.primary.includes(req));
      if (owner && owner.id !== id) out.add(owner.id);
    }
  return FEATURES.filter((x) => out.has(x.id)).map((x) => x.id);
}

/** A feature can be chosen once everything it needs is chosen. */
export const featureUnlocked = (
  id: FeatureId,
  chosen: readonly FeatureId[],
): boolean => featureNeeds(id).every((n) => chosen.includes(n));

/**
 * Turn a feature on or off. Turning one off turns off whatever needs it, and says which
 * ("clearing Licensing also clears Commerce").
 */
export function toggleFeature(
  chosen: readonly FeatureId[],
  id: FeatureId,
  on: boolean,
): { features: FeatureId[]; cleared: FeatureId[] } {
  if (on)
    return {
      features: featureUnlocked(id, chosen)
        ? [...new Set([...chosen, id])]
        : [...chosen],
      cleared: [],
    };
  let next = chosen.filter((f) => f !== id);
  const cleared: FeatureId[] = [];
  for (;;) {
    const drop = next.filter((f) => !featureUnlocked(f, next));
    if (drop.length === 0) break;
    cleared.push(...drop);
    next = next.filter((f) => !drop.includes(f));
  }
  return { features: next, cleared };
}

/** The services a set of features turns on (each feature's own), in canonical order. */
export function servicesForFeatures(features: readonly FeatureId[]): {
  services: ServiceSlug[];
} {
  const own = new Set<ServiceSlug>();
  for (const f of FEATURES)
    if (features.includes(f.id)) for (const s of f.primary) own.add(s);
  return { services: SERVICE_SLUGS.filter((s) => own.has(s)) };
}
