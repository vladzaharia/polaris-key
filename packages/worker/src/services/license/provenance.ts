/// <reference types="@cloudflare/workers-types" />

/**
 * License's `licenseProvenance` descriptor hook (PX-W6, portal gap G8, `core/hooks.ts`): where
 * each licence came from, so the portal's License card can say "Bought on Steam" or "Bought from
 * <developer>" without Identity reading License's tables (AGENTS.md rule 6).
 *
 * Two facts, both License's own:
 *
 *   - `license_store_grants` — every store purchase the commerce bridge granted onto the licence
 *     (`storeGrants.ts` is its one writer). An ACTIVE grant makes the source `store`.
 *   - `licenses.origin` — how the licence row was minted (`0011_auto_issue.sql`): `admin` is the
 *     developer, `oidc` a sign-in, `enroll` a free auto-issue. An origin this build does not know
 *     reads as `developer`, the column's own default.
 *
 * Read-only, scoped to the hook's product, and it never hands out a purchase key hash.
 */

import type {
  HookContext,
  LicenseProvenance,
  PurchaseSource,
  PurchaseSourceKind,
  StoreGrantRecord,
} from "../../core/hooks.js";

/** D1's bound-parameter ceiling is 100; one slot is the product. */
const IDS_PER_QUERY = 90;

interface OriginRow {
  id: string;
  origin: string | null;
}

interface GrantRow {
  license_id: string;
  store: string;
  flag: string;
  state: string;
  granted_at: number;
  revoked_at: number | null;
}

/** The source a licence's origin names, when no store purchase is active on it. */
export function originSource(
  origin: string | null | undefined,
): PurchaseSourceKind {
  if (origin === "oidc") return "sign_in";
  if (origin === "enroll") return "free";
  return "developer";
}

/** One licence's source from its origin and its grants (already in grant order). */
export function purchaseSourceOf(
  licenseId: string,
  origin: string | null | undefined,
  grants: readonly StoreGrantRecord[],
): PurchaseSource {
  const stores: string[] = [];
  for (const g of grants)
    if (g.state === "active" && !stores.includes(g.store)) stores.push(g.store);
  return {
    licenseId,
    kind: stores.length > 0 ? "store" : originSource(origin),
    store: stores[0] ?? null,
    stores,
    grants: [...grants],
  };
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function licenseProvenance(ctx: HookContext): LicenseProvenance {
  const { db } = ctx;
  const product = ctx.product.slug;
  return {
    async purchaseSources(licenseIds) {
      const ids = [...new Set(licenseIds)];
      const origins = new Map<string, string | null>();
      const grants = new Map<string, StoreGrantRecord[]>();
      for (const batch of chunks(ids, IDS_PER_QUERY)) {
        const marks = batch.map(() => "?").join(", ");
        for (const row of await db.all<OriginRow>(
          `SELECT id, origin FROM licenses WHERE product = ? AND id IN (${marks})`,
          product,
          ...batch,
        ))
          origins.set(row.id, row.origin);
        for (const row of await db.all<GrantRow>(
          `SELECT license_id, store, flag, state, granted_at, revoked_at
             FROM license_store_grants
            WHERE product = ? AND license_id IN (${marks})
            ORDER BY granted_at ASC, store ASC, flag ASC`,
          product,
          ...batch,
        )) {
          const list = grants.get(row.license_id) ?? [];
          list.push({
            store: row.store,
            flag: row.flag,
            state: row.state === "active" ? "active" : "revoked",
            grantedAt: row.granted_at,
            revokedAt: row.revoked_at,
          });
          grants.set(row.license_id, list);
        }
      }
      const out: PurchaseSource[] = [];
      const seen = new Set<string>();
      for (const id of licenseIds) {
        if (!origins.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push(purchaseSourceOf(id, origins.get(id), grants.get(id) ?? []));
      }
      return out;
    },
  };
}
