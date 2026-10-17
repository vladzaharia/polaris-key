/// <reference types="@cloudflare/workers-types" />

/**
 * Store grants — how a verified store purchase becomes a licence flag (P6-01, README §3.10).
 *
 * Two services meet here. Distribution owns the store side (credentials, connectors, the
 * purchase records and their verification, `services/distribution/commerce/`); License owns the
 * licence and therefore the effect on it (`license_store_grants`). A service may not import
 * another (AGENTS.md rule 6), and Core's read-only descriptor hooks (`core/hooks.ts`) may not
 * write, so the write goes through a descriptor method Core declares and License implements —
 * the pattern `ServiceDescriptor.authorizeRegistration` set (`core/registry.ts`):
 *
 *   - `ServiceDescriptor.applyStoreGrant` — implemented by License only;
 *   - `applyStoreGrant(registry, services, ctx, change)` (`registry.ts`) — Core's caller, which
 *     fails CLOSED: License off, or no License descriptor, answers `license_disabled` before any
 *     License code runs;
 *   - `StoreGrantWriter` — that caller bound to one product and request, handed to Distribution on
 *     `ServiceContext.storeGrants` and `ScheduledServiceContext.storeGrants`. Absent = no grant can
 *     be written (a context built by hand, the admin API), which the commerce code treats as
 *     License off.
 *
 * This is the coherence rule "commerce needs License enabled" made structural: with License off
 * no grant can land, and the commerce routes say so instead of recording a purchase they cannot
 * honour (`services/distribution/commerce/`). The admin API refuses store-product mappings for a
 * product without License on for the same reason.
 *
 * The grant is per DELIVERABLE, not per version: the flag rides every licence document the buyer
 * gets, for every release, until a refund or revocation (CONTENT §6.7 item 9). Flags already
 * exist in the signed licence document, so its shape and `PROTOCOL_VERSION` do not change.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import type { ProductPublic } from "../products.js";

/** The stores the bridge verifies purchases with. */
export const STORES = ["app-store", "play", "steam"] as const;
export type Store = (typeof STORES)[number];

export function isStore(v: unknown): v is Store {
  return typeof v === "string" && (STORES as readonly string[]).includes(v);
}

/** One change to one licence's store grant. */
export interface StoreGrantChange {
  licenseId: string;
  /** The licence flag (an `entitlements` key of the licence document). */
  flag: string;
  store: Store;
  /** SHA-256 hex of the store's purchase key — the grant's identity, never the raw token. */
  purchaseKeyHash: string;
  action: "grant" | "revoke";
  /** A sentence for the audit row (no token, no PII). */
  summary: string;
}

export type StoreGrantOutcome =
  | { ok: true; changed: boolean }
  | {
      ok: false;
      /** `license_disabled`: License is off for the product (or not mounted). `no_license`: no
       *  such licence in this product. */
      reason: "license_disabled" | "no_license";
    };

/** What License's implementation is given. No `Request`: this is a write on behalf of a
 *  verified purchase, not a route. */
export interface StoreGrantContext {
  env: Env;
  db: Db;
  product: ProductPublic;
  now: number;
}

/** Core's `applyStoreGrant`, bound to one product and one request or tick. */
export type StoreGrantWriter = (
  change: StoreGrantChange,
) => Promise<StoreGrantOutcome>;

/** One active grant as the licence-document layer reads it. */
export interface ActiveStoreGrant {
  flag: string;
  granted_at: number;
}

/**
 * The active store grants of one licence, as a stored-payload layer (`core/licensing/payload.ts`): every
 * active flag `true`, state `default` — so any later layer (the licence's own overrides, a
 * device override) wins over it whatever its state, and an operator's `enforced` or `hidden`
 * profile entry for the same flag is not displaced by a purchase. `null` when there is none.
 *
 * Core reads License's table here exactly as it reads the licence's tiers and profiles for the
 * same merge: the layer cake is Core's (payload.ts header), and only the WRITE is License's.
 */
export async function storeGrantLayer(
  db: Db,
  product: string,
  licenseId: string,
): Promise<string | null> {
  const rows = await db.all<ActiveStoreGrant>(
    `SELECT flag, MAX(granted_at) AS granted_at FROM license_store_grants
      WHERE product = ? AND license_id = ? AND state = 'active'
      GROUP BY flag ORDER BY flag`,
    product,
    licenseId,
  );
  return storeGrantLayerOf(rows);
}

/** {@link storeGrantLayer}'s layer out of one licence's active rows. */
export function storeGrantLayerOf(
  rows: readonly ActiveStoreGrant[],
): string | null {
  if (rows.length === 0) return null;
  const entitlements: Record<
    string,
    { state: "default"; value: true; updatedAt: number }
  > = {};
  for (const r of rows)
    entitlements[r.flag] = {
      state: "default",
      value: true,
      updatedAt: r.granted_at,
    };
  return JSON.stringify({ entitlements });
}

/** D1 binds at most 100 parameters per statement; one is the product. */
const GRANT_IDS_PER_QUERY = 90;

/**
 * The active grants of many licences in one read per 90 ids (a licence list's page): licence id →
 * the rows `storeGrantLayer` reads for it, in the same order.
 */
export async function storeGrantRowsFor(
  db: Db,
  product: string,
  licenseIds: readonly string[],
): Promise<Map<string, ActiveStoreGrant[]>> {
  const out = new Map<string, ActiveStoreGrant[]>();
  for (let i = 0; i < licenseIds.length; i += GRANT_IDS_PER_QUERY) {
    const ids = licenseIds.slice(i, i + GRANT_IDS_PER_QUERY);
    const rows = await db.all<ActiveStoreGrant & { license_id: string }>(
      `SELECT license_id, flag, MAX(granted_at) AS granted_at FROM license_store_grants
        WHERE product = ? AND state = 'active' AND license_id IN (${ids.map(() => "?").join(", ")})
        GROUP BY license_id, flag ORDER BY license_id, flag`,
      product,
      ...ids,
    );
    for (const r of rows) {
      const list = out.get(r.license_id) ?? [];
      list.push({ flag: r.flag, granted_at: r.granted_at });
      out.set(r.license_id, list);
    }
  }
  return out;
}
