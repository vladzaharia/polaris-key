/**
 * Per-product service enablement — the single authority (design spec §2.2).
 *
 * Polaris is a suite of opt-in services (License, Config, Release, Update, Identity) over an
 * always-on Core substrate. `products.services_json` records which of them a product runs, and
 * every consumer — route mounting, the discovery document, the admin setup view, portal
 * capabilities — becomes a projection of THIS, instead of each re-inferring enablement from
 * the presence of some child row.
 *
 * `products.services_source` says who owns that column: `manifest` (a resync may rewrite it)
 * or `admin` (an operator claimed it live). Same machinery as the fingerprint and auto-issue
 * policies; see `setServices` in `../repo.ts`.
 */

/** The five opt-in services. Core is not a service — it is always on. */
export type ServiceSlug =
  | "license"
  | "config"
  | "release"
  | "update"
  | "identity";

/** Canonical order. Iterate this rather than `Object.keys` so output is stable. */
export const SERVICE_SLUGS: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "update",
  "identity",
];

/** Per-service state. Only `enabled` today; the object shape leaves room for per-service
 *  settings without a second column. */
export type ServicesMap = Record<ServiceSlug, { enabled: boolean }>;

/** Who owns `services_json`. `manifest` => resync reapplies; `admin` => operator-claimed. */
export type ServicesSource = "manifest" | "admin";

/**
 * What a product runs when it has never said otherwise: licensing + settings distribution,
 * which is exactly what every product does today. Distribution (release/update) and identity
 * are opt-in because they need coordinates (a linked repo, an IdP) a default cannot invent.
 */
export const DEFAULT_SERVICES: ServicesMap = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

/** A fresh copy of the defaults — the exported constant is never handed out to callers who
 *  might mutate it. */
function defaults(): ServicesMap {
  return {
    license: { ...DEFAULT_SERVICES.license },
    config: { ...DEFAULT_SERVICES.config },
    release: { ...DEFAULT_SERVICES.release },
    update: { ...DEFAULT_SERVICES.update },
    identity: { ...DEFAULT_SERVICES.identity },
  };
}

function isServiceSlug(value: string): value is ServiceSlug {
  return (SERVICE_SLUGS as readonly string[]).includes(value);
}

/**
 * Read `products.services_json`.
 *
 * STRICT, AND FAIL-SAFE — the two are not in tension here. The column is a TEXT blob read on
 * every product-scoped request; its content can be a stale row, a hand-edit in the D1 console,
 * or the output of a future writer this build has never seen. So:
 *
 *   - Anything structurally wrong — not JSON, not an object, an array, an unrecognised slug,
 *     a non-object entry, an `enabled` that isn't a boolean — discards the WHOLE record and
 *     returns the defaults. Not a partial merge: a record we cannot fully understand cannot be
 *     trusted to be describing what we think it describes, and half-honouring it would turn a
 *     typo into a silently-disabled service.
 *   - A well-formed record that simply omits a slug gets that slug's default. Undeclared means
 *     "not stated", which is the same thing the manifest means by it.
 *   - It never throws. Hostile DB content must not be able to 500 a request.
 *
 * Falling back to the DEFAULTS (rather than to all-disabled) is deliberate: this parser sits
 * in front of the routes every existing product already serves, so the safe direction is
 * "behave exactly as this product behaved before the column existed".
 */
export function parseServices(json: string | null | undefined): ServicesMap {
  if (!json) return defaults();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return defaults();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults();

  const out = defaults();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isServiceSlug(key)) return defaults();
    if (!value || typeof value !== "object" || Array.isArray(value))
      return defaults();
    const enabled = (value as Record<string, unknown>).enabled;
    if (typeof enabled !== "boolean") return defaults();
    out[key] = { enabled };
  }
  return out;
}

/**
 * Coherence rules over an enablement set. Returns stable error CODES (not prose) so the admin
 * API, the manifest validator, and the console can all render them their own way; an empty
 * array means the set is applicable.
 *
 * Only the rules expressible from the set alone live here. The registration-policy rules from
 * spec §2.2 (`requires-identity` needs identity; `config` without `license` bounds the
 * registration policy) need the product's `devices.registration` value as well and land with
 * the device-registration work; the manifest validator owns the "release needs a release
 * block" half at ingest.
 */
export function validateServices(services: ServicesMap): string[] {
  const errors: string[] = [];
  // Update is the FEED over Release's truth store (D-05) — appcasts and `/version` are
  // rendered from the releases, channels and artifacts Release syncs. A product with Update
  // on and Release off would serve an empty feed and call it an answer.
  if (services.update.enabled && !services.release.enabled) {
    errors.push("update_requires_release");
  }
  return errors;
}
