/**
 * The commerce bridge's state (P6-01, migration 0052): the operator's store-product map, the
 * purchase bindings and the verified purchases — and the one function that turns a verified
 * purchase into a grant or a revocation (`recordPurchase`).
 *
 * Store-agnostic: each store module (`apple.ts`, `play.ts`, `steam.ts`) verifies a purchase with
 * its store and hands a `VerifiedPurchase` here. Nothing in this file talks to a store.
 *
 * The rules, in `recordPurchase`'s order:
 *
 *   1. **Mapped.** The store product must be in `dist_store_products`; an unmapped one grants
 *      nothing and is not recorded (`unmapped`).
 *   2. **Bound.** The purchase must carry a binding (Apple `appAccountToken`, Play
 *      `obfuscatedExternalAccountId`, the Steam ticket's identity) that names a licence of this
 *      product (`unbound` otherwise). A claim additionally requires that licence to be the
 *      caller's (`binding_mismatch`): a transaction bound to one licence can never grant another.
 *   3. **First licence wins.** A purchase already recorded for a licence stays that licence's;
 *      any other licence is refused (`bound_elsewhere`) — whatever binding a replay carries. The
 *      one exception is a licence merge (LX-03, `core/licenseMerge.ts`): the retired licence's
 *      purchases move to the survivor and its binding becomes an alias of the survivor
 *      (`commerceMergeStatements`), so "that licence" is then the survivor.
 *   4. **State.** `active` grants the mapped flag through Core's `applyStoreGrant` (License);
 *      `revoked` revokes it; `pending` records and grants nothing. A replay changes nothing (the
 *      grant is idempotent and `changed: false` comes back).
 *
 * Purchase keys are stored only as SHA-256 hashes (`purchaseKeyHash`); `detail_json` keeps the
 * non-secret ids a re-check needs (a Play purchase token IS such an id — it is how Play's API is
 * addressed — and is kept there, never in a log or an audit row).
 */

import { ENTITLEMENT_PATTERN } from "@polaris-key/protocol/packs";
import { isDeliverableId } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../../core/platform.js";
import type { LicenseMergeChange } from "../../../core/licenseMerge.js";
import {
  idChunks,
  type LicenseDeleteBlocker,
  type LicenseDeleteContributor,
} from "../../../core/licenseDelete.js";
import type { Store, StoreGrantWriter } from "../../../core/storeGrants.js";

// ── hashing ──────────────────────────────────────────────────────────────────────────────────

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The stored identity of a purchase: SHA-256 of `<store>:<key>`. */
export function purchaseKeyHash(store: Store, key: string): Promise<string> {
  return sha256Hex(`${store}:${key}`);
}

// ── store products ───────────────────────────────────────────────────────────────────────────

export interface StoreProductRow {
  product: string;
  store: Store;
  store_product_id: string;
  deliverable_id: string;
  flag: string;
  source: string;
  modified_at: number;
  modified_by: string;
}

/** A store product id per store: an App Store product id, a Play product id (SKU), or a Steam
 *  DLC app id. */
const STORE_PRODUCT_ID: Record<Store, RegExp> = {
  "app-store": /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  play: /^[a-z0-9][a-z0-9._]{0,139}$/,
  steam: /^[1-9][0-9]{0,9}$/,
};

export function isStoreProductId(store: Store, id: unknown): id is string {
  return typeof id === "string" && STORE_PRODUCT_ID[store].test(id);
}

export function isFlag(v: unknown): v is string {
  return typeof v === "string" && ENTITLEMENT_PATTERN.test(v);
}

export { isDeliverableId };

export function listStoreProducts(
  db: Db,
  product: string,
): Promise<StoreProductRow[]> {
  return db.all<StoreProductRow>(
    "SELECT * FROM dist_store_products WHERE product = ? ORDER BY store, store_product_id",
    product,
  );
}

export function getStoreProduct(
  db: Db,
  product: string,
  store: Store,
  storeProductId: string,
): Promise<StoreProductRow | null> {
  return db.first<StoreProductRow>(
    "SELECT * FROM dist_store_products WHERE product = ? AND store = ? AND store_product_id = ?",
    product,
    store,
    storeProductId,
  );
}

export async function upsertStoreProduct(
  db: Db,
  row: Omit<StoreProductRow, "source">,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_store_products
       (product, store, store_product_id, deliverable_id, flag, source, modified_at, modified_by)
     VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)
     ON CONFLICT (product, store, store_product_id) DO UPDATE SET
       deliverable_id = excluded.deliverable_id, flag = excluded.flag,
       modified_at = excluded.modified_at, modified_by = excluded.modified_by`,
    row.product,
    row.store,
    row.store_product_id,
    row.deliverable_id,
    row.flag,
    row.modified_at,
    row.modified_by,
  );
}

export function deleteStoreProduct(
  db: Db,
  product: string,
  store: Store,
  storeProductId: string,
): Promise<number> {
  return db.runChanges(
    "DELETE FROM dist_store_products WHERE product = ? AND store = ? AND store_product_id = ?",
    product,
    store,
    storeProductId,
  );
}

// ── bindings ─────────────────────────────────────────────────────────────────────────────────

/** A binding id as issued: a lowercase RFC 4122 UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A store-echoed binding normalised for comparison (S-09: Apple's JWS carries the
 *  `appAccountToken` in lower case, a client may send upper case): lowercase UUID, else null. */
export function normaliseBinding(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const lower = v.trim().toLowerCase();
  return UUID.test(lower) ? lower : null;
}

/** The licence's binding, created on first use. Never the licence id; not derivable from it. */
export async function bindingFor(
  db: Db,
  product: string,
  licenseId: string,
  now: number,
): Promise<string> {
  const existing = await db.first<{ binding_id: string }>(
    "SELECT binding_id FROM dist_purchase_bindings WHERE product = ? AND license_id = ?",
    product,
    licenseId,
  );
  if (existing) return existing.binding_id;
  await db.run(
    `INSERT INTO dist_purchase_bindings (product, binding_id, license_id, created_at)
     VALUES (?, ?, ?, ?) ON CONFLICT (product, license_id) DO NOTHING`,
    product,
    crypto.randomUUID().toLowerCase(),
    licenseId,
    now,
  );
  const row = await db.first<{ binding_id: string }>(
    "SELECT binding_id FROM dist_purchase_bindings WHERE product = ? AND license_id = ?",
    product,
    licenseId,
  );
  if (!row) throw new Error("binding not stored");
  return row.binding_id;
}

/**
 * The licence a binding names in this product, or null. An alias (LX-03,
 * `dist_purchase_binding_aliases`) wins over the binding's own row: the binding of a licence
 * merged into another resolves to the survivor, so a purchase made or restored under it lands
 * there and not on the retired row.
 */
export async function licenseOfBinding(
  db: Db,
  product: string,
  bindingId: string | null,
): Promise<string | null> {
  if (!bindingId) return null;
  const alias = await db.first<{ license_id: string }>(
    "SELECT license_id FROM dist_purchase_binding_aliases WHERE product = ? AND binding_id = ?",
    product,
    bindingId,
  );
  if (alias) return alias.license_id;
  const row = await db.first<{ license_id: string }>(
    "SELECT license_id FROM dist_purchase_bindings WHERE product = ? AND binding_id = ?",
    product,
    bindingId,
  );
  return row?.license_id ?? null;
}

/**
 * LX-03: Distribution's share of a licence merge (`core/licenseMerge.ts`), in order:
 *
 *   1. aliases that already name the retired licence (it absorbed an earlier merge) re-point at
 *      the survivor, so a chain of merges resolves in one read;
 *   2. the retired licence's own binding becomes an alias of the survivor (its
 *      `dist_purchase_bindings` row is kept: the binding is not re-issued, and the survivor keeps
 *      its own binding for new purchases);
 *   3. every purchase recorded for the retired licence is re-keyed to the survivor, so a restore,
 *      a notification or a re-check of it acts on the survivor ("first licence wins" then names
 *      the survivor).
 *
 * Statements only and idempotent: a replayed merge re-writes the same rows.
 */
export function commerceMergeStatements(
  change: LicenseMergeChange,
): DbStatement[] {
  const { product, fromLicenseId: from, toLicenseId: to, now } = change;
  return [
    {
      sql: `UPDATE dist_purchase_binding_aliases SET license_id = ?
             WHERE product = ? AND license_id = ?`,
      params: [to, product, from],
    },
    {
      sql: `INSERT INTO dist_purchase_binding_aliases
              (product, binding_id, license_id, from_license_id, created_at)
            SELECT product, binding_id, ?, license_id, ?
              FROM dist_purchase_bindings WHERE product = ? AND license_id = ?
            ON CONFLICT (product, binding_id) DO UPDATE SET license_id = excluded.license_id`,
      params: [to, now, product, from],
    },
    {
      sql: `UPDATE dist_purchases SET license_id = ?
             WHERE product = ? AND license_id = ?`,
      params: [to, product, from],
    },
  ];
}

/**
 * Distribution's share of a licence deletion (`core/licenseDelete.ts`):
 *
 *   - blockers: any purchase recorded for the licence, whatever its state (active, pending,
 *     revoked or rejected) — a store transaction names it, so it is commerce history and the
 *     licence is disabled, never deleted;
 *   - statements: the licence's purchase binding and the aliases that resolve TO it. An alias
 *     whose `from_license_id` is the licence is the survivor's (an earlier merge retired this
 *     licence into it) and is kept, so purchases made under the old binding still reach the
 *     survivor. `dist_purchases` is deleted too, so the batch is complete whatever raced it.
 *
 * Run whatever Distribution's enablement: a purchase recorded while it was on still counts.
 */
export const commerceDeleteContribution: LicenseDeleteContributor = {
  async blockers(db, product, licenseIds) {
    const out = new Map<string, LicenseDeleteBlocker[]>();
    for (const batch of idChunks([...new Set(licenseIds)])) {
      const marks = batch.map(() => "?").join(", ");
      const rows = await db.all<{ license_id: string; n: number }>(
        `SELECT license_id, COUNT(*) AS n FROM dist_purchases
          WHERE product = ? AND license_id IN (${marks})
          GROUP BY license_id`,
        product,
        ...batch,
      );
      for (const r of rows)
        out.set(r.license_id, [
          {
            code: "store_purchases",
            message: `${r.n} store ${r.n === 1 ? "purchase is" : "purchases are"} recorded against it.`,
          },
        ]);
    }
    return out;
  },
  statements({ product, licenseId }) {
    return [
      "dist_purchase_bindings",
      "dist_purchase_binding_aliases",
      "dist_purchases",
    ].map(
      (table): DbStatement => ({
        sql: `DELETE FROM ${table} WHERE product = ? AND license_id = ?`,
        params: [product, licenseId],
      }),
    );
  },
};

// ── purchases ────────────────────────────────────────────────────────────────────────────────

export type PurchaseState = "active" | "pending" | "revoked";

export interface PurchaseRow {
  product: string;
  store: Store;
  purchase_key_hash: string;
  store_product_id: string;
  license_id: string;
  state: string;
  environment: string;
  first_seen: number;
  last_verified: number;
  detail_json: string;
}

/** What a store module verified. */
export interface VerifiedPurchase {
  store: Store;
  /** The store's purchase key (Apple originalTransactionId, Play purchase token, Steam
   *  `<steamid>:<dlcAppId>`). Hashed before it is stored. */
  purchaseKey: string;
  storeProductId: string;
  environment: string;
  state: PurchaseState;
  /** The binding the STORE's record carries, normalised; null when it carries none. */
  binding: string | null;
  /** Non-secret ids for re-checks (merged into `detail_json`). */
  detail: Record<string, unknown>;
}

export type RecordOutcome =
  | {
      ok: true;
      state: PurchaseState;
      flag: string;
      deliverable: string;
      licenseId: string;
      /** Whether the licence's grant changed (false for a replay). */
      changed: boolean;
      purchaseKeyHash: string;
    }
  | {
      ok: false;
      reason:
        | "unmapped"
        | "unbound"
        | "binding_mismatch"
        | "bound_elsewhere"
        | "license_disabled"
        | "no_license";
    };

export function getPurchase(
  db: Db,
  product: string,
  store: Store,
  hash: string,
): Promise<PurchaseRow | null> {
  return db.first<PurchaseRow>(
    "SELECT * FROM dist_purchases WHERE product = ? AND store = ? AND purchase_key_hash = ?",
    product,
    store,
    hash,
  );
}

export function parseDetail(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface RecordContext {
  db: Db;
  product: string;
  now: number;
  storeGrants: StoreGrantWriter | undefined;
  /** The caller's licence, for a device claim; absent for a notification or a re-check. */
  claimLicenseId?: string;
}

/** Turn one verified purchase into a recorded purchase and a grant change (see the header). */
export async function recordPurchase(
  ctx: RecordContext,
  p: VerifiedPurchase,
): Promise<RecordOutcome> {
  const { db, product, now } = ctx;
  if (!ctx.storeGrants) return { ok: false, reason: "license_disabled" };
  const hash = await purchaseKeyHash(p.store, p.purchaseKey);
  const existing = await getPurchase(db, product, p.store, hash);
  // A refund or revocation of a recorded purchase revokes EVERY grant it made, before the map is
  // consulted: the operator may have deleted or remapped the store product since the grant, and
  // neither may keep a refunded flag alive.
  if (p.state === "revoked" && existing) {
    if (
      ctx.claimLicenseId !== undefined &&
      ctx.claimLicenseId !== existing.license_id
    )
      return { ok: false, reason: "bound_elsewhere" };
    return (await revokeRecordedPurchase(ctx, p.store, hash, p.detail))!;
  }
  const mapping = await getStoreProduct(db, product, p.store, p.storeProductId);
  if (!mapping) return { ok: false, reason: "unmapped" };

  const bound = await licenseOfBinding(db, product, p.binding);
  let licenseId: string;
  if (existing) {
    licenseId = existing.license_id;
    // A store record that names another licence's binding than the one the purchase was first
    // bound to cannot move it.
    if (bound !== null && bound !== licenseId)
      return { ok: false, reason: "bound_elsewhere" };
  } else {
    if (bound === null) return { ok: false, reason: "unbound" };
    licenseId = bound;
  }
  if (ctx.claimLicenseId !== undefined && ctx.claimLicenseId !== licenseId)
    return {
      ok: false,
      reason: existing ? "bound_elsewhere" : "binding_mismatch",
    };

  const detail = {
    ...(existing ? parseDetail(existing.detail_json) : {}),
    ...p.detail,
  };
  await db.run(
    `INSERT INTO dist_purchases
       (product, store, purchase_key_hash, store_product_id, license_id, state, environment,
        first_seen, last_verified, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product, store, purchase_key_hash) DO UPDATE SET
       state = excluded.state, environment = excluded.environment,
       last_verified = excluded.last_verified, detail_json = excluded.detail_json`,
    product,
    p.store,
    hash,
    p.storeProductId,
    licenseId,
    p.state,
    p.environment,
    now,
    now,
    JSON.stringify(detail).slice(0, 8192),
  );

  let changed = false;
  if (p.state === "active" || p.state === "revoked") {
    const outcome = await ctx.storeGrants({
      licenseId,
      flag: mapping.flag,
      store: p.store,
      purchaseKeyHash: hash,
      action: p.state === "active" ? "grant" : "revoke",
      summary: `${p.state === "active" ? "Granted" : "Revoked"} ${mapping.flag} (${p.store} product ${p.storeProductId}, ${p.environment})`,
    });
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    changed = outcome.changed;
  }
  return {
    ok: true,
    state: p.state,
    flag: mapping.flag,
    deliverable: mapping.deliverable_id,
    licenseId,
    changed,
    purchaseKeyHash: hash,
  };
}

/**
 * Revoke an already-recorded purchase by its hash (a voided Play purchase, a Steam non-owner):
 * the purchase row moves to `revoked` and the licence's grant is revoked. `null` when no such
 * purchase is recorded (nothing to revoke).
 */
export async function revokeRecordedPurchase(
  ctx: Omit<RecordContext, "claimLicenseId">,
  store: Store,
  hash: string,
  detail: Record<string, unknown>,
): Promise<RecordOutcome | null> {
  const row = await getPurchase(ctx.db, ctx.product, store, hash);
  if (!row) return null;
  if (!ctx.storeGrants) return { ok: false, reason: "license_disabled" };
  const mapping = await getStoreProduct(
    ctx.db,
    ctx.product,
    store,
    row.store_product_id,
  );
  await ctx.db.run(
    `UPDATE dist_purchases SET state = 'revoked', last_verified = ?, detail_json = ?
      WHERE product = ? AND store = ? AND purchase_key_hash = ?`,
    ctx.now,
    JSON.stringify({ ...parseDetail(row.detail_json), ...detail }).slice(
      0,
      8192,
    ),
    ctx.product,
    store,
    hash,
  );
  // Every active grant this purchase made, by its hash — never the CURRENT mapping's flag, which
  // the operator may have deleted or changed since the grant.
  const flags = (
    await ctx.db.all<{ flag: string }>(
      `SELECT flag FROM license_store_grants
        WHERE product = ? AND store = ? AND purchase_key_hash = ? AND state = 'active'`,
      ctx.product,
      store,
      hash,
    )
  ).map((r) => r.flag);
  let changed = false;
  for (const flag of flags) {
    const outcome = await ctx.storeGrants({
      licenseId: row.license_id,
      flag,
      store,
      purchaseKeyHash: hash,
      action: "revoke",
      summary: `Revoked ${flag} (${store} product ${row.store_product_id}, ${row.environment})`,
    });
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    changed ||= outcome.changed;
  }
  return {
    ok: true,
    state: "revoked",
    flag: flags[0] ?? mapping?.flag ?? "",
    deliverable: mapping?.deliverable_id ?? "",
    licenseId: row.license_id,
    changed,
    purchaseKeyHash: hash,
  };
}

/** Purchases due a re-check: `active` (or `pending`) ones last verified before `before`. */
export function purchasesToRecheck(
  db: Db,
  product: string,
  store: Store,
  opts: { before: number; states: readonly PurchaseState[]; limit: number },
): Promise<PurchaseRow[]> {
  const placeholders = opts.states.map(() => "?").join(", ");
  return db.all<PurchaseRow>(
    `SELECT * FROM dist_purchases
      WHERE product = ? AND store = ? AND state IN (${placeholders}) AND last_verified < ?
      ORDER BY last_verified LIMIT ?`,
    product,
    store,
    ...opts.states,
    opts.before,
    opts.limit,
  );
}

/** Recent purchases for the console (no purchase key, no token). */
export async function recentPurchases(
  db: Db,
  product: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const rows = await db.all<PurchaseRow>(
    "SELECT * FROM dist_purchases WHERE product = ? ORDER BY last_verified DESC LIMIT ?",
    product,
    limit,
  );
  return rows.map((r) => ({
    store: r.store,
    purchase: r.purchase_key_hash.slice(0, 16),
    storeProductId: r.store_product_id,
    licenseId: r.license_id,
    state: r.state,
    environment: r.environment,
    firstSeen: r.first_seen,
    lastVerified: r.last_verified,
  }));
}
