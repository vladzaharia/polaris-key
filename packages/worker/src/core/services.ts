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
 * Everything `products.services_json` carries: the enablement set, plus the product's declared
 * device-registration policy.
 *
 * ── WHY REGISTRATION LIVES IN THE SAME COLUMN ───────────────────────────────────────────────
 *
 * `devices.registration` (wire v3 §6, spec §2.3) is manifest-carried and has to be persisted
 * somewhere, and its DEFAULT is a function of the enablement set — `requires-license` if
 * License is on, else `requires-identity` if Identity is on, else `open`. Reading a policy out
 * of one column while deriving its default from another is how the two drift; a third
 * `products` column for a single three-valued enum is churn for the same answer. So the blob
 * gains a top-level `"registration"` key beside the slugs:
 *
 *     {"license":{"enabled":true},"config":{"enabled":true},"registration":"open"}
 *
 * `registration` is OPTIONAL and stays optional in storage: undeclared means "derive from the
 * services", which is a different thing from "someone chose `open`" — a product that turns
 * License off later must move to the derived `open`, not stay pinned to a value nobody wrote.
 * `resolveRegistration` is the only place that collapses the two.
 */
export interface ProductServices {
  services: ServicesMap;
  /** As DECLARED. `undefined` = undeclared; call `resolveRegistration` for the effective value. */
  registration?: RegistrationPolicy;
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
 *   - A well-formed record that simply omits a slug gets that slug's default; one that omits
 *     `registration` gets the derived policy (`resolveRegistration`). Undeclared means "not
 *     stated", which is the same thing the manifest means by it.
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
  let registration: RegistrationPolicy | undefined;
  const unknown: Record<string, { enabled: boolean }> = {};
  let hasUnknown = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "registration") {
      if (!isRegistrationPolicy(value)) return fallback();
      registration = value;
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
    ...(registration === undefined ? {} : { registration }),
    ...(hasUnknown ? { unknown } : {}),
  };
}

/**
 * The inverse of `parseServices`: the exact JSON the column stores.
 *
 * Slugs first in canonical order, then any passed-through unknown slugs sorted by key, then
 * `registration` last and only when declared — so a manifest
 * that says nothing about registration writes a column that says nothing about it either, and
 * the derived default keeps tracking the enablement set.
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
  if (parsed.registration !== undefined) out.registration = parsed.registration;
  return JSON.stringify(out);
}

/**
 * The EFFECTIVE registration policy (wire v3 §6, spec §2.3).
 *
 * The derivation is ordered by how much the product already knows about the caller:
 * a licensed product already has a mint path (activation), so `POST /devices/register` stays
 * shut; an identity product can authenticate a human, so registration is possible but must go
 * through that; a product with neither has nobody to ask and nothing to protect a seat pool
 * with, so registration is open (rate-limited, never free-for-all).
 */
export function resolveRegistration(
  services: ServicesMap,
  declared?: RegistrationPolicy,
): RegistrationPolicy {
  if (declared !== undefined) return declared;
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
  /** The DECLARED policy, or `null` when the product is riding the derived default. */
  registration: RegistrationPolicy | null;
  /** What the derivation currently produces — what the wire actually enforces. */
  effectiveRegistration: RegistrationPolicy;
  /** `manifest` (a resync may rewrite it) or `admin` (operator-claimed). */
  source: string;
} {
  const parsed = parseServices(row?.services_json ?? null);
  return {
    services: parsed.services,
    registration: parsed.registration ?? null,
    effectiveRegistration: resolveRegistration(
      parsed.services,
      parsed.registration,
    ),
    source: row?.services_source ?? "manifest",
  };
}

/**
 * Coherence rules over an enablement set. Returns stable error CODES (not prose) so the admin
 * API, the manifest validator, and the console can all render them their own way; an empty
 * array means the set is applicable.
 *
 * `registration` is the DECLARED policy, not the resolved one: a derived value cannot be
 * incoherent by construction (it is read off the very set being validated), so validating it
 * would only ever produce noise. Passing `undefined` therefore checks the enablement set alone.
 * The manifest validator owns the "release needs a release block" half at ingest.
 */
export function validateServices(
  services: ServicesMap,
  registration?: RegistrationPolicy,
): string[] {
  const errors: string[] = [];
  // The chain is release ← distribution ← update (README §3.2): truth, then delivery, then
  // decision. Distribution moves Release's artifacts to devices and outlets, so with Release off
  // it has nothing to deliver.
  if (services.distribution.enabled && !services.release.enabled) {
    errors.push("distribution_requires_release");
  }
  // Update is the FEED that tells a device what to do next, over what Distribution says has
  // reached it. Update on with Distribution off would serve a feed with no delivery behind it.
  // This edge SUBSUMES the retired `update_requires_release`: Distribution itself requires
  // Release, so a set that passes both rules has Release on whenever Update is on.
  if (services.update.enabled && !services.distribution.enabled) {
    errors.push("update_requires_distribution");
  }
  // Cloud Sync (plans/U-01.md §0): a user setting is a catalog `config` key, so with Config off
  // there is nothing to sync; and the Cloud Sync principal is the account signed in through the
  // product, so with Identity off no device could ever have one. Both edges hold in both
  // directions: Cloud Sync cannot be turned on without them, nor either of them turned off while
  // Cloud Sync is on.
  if (services.sync.enabled && !services.config.enabled) {
    errors.push("sync_requires_config");
  }
  if (services.sync.enabled && !services.identity.enabled) {
    errors.push("sync_requires_identity");
  }
  // `requires-identity` says "register, but only behind a product login". With Identity off
  // there is no login to stand behind, so the endpoint could never say yes to anyone — a
  // product in this state has silently taken registration away rather than restricted it.
  if (registration === "requires-identity" && !services.identity.enabled) {
    errors.push("registration_requires_identity");
  }
  // Config with License off is the D-08 shape: devices register, hold `pkeyt_` tokens, and
  // fetch config documents with no licence anywhere. `requires-license` closes the only mint
  // path such a product has, so its devices could never obtain a token at all — the service is
  // enabled and unreachable. (Spec §2.2 generalises the old `config_without_activation`
  // warning into exactly this error.)
  if (
    services.config.enabled &&
    !services.license.enabled &&
    registration === "requires-license"
  ) {
    errors.push("config_without_activation");
  }
  return errors;
}
