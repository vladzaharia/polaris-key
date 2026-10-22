/**
 * THE REQUIREMENTS EVALUATOR (P0-27.3): is a store ready to be used for a product?
 *
 * A store adapter declares what each facet needs as data (`StoreAdapter.requirements`). This is
 * the one evaluator. It answers `met` and, when not, which requirement descriptors are missing
 * (`{kind, slot}`), and nothing else: no key id, issuer, pin or app name leaves it.
 *
 * Custody rules (security-reviewed; `test/storeRequirements.test.ts` pins them):
 *   - METADATA ONLY. A credential counts through `listOutletCredentials` (which never selects
 *     `enc_value_json`) and `resolvePlatformCredential` (which opens nothing). This file never
 *     imports `openOutletCredential`, `openPlatformCredential` or the token helpers.
 *   - No store call, no KV, no audit row (a read is not an event).
 *   - A product sees only its own credentials: the listing is keyed by product.
 *
 * The vocabulary is P5's `credential`. The `app` requirement (a binding field present) joins in
 * P0-27.6, once A-28.1's `storeAppBinding` is on the same branch.
 *
 * `credentialAvailable` is the ONE seam: P0-28's `resolveCredential` replaces its body, not its
 * callers.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { listOutletCredentials } from "../outletCredentials.js";
import {
  isPlatformCredentialId,
  resolvePlatformCredential,
} from "../platformCredentials.js";
import type { StorefrontId } from "../storefront/adapter.js";
import type { StoreRequirement } from "./adapter.js";
import { storeAdapter } from "./adapters.js";

/** One unmet requirement, as a descriptor only. */
export interface MissingRequirement {
  readonly kind: "credential";
  /** A `PLATFORM_CREDENTIALS` id. */
  readonly slot: string;
}

export interface StoreRequirements {
  readonly store: StorefrontId;
  /** The facet asked about; null when both were evaluated. */
  readonly facet: "delivery" | "commerce" | null;
  readonly met: boolean;
  readonly missing: readonly MissingRequirement[];
}

/**
 * Whether `product` can use credential `slot`: it has an ACTIVE own credential of `ownKind`, or
 * the platform slot is configured (a console row or a valid Worker secret). Unpinned or
 * mis-pinned credentials still count here: the pin is the connector's check, not readiness of
 * the slot. Metadata only.
 */
export async function credentialAvailable(
  env: Env,
  db: Db,
  product: string,
  slot: string,
  ownKind: string,
): Promise<boolean> {
  const own = await listOutletCredentials(db, product);
  if (own.some((c) => c.kind === ownKind && c.status === "active")) return true;
  if (!isPlatformCredentialId(slot)) return false;
  return (await resolvePlatformCredential(env, db, slot)) !== null;
}

/**
 * The credential requirements of one store for one product. `null` for an id that is not a
 * store adapter. A keyless channel declares none and so answers `met: true`.
 */
export async function storeRequirements(
  env: Env,
  db: Db,
  product: string,
  storeId: string,
  facet?: "delivery" | "commerce",
): Promise<StoreRequirements | null> {
  const adapter = storeAdapter(storeId);
  if (!adapter) return null;
  const wanted: readonly StoreRequirement[] = adapter.requirements.filter(
    (r) => facet === undefined || r.facet === facet,
  );
  const missing: MissingRequirement[] = [];
  const seen = new Set<string>();
  for (const r of wanted) {
    if (seen.has(r.slot)) continue;
    seen.add(r.slot);
    if (!(await credentialAvailable(env, db, product, r.slot, r.ownKind)))
      missing.push({ kind: r.kind, slot: r.slot });
  }
  return {
    store: adapter.id,
    facet: facet ?? null,
    met: missing.length === 0,
    missing,
  };
}
