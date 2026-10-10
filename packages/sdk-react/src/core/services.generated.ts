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
