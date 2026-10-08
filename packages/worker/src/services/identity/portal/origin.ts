/**
 * How a licence reached the person, as the portal's licence summary reports it (PX-23; notes/S-24
 * §10, D21; SIGN-IN.md O-11, O-17; docs/design/PORTAL.md §4.20). The card words it; the Worker
 * decides which, from facts only it has:
 *
 *   signin      issued by signing in (`licenses.origin = 'oidc'`, or a legacy `sub`-only licence)
 *               and no key, by auto-issue or a group grant: "Automatic Grant" (owner polish
 *               2026-10-07).
 *   store-key   a key, and an active store purchase on the licence: "Steam key ending 3WPLDA".
 *   store       a store purchase and no key: "From Steam".
 *   developer   a licence the developer assigned (it carries an email, S-24 D1: the holder the
 *               developer named), even though it has a key; also a keyless licence the developer
 *               issued: "From Tidewater Labs".
 *   key         a key the person added, on a licence nobody was named for (it was floating):
 *               "Key ending 3WPLDA".
 *
 * `originStore` names the store for the two store origins (`purchase.store`'s ids, PX-W6), never
 * an order id. The purchase facts are License's, read through its `licenseProvenance` descriptor
 * hook (`purchase.ts`); with License off or no hooks there is no store, so a store licence reads
 * by its other facts.
 */

import type { Db } from "../../../core/platform.js";
import { licenseEmail } from "../../../core/accountSubjects.js";
import { loadProductPublic } from "../../../core/products.js";
import type { PortalHooksFor } from "./api.js";
import { purchasesFor } from "./purchase.js";

export type PortalLicenseOrigin =
  | "signin"
  | "store-key"
  | "store"
  | "developer"
  | "key";

export interface OriginFacts {
  /** `licenses.origin`: `admin`, `oidc` or `enroll`. */
  origin?: string | null;
  sub: string | null;
  email: string | null;
  /** Keys on the licence, any status (a revoked key is still how it came). */
  keyCount: number;
  /** The store of the earliest active purchase on the licence, or null. */
  store: string | null;
}

/** The one rule (see the module comment); the first match wins. */
export function portalLicenseOrigin(facts: OriginFacts): {
  origin: PortalLicenseOrigin;
  originStore: string | null;
} {
  const hasKey = facts.keyCount > 0;
  if (facts.store)
    return {
      origin: hasKey ? "store-key" : "store",
      originStore: facts.store,
    };
  if (!hasKey && (facts.origin === "oidc" || facts.sub))
    return { origin: "signin", originStore: null };
  if (licenseEmail({ email: facts.email }) !== null || !hasKey)
    return { origin: "developer", originStore: null };
  return { origin: "key", originStore: null };
}

/**
 * The store of each licence's active purchase (null when none), filed under
 * {@link storeKey}, for licences of possibly several products: one provenance read per product.
 * Empty without hooks.
 */
export async function licenseStores(
  db: Db,
  licences: ReadonlyArray<{ product: string; id: string }>,
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!hooksFor) return out;
  const byProduct = new Map<string, string[]>();
  for (const l of licences) {
    const ids = byProduct.get(l.product) ?? [];
    ids.push(l.id);
    byProduct.set(l.product, ids);
  }
  for (const [slug, ids] of byProduct) {
    const product = await loadProductPublic(db, slug);
    if (!product) continue;
    const purchases = await purchasesFor(db, product, ids, hooksFor, now);
    for (const [id, p] of purchases)
      out.set(
        storeKey(slug, id),
        p.source === "store" ? (p.store ?? null) : null,
      );
  }
  return out;
}

/** The key {@link licenseStores} files a licence under. */
export function storeKey(product: string, licenseId: string): string {
  return `${product}\u0000${licenseId}`;
}

// ── Removable (PX-23 review, lead decision 2026-10-06) ───────────────────────────────────────

/** Why a licence cannot be removed from a library, when it cannot. */
export type NotRemovableReason = "no_active_key" | "key_claim_off";

/**
 * Can the person remove this licence from their library? Only when they could add it back, and
 * after a removal the one way back is its key (LX-26's block refuses every automatic attach, and
 * Discover counts a held product as held): so the licence needs an active key AND the product
 * must let a key add a licence in the portal (`license_key_claim_enabled`). A sign-in licence, a
 * Discover claim and a keyless store or developer licence are never removable. The licence list
 * and detail report it (`removable`), and `DELETE /api/licenses/<p>/<id>` refuses the rest with
 * `409 not_removable`, writing nothing.
 */
export function notRemovableReason(
  activeKeyCount: number,
  keyClaimEnabled: boolean,
): NotRemovableReason | null {
  if (activeKeyCount < 1) return "no_active_key";
  if (!keyClaimEnabled) return "key_claim_off";
  return null;
}
