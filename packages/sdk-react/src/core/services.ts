// The service capability model — wire contract v3 §2 / design spec §4.3, D-21.
//
// A MIRROR of `@polaris-key/node`'s `src/discovery.ts` capability half, field for field. It is
// duplicated rather than imported because `@polaris-key/node` is a Node-only package (keyring, fs,
// `node:crypto`) and this one has to survive a browser bundler. The shapes are pinned against
// the Node originals by `test/capabilities.test.ts`, so the two cannot drift silently.
//
// ── FAIL-CLOSED (D-21) ──────────────────────────────────────────────────────────────────────
//
// Three states, one rule. When discovery SUCCEEDS its `services` map is the authority and a
// slug it omits reads as DISABLED — "not advertised" must mean "do not try". When discovery
// FAILS (offline, 404, malformed) the client falls back to what the host said it expected
// (`expectServices`), and when the host said nothing, to `DEFAULT_SERVICES` — licensing plus
// settings distribution, which is what every product ran before the suite existed. What it
// never does is assume all-true: a UI that offers a sign-in button for an identity service the
// product does not run is a dead end presented as an affordance.

import {
  DEFAULT_ENABLED_SERVICES,
  SERVICE_SLUGS,
  type ServiceSlug,
} from "./services.generated.js";
import type { PolarisError } from "./types.js";

/**
 * The opt-in services and their canonical order are GENERATED from the service table
 * (`tools/services.json`, via `pnpm gen:services`) into `./services.generated.ts`. Core is not a
 * service — it is always on. Iterate `SERVICE_SLUGS` rather than `Object.keys` so output is
 * stable.
 */
export { SERVICE_SLUGS, type ServiceSlug };

/** Per-service state as the SDK consumes it. The slice on `PolarisState.capabilities`. */
export type ServicesMap = Record<ServiceSlug, { enabled: boolean }>;

/** A record with every slug in canonical order, each value from `value`. */
function perService<T>(
  value: (slug: ServiceSlug) => T,
): Record<ServiceSlug, T> {
  const out = {} as Record<ServiceSlug, T>;
  for (const slug of SERVICE_SLUGS) out[slug] = value(slug);
  return out;
}

/** Every service off — the seed a parse builds up from, and the honest answer for a client
 *  that has been told a product runs nothing. */
export function noServices(): ServicesMap {
  return perService(() => ({ enabled: false }));
}

/**
 * What a client believes when it has neither a discovery document nor a stated expectation:
 * licensing + settings delivery (the table's `defaultEnabled` rows). Release, Distribution,
 * Update and Identity are OFF, so their hooks/components refuse until something says otherwise.
 */
export function defaultServices(): ServicesMap {
  return perService((slug) => ({
    enabled: DEFAULT_ENABLED_SERVICES.includes(slug),
  }));
}

/** A deep copy, so a caller holding a capability map cannot mutate the adapter's own state. */
export function copyServices(services: ServicesMap): ServicesMap {
  return perService((slug) => ({ enabled: services[slug]?.enabled === true }));
}

/** Turn a host's `expectServices` list into a full map — everything unlisted is off. */
export function servicesFromList(slugs: readonly ServiceSlug[]): ServicesMap {
  const out = noServices();
  for (const slug of slugs) {
    if (slug in out) out[slug] = { enabled: true };
  }
  return out;
}

/** True when the two maps agree slug-for-slug (used to skip pointless re-renders). */
export function servicesEqual(a: ServicesMap, b: ServicesMap): boolean {
  return SERVICE_SLUGS.every((slug) => a[slug].enabled === b[slug].enabled);
}

// ── Per-service busy / error maps ────────────────────────────────────────────────────────
//
// The pre-suite state carried ONE `busy` boolean and ONE `error`, so a config refresh greyed
// out the sign-out button and an identity failure looked like a license failure. Both become
// maps keyed by the service that actually owns the operation.

export type ServiceBusyMap = Record<ServiceSlug, boolean>;
export type ServiceErrorMap = Record<ServiceSlug, PolarisError | null>;

export function noBusy(): ServiceBusyMap {
  return perService(() => false);
}

export function noErrors(): ServiceErrorMap {
  return perService(() => null);
}

/** A new busy map with one slug flipped. Returns the SAME reference when nothing changes, so
 *  `useSyncExternalStore` does not re-render on a no-op. */
export function withBusy(
  map: ServiceBusyMap,
  slug: ServiceSlug,
  busy: boolean,
): ServiceBusyMap {
  if (map[slug] === busy) return map;
  return { ...map, [slug]: busy };
}

/** A new error map with one slug replaced. */
export function withError(
  map: ServiceErrorMap,
  slug: ServiceSlug,
  error: PolarisError | null,
): ServiceErrorMap {
  if (map[slug] === error) return map;
  return { ...map, [slug]: error };
}

/** True when ANY service has an operation in flight — the aggregate the legacy scalar was. */
export function anyBusy(map: ServiceBusyMap): boolean {
  return SERVICE_SLUGS.some((slug) => map[slug]);
}

/** The first error in canonical slug order, or null. The aggregate the legacy scalar was. */
export function firstError(map: ServiceErrorMap): PolarisError | null {
  for (const slug of SERVICE_SLUGS) {
    const err = map[slug];
    if (err) return err;
  }
  return null;
}
