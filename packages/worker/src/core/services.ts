/**
 * Per-product service enablement — the single authority (design spec §2.2).
 *
 * Polaris Key is a suite of opt-in services (the rows of `tools/services.json`) over an
 * always-on Core substrate. `products.services_json` records which of them a product runs, and
 * every consumer — route mounting, the discovery document, the admin setup view, portal
 * capabilities — becomes a projection of THIS, instead of each re-inferring enablement from
 * the presence of some child row.
 *
 * `products.services_source` says who owns that column: `manifest` (a resync may rewrite it)
 * or `admin` (an operator claimed it live). Same machinery as the fingerprint and auto-issue
 * policies; see `setServices` in `../repo.ts`.
 */

import type { RegistrationPolicy } from "@polaris-key/protocol/core";
import {
  DEFAULT_ENABLED_SERVICES,
  SERVICE_REQUIRES,
  SERVICE_SLUGS,
  type ServiceSlug,
} from "@polaris-key/manifest";

export type { RegistrationPolicy };

/**
 * The opt-in services come from the generated service table (`tools/services.json`, written into
 * `@polaris-key/manifest` by `pnpm gen services`). Core is not a service — it is always on.
 * `SERVICE_SLUGS` is the canonical order: iterate it rather than `Object.keys` so output is
 * stable. Re-exported so the rest of the worker keeps importing them from here.
 */
export { SERVICE_SLUGS, type ServiceSlug };

/** Per-service state. Only `enabled` today; the object shape leaves room for per-service
 *  settings without a second column. */
export type ServicesMap = Record<ServiceSlug, { enabled: boolean }>;

/** Who owns `services_json`. `manifest` => resync reapplies; `admin` => operator-claimed. */
export type ServicesSource = "manifest" | "admin";

/** A map with every slug set from `enabled`, in canonical order. */
function servicesWhere(enabled: (slug: ServiceSlug) => boolean): ServicesMap {
  const out = {} as ServicesMap;
  for (const slug of SERVICE_SLUGS) out[slug] = { enabled: enabled(slug) };
  return out;
}

/**
 * What a product runs when it has never said otherwise: the table's `defaultEnabled` rows —
 * licensing + settings delivery, which is exactly what every product does today.
 * Release, Distribution, Update and Identity are opt-in because they need coordinates (a
 * linked repo, an IdP) a default cannot invent.
 */
export const DEFAULT_SERVICES: ServicesMap = servicesWhere((slug) =>
  DEFAULT_ENABLED_SERVICES.includes(slug),
);

/** A fresh copy of the defaults — the exported constant is never handed out to callers who
 *  might mutate it. */
function defaults(): ServicesMap {
  return servicesWhere((slug) => DEFAULT_SERVICES[slug].enabled);
}

function isServiceSlug(value: string): value is ServiceSlug {
  return (SERVICE_SLUGS as readonly string[]).includes(value);
}

/** The three registration policies, in the order spec §2.3 lists them. */
export const REGISTRATION_POLICIES: readonly RegistrationPolicy[] = [
  "open",
  "requires-identity",
  "requires-license",
];

function isRegistrationPolicy(value: unknown): value is RegistrationPolicy {
  return (
    typeof value === "string" &&
    (REGISTRATION_POLICIES as readonly string[]).includes(value)
  );
}

/**
 * Everything `products.services_json` carries: the enablement set.
 *
 * ── THE RETIRED `registration` KEY (ST-38) ──────────────────────────────────────────────────
 *
 * The blob used to carry a declared device-registration policy beside the slugs
 * (`"registration":"open"`). The policy is now always derived from the services
 * (`resolveRegistration`), so nothing writes the key and nothing reads it: a stored one is
 * tolerated by the parser and dropped by the next write. A product that wants anonymous devices
 * on a licensed product gets them from `license.access` (LX-36), not from a registration choice.
 */
export interface ProductServices {
  services: ServicesMap;
  /**
   * Slugs this build does not know, carried through so a round-trip does not delete them. A newer
   * worker may have written a service (e.g. `distribution`) that a rolled-back or not-yet-deployed
   * build has never heard of. Only WELL-FORMED entries (`{ enabled: boolean }`) land here.
   * PASSTHROUGH ONLY: nothing may read this to decide enablement or registration — an unknown
   * service is not enabled as far as this build is concerned. Absent when there are none.
   */
  unknown?: Record<string, { enabled: boolean }>;
}

/**
 * Read `products.services_json`.
 *
 * STRICT, AND FAIL-SAFE — the two are not in tension here. The column is a TEXT blob read on
 * every product-scoped request; its content can be a stale row, a hand-edit in the D1 console,
 * or the output of a future writer this build has never seen. So:
 *
 *   - Anything structurally wrong — not JSON, not an object, an array, an unrecognised key
 *     whose value is not a well-formed `{ enabled: boolean }`, a non-object entry, an `enabled` that isn't a boolean, a `registration` outside the three
 *     policies — discards the WHOLE record and returns the defaults. Not a partial merge: a
 *     record we cannot fully understand cannot be trusted to be describing what we think it
 *     describes, and half-honouring it would turn a typo into a silently-disabled service.
 *     ONE rule for the whole blob, including `registration`: a second, softer tolerance for one
 *     key inside the same value is exactly the inconsistency that gets misremembered later.
 *   - An unrecognised key with a WELL-FORMED value is a slug a newer build wrote. It is skipped
 *     for every decision and carried in `ProductServices.unknown` so `serializeServices` writes
 *     it back: rolling a worker back past the release that introduced a slug must neither reset
 *     the slugs it does know nor delete the one it does not. Malformed unknown values still
 *     discard the whole record, and `__proto__` is never a slug.
 *   - A well-formed record that simply omits a slug gets that slug's default. Undeclared means
 *     "not stated", which is the same thing the manifest means by it. A retired `registration`
 *     key (ST-38) is held to the three policies and otherwise ignored.
 *   - It never throws. Hostile DB content must not be able to 500 a request.
 *
 * Falling back to the DEFAULTS (rather than to all-disabled) is deliberate: this parser sits
 * in front of the routes every existing product already serves, so the safe direction is
 * "behave exactly as this product behaved before the column existed". Note what the defaults
 * DERIVE for registration: License defaults on, so an unreadable record lands on
 * `requires-license`, i.e. the closed policy that was the only behaviour before this existed.
 */
export function parseServices(
  json: string | null | undefined,
): ProductServices {
  const fallback = (): ProductServices => ({ services: defaults() });
  if (!json) return fallback();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fallback();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback();

  const services = defaults();
  const unknown: Record<string, { enabled: boolean }> = {};
  let hasUnknown = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // ST-38: the retired declared policy. Still held to its three values (a record we cannot
    // read is not trusted), then ignored: the policy is derived.
    if (key === "registration") {
      if (!isRegistrationPolicy(value)) return fallback();
      continue;
    }
    if (key === "__proto__") return fallback();
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fallback();
    const enabled = (value as Record<string, unknown>).enabled;
    if (typeof enabled !== "boolean") return fallback();
    if (isServiceSlug(key)) {
      services[key] = { enabled };
    } else {
      unknown[key] = { enabled };
      hasUnknown = true;
    }
  }
  return {
    services,
    ...(hasUnknown ? { unknown } : {}),
  };
}

/**
 * The inverse of `parseServices`: the exact JSON the column stores.
 *
 * Slugs first in canonical order, then any passed-through unknown slugs sorted by key. The
 * retired `registration` key is never written (ST-38).
 */
export function serializeServices(parsed: ProductServices): string {
  const out: Record<string, unknown> = {};
  for (const slug of SERVICE_SLUGS)
    out[slug] = { enabled: parsed.services[slug].enabled };
  if (parsed.unknown) {
    const entries = Object.entries(parsed.unknown).sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0,
    );
    for (const [key, value] of entries) {
      if (key === "__proto__" || key === "registration") continue;
      out[key] = { enabled: value.enabled };
    }
  }
  return JSON.stringify(out);
}

/**
 * The registration policy (wire v3 §6, spec §2.3), always derived from the services (ST-38: the
 * policy is not a choice; `devices.registration` is a removed manifest field).
 *
 * The derivation is ordered by how much the product already knows about the caller:
 * a licensed product already has a mint path (activation), so `POST /devices/register` stays
 * shut; an identity product can authenticate a human, so registration is possible but must go
 * through that; a product with neither has nobody to ask and nothing to protect a seat pool
 * with, so registration is open (rate-limited, never free-for-all).
 */
export function resolveRegistration(services: ServicesMap): RegistrationPolicy {
  if (services.license.enabled) return "requires-license";
  if (services.identity.enabled) return "requires-identity";
  return "open";
}

/**
 * The console's view of a product's enablement — ONE projection, used by both readers.
 *
 * `GET …/services` serves it directly and `productView` embeds it, because the console needs the
 * same answer at two different moments: the Services editor asks for it on demand, while the
 * SHELL needs it before it can decide which nav sections exist at all (D-15). Two independent
 * derivations of "is Release on for this product" is how a sidebar and the page it frames end up
 * disagreeing, so there is one.
 *
 * Structurally typed on the two columns it reads rather than on `ProductRow`, so `core/` does not
 * grow an import of `repo.ts` for a projection that needs nothing else from it.
 */
export function serviceStateOf(
  row: {
    services_json?: string | null;
    services_source?: string | null;
  } | null,
): {
  services: ServicesMap;
  /** The policy the wire enforces, derived from the services. */
  effectiveRegistration: RegistrationPolicy;
  /** `manifest` (a resync may rewrite it) or `admin` (operator-claimed). */
  source: string;
} {
  const parsed = parseServices(row?.services_json ?? null);
  return {
    services: parsed.services,
    effectiveRegistration: resolveRegistration(parsed.services),
    source: row?.services_source ?? "manifest",
  };
}

/**
 * The requirement rule's stable codes, one per `requires` edge of the service table, each
 * `<slug>_requires_<requirement>`. LITERAL on purpose: the admin API, the console and the
 * manifest validator key off them, rule 9's parity sweep reads codes from source, and
 * `serviceTable.test.ts` fails when an edge of `tools/services.json` has no literal here.
 */
export const REQUIREMENT_CODES = [
  "distribution_requires_release",
  "update_requires_distribution",
  "sync_requires_config",
  "sync_requires_identity",
] as const;

/** The stable code for `slug` being on while `requirement` is off. */
export function requirementCode(
  slug: ServiceSlug,
  requirement: ServiceSlug,
): string {
  return `${slug}_requires_${requirement}`;
}

/**
 * The requirement rule over an enablement set (ST-38): a service may be on only while every
 * service it requires (`SERVICE_REQUIRES`, from `tools/services.json`) is on. One generic rule
 * for every edge: Release ← Distribution ← Update, and Cloud Sync's Config and Identity. Returns
 * stable CODES (not prose) so the admin API, the manifest validator and the console can each
 * render them their own way; an empty array means the set is applicable.
 *
 * The registration policy is derived from the same set (`resolveRegistration`), so it can never
 * be incoherent with it and is not checked here.
 */
export function validateServices(services: ServicesMap): string[] {
  const errors: string[] = [];
  for (const slug of SERVICE_SLUGS) {
    if (!services[slug].enabled) continue;
    for (const requirement of SERVICE_REQUIRES[slug]) {
      if (!services[requirement].enabled)
        errors.push(requirementCode(slug, requirement));
    }
  }
  return errors;
}

/** What `applyRequirementRule` settled on. */
export interface RequirementOutcome {
  /** The set to write. */
  services: ServicesMap;
  /** Slugs turned off because something they require is off, in canonical order. */
  cascaded: ServiceSlug[];
  /** `<slug>_requires_<req>` for each slug the patch turns on while a requirement is off. */
  errors: string[];
}

/**
 * Apply a partial enablement patch under the requirement rule (ST-38, plans/CM-29.md §0):
 *
 * - a slug the patch turns ON must have every requirement on in the result, or the patch is
 *   refused with its `<slug>_requires_<req>` code (nothing is pulled on with it);
 * - turning a requirement OFF turns off every slug that needs it, transitively, in the same
 *   write: one audited batch, which the console's confirmation names first (`?dryRun=1`);
 * - turning a requirement back on restores nothing.
 *
 * Pure, so the console's dry run and the write agree by construction.
 */
export function applyRequirementRule(
  before: ServicesMap,
  patch: Partial<Record<ServiceSlug, boolean>>,
): RequirementOutcome {
  const services = servicesWhere(
    (slug) => patch[slug] ?? before[slug].enabled,
  );
  const cascaded = new Set<ServiceSlug>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const slug of SERVICE_SLUGS) {
      if (!services[slug].enabled || patch[slug] === true) continue;
      if (SERVICE_REQUIRES[slug].some((r) => !services[r].enabled)) {
        services[slug] = { enabled: false };
        cascaded.add(slug);
        changed = true;
      }
    }
  }
  return {
    services,
    cascaded: SERVICE_SLUGS.filter((s) => cascaded.has(s)),
    errors: validateServices(services),
  };
}
