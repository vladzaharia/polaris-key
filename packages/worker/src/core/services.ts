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

import type { RegistrationPolicy } from "@plrs/protocol/core";

export type { RegistrationPolicy };

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
}

/**
 * Read `products.services_json`.
 *
 * STRICT, AND FAIL-SAFE — the two are not in tension here. The column is a TEXT blob read on
 * every product-scoped request; its content can be a stale row, a hand-edit in the D1 console,
 * or the output of a future writer this build has never seen. So:
 *
 *   - Anything structurally wrong — not JSON, not an object, an array, an unrecognised key,
 *     a non-object entry, an `enabled` that isn't a boolean, a `registration` outside the three
 *     policies — discards the WHOLE record and returns the defaults. Not a partial merge: a
 *     record we cannot fully understand cannot be trusted to be describing what we think it
 *     describes, and half-honouring it would turn a typo into a silently-disabled service.
 *     ONE rule for the whole blob, including `registration`: a second, softer tolerance for one
 *     key inside the same value is exactly the inconsistency that gets misremembered later.
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
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "registration") {
      if (!isRegistrationPolicy(value)) return fallback();
      registration = value;
      continue;
    }
    if (!isServiceSlug(key)) return fallback();
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fallback();
    const enabled = (value as Record<string, unknown>).enabled;
    if (typeof enabled !== "boolean") return fallback();
    services[key] = { enabled };
  }
  return registration === undefined ? { services } : { services, registration };
}

/**
 * The inverse of `parseServices`: the exact JSON the column stores.
 *
 * Slugs first in canonical order, `registration` last and only when declared — so a manifest
 * that says nothing about registration writes a column that says nothing about it either, and
 * the derived default keeps tracking the enablement set.
 */
export function serializeServices(parsed: ProductServices): string {
  const out: Record<string, unknown> = {};
  for (const slug of SERVICE_SLUGS)
    out[slug] = { enabled: parsed.services[slug].enabled };
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
  // Update is the FEED over Release's truth store (D-05) — appcasts and `/version` are
  // rendered from the releases, channels and artifacts Release syncs. A product with Update
  // on and Release off would serve an empty feed and call it an answer.
  if (services.update.enabled && !services.release.enabled) {
    errors.push("update_requires_release");
  }
  // `requires-identity` says "register, but only behind a product login". With Identity off
  // there is no login to stand behind, so the endpoint could never say yes to anyone — a
  // product in this state has silently taken registration away rather than restricted it.
  if (registration === "requires-identity" && !services.identity.enabled) {
    errors.push("registration_requires_identity");
  }
  // Config with License off is the D-08 shape: devices register, hold `plrst_` tokens, and
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
