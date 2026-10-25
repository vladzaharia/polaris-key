/**
 * THE REQUIREMENTS EVALUATOR (P0-27.3): is a store ready to be used for a product?
 *
 * A store adapter declares what each facet needs as data (`StoreAdapter.requirements`). This is
 * the one evaluator. It answers `met` and, when not, which requirement descriptors are missing
 * (`{kind, slot}`), and nothing else: no key id, issuer, pin or app name leaves it.
 *
 * Custody rules (security-reviewed; `test/core/storeRequirements.test.ts` pins them):
 *   - METADATA ONLY. A credential counts through `listOutletCredentials` (which never selects
 *     `enc_value_json`) and `resolvePlatformCredential` (which opens nothing). This file never
 *     imports `openOutletCredential`, `openPlatformCredential` or the token helpers.
 *   - No store call, no KV, no audit row (a read is not an event).
 *   - A product sees only its own credentials: the listing is keyed by product.
 *
 * The vocabulary is P5's `credential`, plus `app` (P0-27.6): a field of the product's store-app
 * binding is present (`storeAppBinding`, A-28.1: its own credential's pin, else the platform pin;
 * an own credential with no pin leaves the field absent, never falling through). A field in
 * `ambiguous` still counts as present: an assignment exists, though it is unsettled.
 *
 * FAIL CLOSED: an unknown facet string, or `commerce` on a store with no commerce facet, answers
 * `null`, never `met: true`. `met` is readiness, not authorisation: keep it off device and public
 * routes.
 *
 * `credentialAvailable` is the ONE seam: P0-28's `resolveCredential` replaces its body, not its
 * callers.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { listOutletCredentials } from "../outletCredentials.js";
import {
  isPlatformCredentialId,
  PLATFORM_CREDENTIALS,
  platformCredentialsOf,
  resolvePlatformCredential,
  storeAppBinding,
  type PlatformStore,
} from "../platformCredentials.js";
import type { StorefrontId } from "../storefront/adapter.js";
import type { StoreIdentityField, StoreRequirement } from "./adapter.js";
import { storeAdapter } from "./adapters.js";

/** One unmet requirement, as a descriptor only. */
export type MissingRequirement =
  | {
      readonly kind: "credential";
      /** A `PLATFORM_CREDENTIALS` id. */
      readonly slot: string;
    }
  | {
      readonly kind: "app";
      /** The binding field no app is assigned for. */
      readonly field: StoreIdentityField;
    };

export interface StoreRequirements {
  readonly store: StorefrontId;
  /** The facet asked about; null when both were evaluated. */
  readonly facet: "delivery" | "commerce" | null;
  readonly met: boolean;
  readonly missing: readonly MissingRequirement[];
}

/**
 * Whether `product` can use credential `slot`: it has an ACTIVE own credential of the slot's kind
 * (derived here from `PLATFORM_CREDENTIALS`, so a caller cannot pair a slot with another slot's
 * kind), or the platform slot is configured (a console row or a valid Worker secret). Unpinned or
 * mis-pinned credentials still count here: the pin is the connector's check, not readiness of
 * the slot. An id that is not a slot is never available. Metadata only.
 */
export async function credentialAvailable(
  env: Env,
  db: Db,
  product: string,
  slot: string,
): Promise<boolean> {
  if (!isPlatformCredentialId(slot)) return false;
  const ownKind = PLATFORM_CREDENTIALS[slot].kind;
  const own = await listOutletCredentials(db, product);
  if (own.some((c) => c.kind === ownKind && c.status === "active")) return true;
  return (await resolvePlatformCredential(env, db, slot)) !== null;
}

/**
 * The requirements of one store for one product. `null` for an id that is not a store adapter,
 * for a facet that is neither `delivery` nor `commerce`, and for `commerce` on a store with no
 * commerce facet. A keyless channel declares none and so answers `met: true`.
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
  if (facet !== undefined && facet !== "delivery" && facet !== "commerce")
    return null;
  if (facet === "commerce" && adapter.commerce === null) return null;
  const wanted: readonly StoreRequirement[] = adapter.requirements.filter(
    (r) => facet === undefined || r.facet === facet,
  );
  const missing: MissingRequirement[] = [];
  const seen = new Set<string>();
  let binding: Awaited<ReturnType<typeof storeAppBinding>> | null = null;
  for (const r of wanted) {
    const key = r.kind === "credential" ? `c:${r.slot}` : `a:${r.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.kind === "credential") {
      if (!(await credentialAvailable(env, db, product, r.slot)))
        missing.push({ kind: "credential", slot: r.slot });
    } else {
      // Only a store with credential slots has a binding; any other answers no app.
      binding ??=
        platformCredentialsOf(adapter.id as PlatformStore).length > 0
          ? await storeAppBinding(db, product, adapter.id as PlatformStore)
          : { store: adapter.id as PlatformStore, fields: {}, ambiguous: [] };
      if (binding.fields[r.field] === undefined)
        missing.push({ kind: "app", field: r.field });
    }
  }
  return {
    store: adapter.id,
    facet: facet ?? null,
    met: missing.length === 0,
    missing,
  };
}
