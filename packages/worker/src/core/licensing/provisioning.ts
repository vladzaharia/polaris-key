/// <reference types="@cloudflare/workers-types" />

import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "./payload.js";
import { representabilityIssue } from "@polaris-key/catalog";
import { type Env } from "../../platform/env.js";
import { tryParseJson } from "../../platform/json.js";
import type { Db } from "../../db/types.js";
import { type ProductPublic } from "../products.js";
import { loadCatalog } from "../activeCatalog.js";
import { isManagedSecretKey, sealManagedValue } from "../managedSecrets.js";
import { type OidcIdentity } from "./issue.js";

export interface ProvisioningRow {
  product: string;
  claim: string;
  entitlement_key: string | null;
  entitlement_value_json: string | null;
  secret_key: string | null;
  secret_url_template: string | null;
  allowed_hosts_json: string | null;
}

export async function getProvisioning(
  db: Db,
  product: string,
): Promise<ProvisioningRow[]> {
  return db.all<ProvisioningRow>(
    "SELECT * FROM provisioning_config WHERE product = ?",
    product,
  );
}

/** Whether a verified claim genuinely enables a provisioning hook. Truthiness is NOT enough:
 *  an IdP that emits `"false"`, `"0"`, `"null"`, `0`, `[]` or `{}` must not grant an
 *  entitlement, so we require a real boolean `true` or a meaningful string (R8-05c). */
export function claimEnables(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  return s !== "" && s !== "false" && s !== "0" && s !== "null";
}

// ── identity mapping + provisioning ──────────────────────────────────────────
/** Apply provisioning hooks (verified claim -> entitlement + secret) into a payload.
 *  `now` (epoch seconds) is stamped as `updatedAt` on every entry written. */
export async function applyProvisioning(
  db: Db,
  product: string,
  identity: OidcIdentity,
  payload: ManagedPayload,
  now: number,
): Promise<void> {
  applyProvisioningHooks(
    await getProvisioning(db, product),
    identity,
    payload,
    now,
  );
}

/** The override keys a product's provisioning hooks DECLARE, whether or not the identity's
 *  claims enable them right now: every `entitlement_key` and `secret_key` a hook row names. A
 *  sign-in on an existing licence owns exactly these keys and nothing else (LX-02, S-19 §7.5):
 *  it rewrites them, removes one whose claim disappeared (revocation on claim loss), and leaves
 *  every other override key, an operator's included, alone. */
export interface ProvisioningDeclaredKeys {
  entitlements: Set<string>;
  secrets: Set<string>;
}

export function provisioningDeclaredKeys(
  hooks: readonly ProvisioningRow[],
): ProvisioningDeclaredKeys {
  const declared: ProvisioningDeclaredKeys = {
    entitlements: new Set(),
    secrets: new Set(),
  };
  for (const h of hooks) {
    if (h.entitlement_key) declared.entitlements.add(h.entitlement_key);
    if (h.secret_key) declared.secrets.add(h.secret_key);
  }
  return declared;
}

/**
 * The surgical provisioning rewrite of an existing licence's `overrides_json` (LX-02, S-19 §4.3
 * G7, §7.5 Phase A). Pure. `current` is the stored column; `provisioned` is the identity's hooks
 * applied to an empty payload; `declared` is every key those hooks name. Each declared
 * entitlement and secret key is removed from `current` and then set again only when
 * `provisioned` carries it, so a key whose claim disappeared is gone (revocation on claim loss
 * still works) and every undeclared key (an operator's override of any kind, all of `config`,
 * any other top-level member) is kept as stored, sealed secret envelopes included.
 *
 * A column that does not parse as a JSON object is treated as empty, which is what the previous
 * whole-column rewrite did to it. LX-08 moves the provisioned entitlement keys to `oidc` grants;
 * secrets stay here until U-03.
 */
export function mergeProvisionedOverrides(
  current: string | null,
  provisioned: ManagedPayload,
  declared: ProvisioningDeclaredKeys,
): string {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  let parsed: Record<string, unknown> = {};
  if (current) {
    try {
      const p: unknown = JSON.parse(current);
      if (isObject(p)) parsed = p;
    } catch {
      // Unparseable: treated as empty (see above).
    }
  }
  const section = (
    name: "entitlements" | "secrets",
    keys: Set<string>,
  ): Record<string, ManagedEntry> => {
    const raw = parsed[name];
    const out: Record<string, ManagedEntry> = isObject(raw)
      ? { ...(raw as Record<string, ManagedEntry>) }
      : {};
    for (const k of keys) delete out[k];
    for (const [k, v] of Object.entries(provisioned[name])) {
      if (keys.has(k)) out[k] = v;
    }
    return out;
  };
  return JSON.stringify({
    ...parsed,
    config: isObject(parsed.config) ? parsed.config : {},
    secrets: section("secrets", declared.secrets),
    entitlements: section("entitlements", declared.entitlements),
  });
}

export function applyProvisioningHooks(
  hooks: readonly ProvisioningRow[],
  identity: OidcIdentity,
  payload: ManagedPayload,
  now: number,
): void {
  for (const h of hooks) {
    const claimVal = identity.claims[h.claim];
    if (!claimEnables(claimVal)) continue;
    if (h.entitlement_key) {
      let value: ManagedEntry["value"] = true;
      if (h.entitlement_value_json) {
        const parsed = tryParseJson(h.entitlement_value_json) as
          | ManagedEntry["value"]
          | undefined;
        // A hook row we cannot parse is a hook we do not trust: skip it entirely. So is one
        // whose value no signed document could carry (plans/P3-01.md §2.2): the manifest
        // validator refuses such a value at sync, so only a row stored before it lands here,
        // and the signer guard would otherwise refuse this licence's documents.
        if (parsed === undefined || representabilityIssue(parsed) !== null)
          continue;
        value = parsed;
      }
      payload.entitlements[h.entitlement_key] = {
        state: "enforced",
        value,
        updatedAt: now,
      };
    }
    if (h.secret_key && h.secret_url_template) {
      // Global replace: a template may reference {claim} more than once, and leaving a
      // literal placeholder in a "secret" ships a broken URL to the client (R8-06).
      // `encodeURIComponent` throws on a lone surrogate, which a provider's claim may carry;
      // such a hook is skipped like any other it cannot honour, rather than failing sign-in.
      let encodedClaim: string;
      try {
        encodedClaim = encodeURIComponent(String(claimVal));
      } catch {
        continue;
      }
      const url = h.secret_url_template.replaceAll("{claim}", encodedClaim);
      // Host allowlist (defense against templated-secret injection). Fails CLOSED: a missing
      // or malformed allowlist drops the secret rather than emitting any host (R8-06).
      const allowed = tryParseJson(h.allowed_hosts_json) as
        | string[]
        | undefined;
      if (!Array.isArray(allowed)) continue;
      try {
        if (!allowed.includes(new URL(url).host)) continue;
      } catch {
        continue;
      }
      payload.secrets[h.secret_key] = {
        state: "hidden",
        value: url,
        updatedAt: now,
      };
    }
  }
}

/** The identity's provisioning as a sign-in on an EXISTING licence applies it (LX-02): the hooks
 *  applied to an empty payload, and every key those hooks declare, from one read of the hooks.
 *  Read-only; `mergeProvisionedOverrides` turns the pair into the column the update writes. */
export async function signInProvisioning(
  db: Db,
  product: Pick<ProductPublic, "slug">,
  identity: OidcIdentity,
  now: number,
): Promise<{
  provisioned: ManagedPayload;
  declared: ProvisioningDeclaredKeys;
}> {
  const hooks = await getProvisioning(db, product.slug);
  const provisioned: ManagedPayload = {
    config: {},
    secrets: {},
    entitlements: {},
  };
  applyProvisioningHooks(hooks, identity, provisioned, now);
  return { provisioned, declared: provisioningDeclaredKeys(hooks) };
}

/**
 * The column a sign-in writes on top of the provisioning (LX-08, S-19 §7.14 step 4): provisioned
 * ENTITLEMENT keys never go into `overrides_json` any more, they are the licence's `oidc` grant
 * (`core/licensing/grants.ts`); provisioned secrets go to the column until the U-03 run freezes it (then to
 * the owner's account overrides). Config is never provisioned.
 *
 * The secrets on their way to the column are SEALED under `PLATFORM_KEK`, as the console seals the
 * same catalog keys (`core/console/overrides.ts`) and as `applyProvisionedAccountSecrets` seals
 * them on the account side: a templated subscription URL with a verified claim interpolated into
 * it is a real product secret, and a read-only dump of `licenses.overrides_json` must not yield
 * it in the clear while the admin-authored value for the very same catalog key is ciphertext.
 * `mergeProvisionedOverrides` copies what it is given and never seals again.
 */
export async function provisionedColumn(
  env: Env | undefined,
  db: Db,
  product: string,
  provisioned: ManagedPayload,
  frozen: boolean,
): Promise<ManagedPayload> {
  return {
    config: {},
    secrets: frozen
      ? {}
      : await sealProvisionedSecrets(env, db, product, provisioned.secrets),
    entitlements: {},
  };
}

/**
 * `secrets` with every catalog-declared secret sealed (`sealManagedValue`: the console's helper,
 * so either writer can rotate the other's value). The catalog is read once per call, and only
 * when there is something to seal. A catalog that cannot be read FAILS CLOSED: the value is sealed
 * anyway, because `validatePayload` lets only a `kind: "secret"` entry out of this bucket and
 * `isManagedSecretKey` is true for every such entry, so refusing to classify is not a reason to
 * write plaintext. Without an `env` there is nothing to seal with and the value is stored as the
 * column has always held it (`openManagedValue` reads both); every production caller passes one.
 */
export async function sealProvisionedSecrets(
  env: Env | undefined,
  db: Db,
  product: string,
  secrets: Record<string, ManagedEntry>,
): Promise<Record<string, ManagedEntry>> {
  if (!env || Object.keys(secrets).length === 0) return secrets;
  const catalog = await loadCatalog(db, product);
  const sealed: Record<string, ManagedEntry> = {};
  for (const [key, entry] of Object.entries(secrets)) {
    sealed[key] =
      !catalog || isManagedSecretKey(catalog, key)
        ? {
            ...entry,
            value: (await sealManagedValue(
              env,
              product,
              key,
              entry.value,
            )) as ManagedEntry["value"],
          }
        : entry;
  }
  return sealed;
}
