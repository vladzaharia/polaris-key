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
import {
  sha256Hex,
  type Db,
  type DbStatement,
} from "../../../core/platform.js";
import type { LicenseMergeChange } from "../../../core/licenseMerge.js";
import {
  idChunks,
  LicenseDeleteReason,
  type LicenseDeleteBlocker,
  type LicenseDeleteContributor,
} from "../../../core/licenseDelete.js";
import type { Store, StoreGrantWriter } from "../../../core/storeGrants.js";

// ── hashing ──────────────────────────────────────────────────────────────────────────────────

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
  await db.batch([
    {
      sql: `INSERT INTO dist_store_products
              (product, store, store_product_id, deliverable_id, flag, source, modified_at, modified_by)
            VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)
            ON CONFLICT (product, store, store_product_id) DO UPDATE SET
              deliverable_id = excluded.deliverable_id, flag = excluded.flag,
              modified_at = excluded.modified_at, modified_by = excluded.modified_by`,
      params: [
        row.product,
        row.store,
        row.store_product_id,
        row.deliverable_id,
        row.flag,
        row.modified_at,
        row.modified_by,
      ],
    },
    // LX-08: the mapping's entitlement rows follow its flag in the same batch.
    ...storeProductEntitlementStatements(row.product, {
      store: row.store,
      storeProductId: row.store_product_id,
    }),
  ]);
}

export async function deleteStoreProduct(
  db: Db,
  product: string,
  store: Store,
  storeProductId: string,
): Promise<number> {
  const statements: DbStatement[] = [
    {
      sql: "DELETE FROM dist_store_products WHERE product = ? AND store = ? AND store_product_id = ?",
      params: [product, store, storeProductId],
    },
    ...storeProductEntitlementStatements(product, { store, storeProductId }),
  ];
  if (db.batchChanges) return (await db.batchChanges(statements))[0] ?? 0;
  const n = await db.runChanges(statements[0]!.sql, ...statements[0]!.params);
  await db.batch(statements.slice(1));
  return n;
}

// ── the licensing model's dual-write (LX-08, plans/LX-01.md §6.1–6.2) ─────────────────────────

/**
 * Make `dist_store_product_entitlements` agree with `dist_store_products.flag` for one mapping, or
 * every mapping of the product: while `flag` is a mapping's one key (until LX-11 maps several),
 * its entitlement rows are exactly `{flag: true}`, and a deleted mapping keeps none. Idempotent.
 * The same projection as migrations/0105_m.
 */
export function storeProductEntitlementStatements(
  product: string,
  mapping: { store: Store; storeProductId: string } | null,
): DbStatement[] {
  const scope = mapping ? " AND store = ? AND store_product_id = ?" : "";
  const scopeParams = mapping ? [mapping.store, mapping.storeProductId] : [];
  return [
    {
      sql: `DELETE FROM dist_store_product_entitlements
             WHERE product = ?${scope}
               AND NOT EXISTS (SELECT 1 FROM dist_store_products m
                                WHERE m.product = dist_store_product_entitlements.product
                                  AND m.store = dist_store_product_entitlements.store
                                  AND m.store_product_id = dist_store_product_entitlements.store_product_id
                                  AND m.flag = dist_store_product_entitlements.key)`,
      params: [product, ...scopeParams],
    },
    {
      sql: `INSERT INTO dist_store_product_entitlements
              (product, store, store_product_id, key, value_json)
            SELECT product, store, store_product_id, flag, 'true'
              FROM dist_store_products
             WHERE product = ?${scope}
            ON CONFLICT (product, store, store_product_id, key) DO NOTHING`,
      params: [product, ...scopeParams],
    },
  ];
}

/**
 * Name the grant a purchase made on its `dist_purchases` row (`grant_id`), for one purchase or
 * every purchase of the product: the grant License's write projected (`core/grants.ts`
 * `storeGrantId`), once it exists. A purchase that granted nothing (pending, rejected) keeps NULL.
 * Idempotent.
 */
export function purchaseGrantIdStatements(
  product: string,
  purchase: { store: Store; purchaseKeyHash: string } | null,
): DbStatement[] {
  const scope = purchase ? " AND store = ? AND purchase_key_hash = ?" : "";
  const scopeParams = purchase
    ? [purchase.store, purchase.purchaseKeyHash]
    : [];
  const id = "'grt_s_' || store || '_' || purchase_key_hash";
  return [
    {
      sql: `UPDATE dist_purchases SET grant_id = ${id}
             WHERE product = ?${scope}
               AND grant_id IS NOT (${id})
               AND EXISTS (SELECT 1 FROM grants g
                            WHERE g.product = dist_purchases.product
                              AND g.id = 'grt_s_' || dist_purchases.store || '_' || dist_purchases.purchase_key_hash)`,
      params: [product, ...scopeParams],
    },
  ];
}

/**
 * Distribution's share of the licensing catch-up (`ServiceDescriptor.licensingReconcile`,
 * `core/licensingCatchUp.ts`): re-project every purchase's `grant_id` and every mapping's
 * entitlement rows, so rows a pre-LX-08 Worker wrote between the migration and the deploy catch
 * up. Run whatever Distribution's enablement, like the licence merge.
 */
export function commerceLicensingReconcile(product: string): DbStatement[] {
  return [
    ...purchaseGrantIdStatements(product, null),
    ...storeProductEntitlementStatements(product, null),
  ];
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
 *     survivor. `dist_purchases` is never deleted: `blockerCheck` guards the batch with it.
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
            code: LicenseDeleteReason.StorePurchases,
            message: `${r.n} store ${r.n === 1 ? "purchase is" : "purchases are"} recorded against it.`,
          },
        ]);
    }
    return out;
  },
  blockerCheck: ({ product, licenseId }) => ({
    sql: "SELECT 1 FROM dist_purchases WHERE product = ? AND license_id = ?",
    params: [product, licenseId],
  }),
  statements({ product, licenseId }) {
    return ["dist_purchase_bindings", "dist_purchase_binding_aliases"].map(
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
    // LX-08: the purchase names the grant License's write just projected.
    await db.batch(
      purchaseGrantIdStatements(product, {
        store: p.store,
        purchaseKeyHash: hash,
      }),
    );
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
  // LX-08: as in `recordPurchase` (a revoked purchase keeps naming its grant).
  if (flags.length > 0)
    await ctx.db.batch(
      purchaseGrantIdStatements(ctx.product, { store, purchaseKeyHash: hash }),
    );
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
