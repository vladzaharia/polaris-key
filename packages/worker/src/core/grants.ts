/**
 * Grants — the licensing model's reasons to hold entitlements (LX-08; plans/LX-01.md §6.1–6.2,
 * notes/S-19 §7.2 and §7.14 steps 1–4). The one writer of the Core tables `grants` and
 * `grant_entitlements` (AGENTS.md rule 6: Commerce reaches it through License's `applyStoreGrant`,
 * Identity's sign-in writer and Core's catch-up call it directly).
 *
 * This is the EXPAND step. Reads stay on the old objects until LX-09, so nothing here changes what
 * a device receives:
 *
 *   - **Store grants are dual-written.** `license_store_grants` stays the source the licence
 *     document reads (`core/storeGrants.ts`). Each of its writes re-projects the purchase into one
 *     licence-held grant in the same batch ({@link storeGrantProjection}); the projection is a pure
 *     function of the old rows, so the new rows cannot drift from them, and running it again (the
 *     migration, the catch-up after the deploy) converges instead of duplicating.
 *   - **OIDC-provisioned entitlement keys MOVE.** They leave `licenses.overrides_json` and become
 *     the licence's `oidc` grant (`grt_oidc_<license_id>`, each entry's state, value and
 *     `updatedAt` copied), so they can no longer be mistaken for an operator's override. Because
 *     they leave the column, the licence document must read the grant where they used to sit:
 *     {@link oidcGrantLayer} is the one read this package adds (`core/payload.ts`). A sign-in moves
 *     its own licence (`services/identity/oidc.ts`); {@link moveProvisionedKeys} moves the rest.
 *
 * ── WHY THE OIDC LAYER SITS AFTER THE LICENCE OVERRIDES ─────────────────────────────────────
 *
 * The plan names the layer "between the store layer and the licence overrides". With disjoint keys
 * that is the same VALUE either way, but not the same BYTES: `mergeMap` appends a key it has not
 * seen, so a key's position in the signed document's `entitlements` (and in the ETag material)
 * follows the layer that introduced it. LX-02's sign-in writer re-appends the declared keys at the
 * END of `overrides_json.entitlements` on every sign-in, so in the steady state the provisioned
 * keys follow every operator key. Rendering the grant right after the licence overrides, minus any
 * key the overrides carry (an operator's override still wins, as it did), reproduces exactly that
 * order. A licence whose column is NOT in that order (an operator added a key after its last
 * sign-in) would change key order if moved, so the background move defers it to its next sign-in
 * ({@link planProvisionedMove}), which rewrites the document anyway.
 */

import type { ManagedEntry } from "@polaris-key/protocol";
import type { Db, DbParam, DbStatement } from "../db/types.js";
import { STORES, type Store } from "./storeGrants.js";
// The `entitlement_events` subject store registers with the model's tables (`core/subjectHooks.ts`).
import "./entitlementEvents.js";

// ── vocabulary ───────────────────────────────────────────────────────────────────────────────

/** `grants.source` (trigger `trg_grants_source_{ins,upd}`). `polaris-key` is a sale through
 *  Polaris Key itself (S-21 D9); nothing writes it before CM-05. */
export const GRANT_SOURCES = [
  "app-store",
  "play",
  "steam",
  "polaris-key",
  "comp",
  "trial",
  "bundle",
  "redeem",
  "oidc",
] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

/** `grants.state` (trigger `trg_grants_state_{ins,upd}`). */
export const GRANT_STATES = [
  "active",
  "past_due",
  "revoked",
  "refunded",
  "suppressed",
] as const;
export type GrantState = (typeof GRANT_STATES)[number];

/** The grant a store purchase makes: derived from the purchase, so every writer agrees on it. */
export function storeGrantId(store: Store, purchaseKeyHash: string): string {
  return `grt_s_${store}_${purchaseKeyHash}`;
}

/** The grant holding one licence's OIDC-provisioned entitlement keys. */
export function oidcGrantId(licenseId: string): string {
  return `grt_oidc_${licenseId}`;
}

/** Who wrote a grant row (`created_by`, `modified_by`). */
export type GrantWriter = "migration" | "commerce" | "oidc";

// ── store grants: the projection of `license_store_grants` ──────────────────────────────────

const STORE_SOURCES_SQL = STORES.map((s) => `'${s}'`).join(", ");

/** A flag row counts when it is active, or when its purchase has no active row at all (a revoked
 *  grant keeps every key it granted, as history). */
const COUNTS = `(s.state = 'active'
   OR NOT EXISTS (SELECT 1 FROM license_store_grants a
                   WHERE a.product = s.product AND a.store = s.store
                     AND a.purchase_key_hash = s.purchase_key_hash AND a.state = 'active'))`;

/** One purchase, or every purchase of the product. */
export interface StorePurchaseRef {
  store: Store;
  purchaseKeyHash: string;
}

/**
 * The statements that make `grants` and `grant_entitlements` agree with `license_store_grants`
 * for one purchase (`purchase` given) or for every purchase of `product`: one licence-held grant
 * per purchase and one key per counting flag row (see migrations/0105_m for the rules). Upserts
 * that change nothing when the rows already agree, so they are safe to run in every store-grant
 * write's batch and again in any catch-up. `writer` stamps `created_by` on a new grant and
 * `modified_by` on a changed one.
 *
 * Read-only on License's and Distribution's tables: the sku is the purchase's `store_product_id`,
 * which Distribution records before it asks License for the grant and never changes.
 */
export function storeGrantProjection(
  product: string,
  purchase: StorePurchaseRef | null,
  writer: GrantWriter,
): DbStatement[] {
  const scope = purchase ? " AND s.store = ? AND s.purchase_key_hash = ?" : "";
  const scopeParams: DbParam[] = purchase
    ? [purchase.store, purchase.purchaseKeyHash]
    : [];
  const grantScope = purchase ? " AND grant_entitlements.grant_id = ?" : "";
  const grantScopeParams: DbParam[] = purchase
    ? [storeGrantId(purchase.store, purchase.purchaseKeyHash)]
    : [];
  return [
    {
      sql: `INSERT INTO grants
              (product, id, account_id, license_id, store_identity_hash, source, external_ref_hash,
               sku, order_ref, state, granted_at, expires_at, grace_until, shared, trial,
               created_by, modified_at, modified_by)
            SELECT s.product, 'grt_s_' || s.store || '_' || s.purchase_key_hash, NULL,
                   MIN(s.license_id), NULL, s.store, s.purchase_key_hash,
                   (SELECT p.store_product_id FROM dist_purchases p
                     WHERE p.product = s.product AND p.store = s.store
                       AND p.purchase_key_hash = s.purchase_key_hash),
                   NULL,
                   CASE WHEN MAX(s.state = 'active') = 1 THEN 'active' ELSE 'revoked' END,
                   MIN(s.granted_at), NULL, NULL, 0, 0, ?,
                   MAX(MAX(s.granted_at), COALESCE(MAX(s.revoked_at), 0)), ?
              FROM license_store_grants s
             WHERE s.product = ?${scope}
             GROUP BY s.product, s.store, s.purchase_key_hash
            ON CONFLICT (product, id) DO UPDATE SET
              license_id = excluded.license_id,
              sku = COALESCE(excluded.sku, grants.sku),
              state = excluded.state,
              granted_at = excluded.granted_at,
              modified_at = excluded.modified_at,
              modified_by = excluded.modified_by
            WHERE grants.license_id IS NOT excluded.license_id
               OR grants.sku IS NOT COALESCE(excluded.sku, grants.sku)
               OR grants.state IS NOT excluded.state
               OR grants.granted_at IS NOT excluded.granted_at
               OR grants.modified_at IS NOT excluded.modified_at`,
      params: [writer, writer, product, ...scopeParams],
    },
    {
      sql: `DELETE FROM grant_entitlements
             WHERE product = ?${grantScope}
               AND grant_id IN (SELECT g.id FROM grants g
                                 WHERE g.product = grant_entitlements.product
                                   AND g.source IN (${STORE_SOURCES_SQL}))
               AND NOT EXISTS (
                 SELECT 1 FROM license_store_grants s
                  WHERE s.product = grant_entitlements.product
                    AND 'grt_s_' || s.store || '_' || s.purchase_key_hash = grant_entitlements.grant_id
                    AND s.flag = grant_entitlements.key
                    AND ${COUNTS})`,
      params: [product, ...grantScopeParams],
    },
    {
      sql: `INSERT INTO grant_entitlements (product, grant_id, key, value_json, state, updated_at)
            SELECT s.product, 'grt_s_' || s.store || '_' || s.purchase_key_hash, s.flag, 'true',
                   'default', s.granted_at
              FROM license_store_grants s
             WHERE s.product = ?${scope} AND ${COUNTS}
            ON CONFLICT (product, grant_id, key) DO UPDATE SET
              value_json = excluded.value_json,
              state = excluded.state,
              updated_at = excluded.updated_at
            WHERE grant_entitlements.value_json IS NOT excluded.value_json
               OR grant_entitlements.state IS NOT excluded.state
               OR grant_entitlements.updated_at IS NOT excluded.updated_at`,
      params: [product, ...scopeParams],
    },
  ];
}

/**
 * LX-03's licence merge, for the grants: every store grant the retired licence holds moves to the
 * survivor with its `license_store_grants` rows (License's `storeGrantMergeStatements`), so the
 * projection stays exact. Only store-sourced grants move, exactly as the old rows do: the retired
 * licence's own `overrides_json` (and therefore its `oidc` grant) stays on it.
 */
export function grantMergeStatements(change: {
  product: string;
  fromLicenseId: string;
  toLicenseId: string;
}): DbStatement[] {
  return [
    {
      sql: `UPDATE grants SET license_id = ?
             WHERE product = ? AND license_id = ? AND source IN (${STORE_SOURCES_SQL})`,
      params: [change.toLicenseId, change.product, change.fromLicenseId],
    },
  ];
}

/**
 * A deleted licence's grants, their keys and its holder version (`core/licenseDelete.ts`). A
 * licence holding a store grant is never deleted (License's blocker), so in practice this is its
 * `oidc` grant.
 */
export function licenseGrantDeleteStatements(target: {
  product: string;
  licenseId: string;
}): DbStatement[] {
  const { product, licenseId } = target;
  return [
    {
      sql: `DELETE FROM grant_entitlements
             WHERE product = ? AND grant_id IN (SELECT id FROM grants WHERE product = ? AND license_id = ?)`,
      params: [product, product, licenseId],
    },
    {
      sql: "DELETE FROM grants WHERE product = ? AND license_id = ?",
      params: [product, licenseId],
    },
    {
      sql: "DELETE FROM holder_versions WHERE product = ? AND holder_kind = 'license' AND holder_id = ?",
      params: [product, licenseId],
    },
    {
      sql: "DELETE FROM entitlement_events WHERE product = ? AND license_id = ?",
      params: [product, licenseId],
    },
  ];
}

/**
 * A soft-deleted product's account- and store-held licensing rows (`admin/repo.ts`
 * `deleteProduct`, R11-09: a deleted product keeps the shape of its licences, not the people). The
 * licence-held grants stay with the licence rows they belong to.
 */
export function productGrantErasureStatements(product: string): DbStatement[] {
  const personal = `SELECT id FROM grants WHERE product = ?
                     AND (account_id IS NOT NULL OR store_identity_hash IS NOT NULL)`;
  return [
    {
      sql: `DELETE FROM grant_entitlements WHERE product = ? AND grant_id IN (${personal})`,
      params: [product, product],
    },
    {
      sql: `DELETE FROM grants WHERE product = ?
             AND (account_id IS NOT NULL OR store_identity_hash IS NOT NULL)`,
      params: [product],
    },
    {
      sql: "DELETE FROM holder_versions WHERE product = ? AND holder_kind IN ('account', 'store')",
      params: [product],
    },
    {
      sql: "DELETE FROM device_store_identities WHERE product = ?",
      params: [product],
    },
    {
      sql: "DELETE FROM entitlement_events WHERE product = ?",
      params: [product],
    },
  ];
}

// ── the oidc grant ───────────────────────────────────────────────────────────────────────────

/** A guard every statement of an `oidc` grant write is conditioned on: the licence's
 *  `overrides_json` is still the value the write was planned from. */
export interface OverridesGuard {
  product: string;
  licenseId: string;
  overridesJson: string | null;
}

function guardSql(guard: OverridesGuard | null): {
  sql: string;
  params: DbParam[];
} {
  if (!guard) return { sql: "1", params: [] };
  return {
    sql: "EXISTS (SELECT 1 FROM licenses WHERE product = ? AND id = ? AND overrides_json IS ?)",
    params: [guard.product, guard.licenseId, guard.overridesJson],
  };
}

/**
 * A single-row `INSERT … VALUES (…)` (an audit row, say) conditioned on the same guard as the
 * `oidc` grant statements, so it lands with the guarded write or not at all.
 */
export function guardedInsert(
  insert: DbStatement,
  guard: OverridesGuard,
): DbStatement {
  const m = /^([\s\S]*?)\bVALUES\s*\(([\s\S]*)\)\s*$/.exec(insert.sql);
  if (!m)
    throw new Error("guardedInsert: not a single-row INSERT … VALUES (…)");
  const g = guardSql(guard);
  return {
    sql: `${m[1]}SELECT ${m[2]} WHERE ${g.sql}`,
    params: [...insert.params, ...g.params],
  };
}

/**
 * Write the `oidc` grant of one licence: the grant row (created on first use, kept `active`), and
 * for every key in `declared` the entry `entries` carries, or none (a declared key whose claim
 * disappeared is removed: revocation on claim loss, as LX-02's rewrite did). A key the grant holds
 * that is NOT declared any more (its hook was removed) is left alone, as LX-02 left such a key in
 * the column. `guard` conditions every statement on the licence's column, so the grant and the
 * column's own compare-and-set write land together or not at all; `null` writes unconditionally
 * (the licence row is new, or written in the same batch without a condition).
 */
export function oidcGrantStatements(args: {
  product: string;
  licenseId: string;
  entries: Record<string, ManagedEntry>;
  declared: Iterable<string>;
  now: number;
  writer: GrantWriter;
  guard: OverridesGuard | null;
}): DbStatement[] {
  const { product, licenseId, entries, now, writer } = args;
  const id = oidcGrantId(licenseId);
  const guard = guardSql(args.guard);
  const declared = [...new Set(args.declared)].sort();
  const out: DbStatement[] = [];
  if (Object.keys(entries).length > 0)
    out.push({
      sql: `INSERT INTO grants
              (product, id, account_id, license_id, store_identity_hash, source, external_ref_hash,
               sku, order_ref, state, granted_at, expires_at, grace_until, shared, trial,
               created_by, modified_at, modified_by)
            SELECT ?, ?, NULL, ?, NULL, 'oidc', NULL, NULL, NULL, 'active', ?, NULL, NULL, 0, 0,
                   ?, ?, ?
             WHERE ${guard.sql}
            ON CONFLICT (product, id) DO UPDATE SET
              state = 'active', modified_at = excluded.modified_at,
              modified_by = excluded.modified_by`,
      params: [
        product,
        id,
        licenseId,
        now,
        writer,
        now,
        writer,
        ...guard.params,
      ],
    });
  // The declared keys bind as ONE JSON parameter: D1 binds at most 100 per statement, and a
  // product may declare more keys than that.
  if (declared.length > 0)
    out.push({
      sql: `DELETE FROM grant_entitlements
             WHERE product = ? AND grant_id = ?
               AND key IN (SELECT value FROM json_each(?))
               AND ${guard.sql}`,
      params: [product, id, JSON.stringify(declared), ...guard.params],
    });
  for (const key of Object.keys(entries).sort()) {
    const e = entries[key]!;
    out.push({
      sql: `INSERT INTO grant_entitlements (product, grant_id, key, value_json, state, updated_at)
            SELECT ?, ?, ?, ?, ?, ?
             WHERE ${guard.sql}
            ON CONFLICT (product, grant_id, key) DO UPDATE SET
              value_json = excluded.value_json, state = excluded.state,
              updated_at = excluded.updated_at`,
      params: [
        product,
        id,
        key,
        JSON.stringify(e.value),
        e.state,
        e.updatedAt ?? 0,
        ...guard.params,
      ],
    });
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The entitlement keys a stored overrides column carries, in its order (none when it does not
 *  parse as an object, as `mergePayloads` reads it). */
function overrideEntitlements(
  overridesJson: string | null | undefined,
): Record<string, unknown> {
  if (!overridesJson) return {};
  try {
    const p: unknown = JSON.parse(overridesJson);
    if (!isRecord(p) || !isRecord(p.entitlements)) return {};
    return p.entitlements;
  } catch {
    return {};
  }
}

/** One stored entry of an `oidc` grant. */
interface GrantEntryRow {
  key: string;
  value_json: string;
  state: string;
  updated_at: number;
}

async function activeOidcEntries(
  db: Db,
  product: string,
  licenseId: string,
): Promise<GrantEntryRow[]> {
  return db.all<GrantEntryRow>(
    `SELECT ge.key, ge.value_json, ge.state, ge.updated_at
       FROM grants g JOIN grant_entitlements ge
         ON ge.product = g.product AND ge.grant_id = g.id
      WHERE g.product = ? AND g.id = ? AND g.license_id = ? AND g.state = 'active'
      ORDER BY ge.key`,
    product,
    oidcGrantId(licenseId),
    licenseId,
  );
}

/**
 * The licence's `oidc` grant as a stored-payload layer (`core/payload.ts`), merged right after the
 * licence's own overrides: every entry of its active `oidc` grant, in key order, except a key the
 * overrides themselves carry (an operator's override of a provisioned key wins, as it did while
 * the provisioned value sat in the same column). `null` when there is nothing to add. See the file
 * header for why this position reproduces the documents byte for byte.
 */
export async function oidcGrantLayer(
  db: Db,
  product: string,
  licenseId: string,
  overridesJson: string | null,
): Promise<string | null> {
  const rows = await activeOidcEntries(db, product, licenseId);
  if (rows.length === 0) return null;
  const shadowed = overrideEntitlements(overridesJson);
  const entitlements: Record<string, ManagedEntry> = {};
  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(shadowed, r.key)) continue;
    let value: ManagedEntry["value"];
    try {
      value = JSON.parse(r.value_json) as ManagedEntry["value"];
    } catch {
      continue;
    }
    entitlements[r.key] = {
      state: r.state as ManagedEntry["state"],
      value,
      updatedAt: r.updated_at,
    };
  }
  if (Object.keys(entitlements).length === 0) return null;
  return JSON.stringify({ entitlements });
}

// ── the provisioned-keys move (§7.14 step 4) ────────────────────────────────────────────────

/** What moving one licence's provisioned keys would write. */
export interface ProvisionedMovePlan {
  /** The column without the moved keys (every other member and key kept, in order). */
  overridesJson: string;
  /** The moved entries, exactly as the column held them. */
  entries: Record<string, ManagedEntry>;
  /**
   * Whether the move leaves every document of the licence byte-identical: the moved keys end
   * the column's entitlements and, merged with the grant's other keys in key order, keep their
   * place, and each moved entry is stored exactly as the grant renders it (`{state, value,
   * updatedAt}`, as LX-02's writer stores it). A move that is not exact is left to the licence's
   * next sign-in, which rewrites its documents anyway.
   */
  exact: boolean;
}

function isManagedEntry(v: unknown): v is ManagedEntry {
  return (
    isRecord(v) &&
    (v.state === "default" || v.state === "enforced" || v.state === "hidden") &&
    "value" in v &&
    (v.updatedAt === undefined || typeof v.updatedAt === "number")
  );
}

/**
 * Plan the move of one licence's provisioned entitlement keys out of its overrides column (pure).
 * `declared` is every `entitlement_key` the product's provisioning hooks name; `grantKeys` the
 * keys its active `oidc` grant already holds. `null` when the column carries no declared key (or
 * does not parse, or a declared key's stored entry is not a managed entry: such a column is left
 * exactly as it is).
 */
export function planProvisionedMove(
  overridesJson: string | null,
  declared: ReadonlySet<string>,
  grantKeys: readonly string[],
): ProvisionedMovePlan | null {
  if (!overridesJson) return null;
  let parsed: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(overridesJson);
    if (!isRecord(p)) return null;
    parsed = p;
  } catch {
    return null;
  }
  if (!isRecord(parsed.entitlements)) return null;
  const column = parsed.entitlements;
  const order = Object.keys(column);
  const moved = order.filter((k) => declared.has(k));
  if (moved.length === 0) return null;
  const entries: Record<string, ManagedEntry> = {};
  for (const k of moved) {
    const e = column[k];
    if (!isManagedEntry(e)) return null;
    entries[k] = e;
  }
  const kept: Record<string, unknown> = {};
  for (const k of order) if (!declared.has(k)) kept[k] = column[k];

  // The key order the merge sees from these two layers, before and after.
  const keptOrder = Object.keys(kept);
  const own = (o: Record<string, unknown>, k: string) =>
    Object.prototype.hasOwnProperty.call(o, k);
  const before = [...order, ...grantKeys.filter((k) => !own(column, k)).sort()];
  const after = [
    ...keptOrder,
    ...[...new Set([...grantKeys, ...moved])]
      .filter((k) => !own(kept, k))
      .sort(),
  ];
  // The grant renders each entry as `{state, value, updatedAt}` (`oidcGrantLayer`): an entry stored
  // in any other shape (members in another order, no `updatedAt`) would change bytes when moved.
  const canonical = moved.every((k) => {
    const e = entries[k]!;
    return (
      typeof e.updatedAt === "number" &&
      JSON.stringify(column[k]) ===
        JSON.stringify({
          state: e.state,
          value: e.value,
          updatedAt: e.updatedAt,
        })
    );
  });
  const exact =
    canonical &&
    before.length === after.length &&
    before.every((k, i) => k === after[i]);
  return {
    overridesJson: JSON.stringify({ ...parsed, entitlements: kept }),
    entries,
    exact,
  };
}

/** The outcome of one {@link moveProvisionedKeys} pass. */
export interface ProvisionedMoveReport {
  /** Licences whose provisioned keys moved to their `oidc` grant. */
  moved: number;
  /** Licences left for their next sign-in: moving them would reorder a document's keys. */
  deferred: number;
  /** Licences whose column changed between the read and the write (moved on a later pass). */
  raced: number;
  /** Whether the pass stopped at its budget with licences still to look at. */
  more: boolean;
}

/** Licences read per page. */
const MOVE_PAGE = 200;

/**
 * Move every OIDC licence's provisioned entitlement keys to its `oidc` grant (§7.14 step 4, the
 * deploy-hook job `licensing.migrateProvisioned`). A sign-in moves its own licence; this moves the
 * rest. Only licences with a `sub` (the ones the sign-in writer owns) are touched: on any other
 * licence a declared key is an operator's override, and it stays in the column. Stateless and idempotent: a moved licence no longer matches, so a pass that stopped at its
 * budget, or ran twice at once, simply continues. Each licence is one batch, guarded by its column
 * (compare-and-set): the grant and the column change together or not at all, and a column an
 * operator or a sign-in changed in between is left for the next pass.
 *
 * Only exact moves are made ({@link planProvisionedMove}): no document changes by a single byte, so
 * `licenses.modified_at` is NOT bumped (it is the `updatedAt` of the injected policy entries).
 * `budget` caps the licences examined in one pass.
 */
export async function moveProvisionedKeys(
  db: Db,
  now: number,
  budget = 2_000,
): Promise<ProvisionedMoveReport> {
  const report: ProvisionedMoveReport = {
    moved: 0,
    deferred: 0,
    raced: 0,
    more: false,
  };
  const hooks = await db.all<{ product: string; entitlement_key: string }>(
    `SELECT DISTINCT product, entitlement_key FROM provisioning_config
      WHERE entitlement_key IS NOT NULL ORDER BY product`,
  );
  const declaredBy = new Map<string, Set<string>>();
  for (const h of hooks) {
    const set = declaredBy.get(h.product) ?? new Set<string>();
    set.add(h.entitlement_key);
    declaredBy.set(h.product, set);
  }
  let examined = 0;
  for (const [product, declared] of declaredBy) {
    // One JSON parameter, not one per key (D1 binds at most 100 per statement).
    const declaredJson = JSON.stringify([...declared]);
    let after = "";
    for (;;) {
      if (examined >= budget) {
        report.more = true;
        return report;
      }
      // Only OIDC licences (`sub` set): the sign-in writer owns their declared keys, so a declared
      // key in their column is a provisioned value. On any other licence (an admin or enrolled
      // licence nobody signed in to) the same key is an operator's override and stays put.
      const rows = await db.all<{ id: string; overrides_json: string }>(
        `SELECT id, overrides_json FROM licenses
          WHERE product = ? AND id > ? AND sub IS NOT NULL AND overrides_json IS NOT NULL
            AND json_valid(overrides_json)
            AND json_type(overrides_json, '$.entitlements') = 'object'
            AND EXISTS (SELECT 1 FROM json_each(overrides_json, '$.entitlements') je
                         WHERE je.key IN (SELECT value FROM json_each(?)))
          ORDER BY id LIMIT ?`,
        product,
        after,
        declaredJson,
        Math.min(MOVE_PAGE, budget - examined),
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        examined++;
        after = row.id;
        const grantKeys = (await activeOidcEntries(db, product, row.id)).map(
          (r) => r.key,
        );
        const plan = planProvisionedMove(
          row.overrides_json,
          declared,
          grantKeys,
        );
        if (!plan) continue;
        if (!plan.exact) {
          report.deferred++;
          continue;
        }
        const guard: OverridesGuard = {
          product,
          licenseId: row.id,
          overridesJson: row.overrides_json,
        };
        const applied = await guardedWrite(
          db,
          [
            ...oidcGrantStatements({
              product,
              licenseId: row.id,
              entries: plan.entries,
              declared: Object.keys(plan.entries),
              now,
              writer: "migration",
              guard,
            }),
          ],
          {
            sql: `UPDATE licenses SET overrides_json = ?
                   WHERE product = ? AND id = ? AND overrides_json IS ?`,
            params: [plan.overridesJson, product, row.id, row.overrides_json],
          },
          { product, licenseId: row.id, overridesJson: plan.overridesJson },
        );
        if (applied) report.moved++;
        else report.raced++;
      }
    }
  }
  return report;
}

/**
 * Run `guarded` (statements conditioned on the licence's column) and then `cas` (the column's own
 * compare-and-set, LAST so the guards still see the value they were planned from) in ONE batch,
 * and answer whether the compare-and-set applied. Both conditions are the same, so either all of
 * it lands or none of it does. `expect` is the column the write leaves, for an engine without
 * per-statement change counts.
 */
export async function guardedWrite(
  db: Db,
  guarded: DbStatement[],
  cas: DbStatement,
  expect: { product: string; licenseId: string; overridesJson: string },
): Promise<boolean> {
  const statements = [...guarded, cas];
  if (db.batchChanges) {
    const changes = await db.batchChanges(statements);
    return (changes[changes.length - 1] ?? 0) > 0;
  }
  await db.batch(statements);
  const row = await db.first<{ overrides_json: string | null }>(
    "SELECT overrides_json FROM licenses WHERE product = ? AND id = ?",
    expect.product,
    expect.licenseId,
  );
  return row?.overrides_json === expect.overridesJson;
}

// ── reconciliation (the dual-write's drift check; LX-16's zero-drift report) ────────────────

/** One disagreement between the old store-grant rows and the new ones. */
export interface GrantDrift {
  kind:
    | "layer"
    | "grant_missing"
    | "grant_state"
    | "grant_holder"
    | "grant_sku"
    | "purchase_grant_id"
    | "mapping";
  /** The licence, grant or purchase it concerns (never a purchase key). */
  ref: string;
  detail?: string;
}

/**
 * Compare the old store-grant objects with their projection for one product (the reconciliation
 * test's check, and LX-16's zero-drift report before it drops the old rows): every licence's
 * legacy store layer (`core/storeGrants.ts`'s `storeGrantLayer`, active flags, `MAX(granted_at)`
 * each) against the same layer rendered from `grants` (licence-held, store source, `active`,
 * `MAX(updated_at)` per key, plans/LX-01.md §2.3), each purchase's grant row and
 * `dist_purchases.grant_id`, and each store mapping's entitlement rows. An empty answer is zero
 * drift.
 */
export async function storeGrantDrift(
  db: Db,
  product: string,
): Promise<GrantDrift[]> {
  const out: GrantDrift[] = [];
  const oldLayer = await db.all<{
    license_id: string;
    flag: string;
    at: number;
  }>(
    `SELECT license_id, flag, MAX(granted_at) AS at FROM license_store_grants
      WHERE product = ? AND state = 'active'
      GROUP BY license_id, flag ORDER BY license_id, flag`,
    product,
  );
  const newLayer = await db.all<{
    license_id: string;
    flag: string;
    at: number;
  }>(
    `SELECT g.license_id, ge.key AS flag, MAX(ge.updated_at) AS at
       FROM grants g JOIN grant_entitlements ge
         ON ge.product = g.product AND ge.grant_id = g.id
      WHERE g.product = ? AND g.license_id IS NOT NULL
        AND g.source IN (${STORE_SOURCES_SQL}) AND g.state = 'active'
      GROUP BY g.license_id, ge.key ORDER BY g.license_id, ge.key`,
    product,
  );
  const key = (r: { license_id: string; flag: string; at: number }) =>
    `${r.license_id} ${r.flag} ${r.at}`;
  const oldSet = new Set(oldLayer.map(key));
  const newSet = new Set(newLayer.map(key));
  for (const k of oldSet)
    if (!newSet.has(k)) out.push({ kind: "layer", ref: k, detail: "old only" });
  for (const k of newSet)
    if (!oldSet.has(k)) out.push({ kind: "layer", ref: k, detail: "new only" });

  const purchases = await db.all<{
    store: Store;
    purchase_key_hash: string;
    license_id: string;
    active: number;
    sku: string | null;
    grant_id: string | null;
    g_license: string | null;
    g_state: string | null;
    g_sku: string | null;
  }>(
    `SELECT s.store, s.purchase_key_hash, MIN(s.license_id) AS license_id,
            MAX(s.state = 'active') AS active,
            (SELECT p.store_product_id FROM dist_purchases p
              WHERE p.product = s.product AND p.store = s.store
                AND p.purchase_key_hash = s.purchase_key_hash) AS sku,
            (SELECT p.grant_id FROM dist_purchases p
              WHERE p.product = s.product AND p.store = s.store
                AND p.purchase_key_hash = s.purchase_key_hash) AS grant_id,
            g.license_id AS g_license, g.state AS g_state, g.sku AS g_sku
       FROM license_store_grants s
       LEFT JOIN grants g
         ON g.product = s.product AND g.id = 'grt_s_' || s.store || '_' || s.purchase_key_hash
      WHERE s.product = ?
      GROUP BY s.store, s.purchase_key_hash`,
    product,
  );
  for (const p of purchases) {
    const id = storeGrantId(p.store, p.purchase_key_hash);
    const ref = `grt_s_${p.store}_${p.purchase_key_hash.slice(0, 16)}`;
    if (p.g_state === null) {
      out.push({ kind: "grant_missing", ref });
      continue;
    }
    const state = p.active === 1 ? "active" : "revoked";
    if (p.g_state !== state)
      out.push({ kind: "grant_state", ref, detail: `${p.g_state} ≠ ${state}` });
    if (p.g_license !== p.license_id) out.push({ kind: "grant_holder", ref });
    if (p.sku !== null && p.g_sku !== p.sku)
      out.push({ kind: "grant_sku", ref });
    if (p.sku !== null && p.grant_id !== id)
      out.push({ kind: "purchase_grant_id", ref });
  }

  // Each store mapping's entitlement rows are exactly its flag while `flag` is its one key.
  const mappings = await db.all<{ ref: string; detail: string }>(
    `SELECT m.store || ':' || m.store_product_id AS ref, 'flag missing' AS detail
       FROM dist_store_products m
      WHERE m.product = ?
        AND NOT EXISTS (SELECT 1 FROM dist_store_product_entitlements e
                         WHERE e.product = m.product AND e.store = m.store
                           AND e.store_product_id = m.store_product_id AND e.key = m.flag)
     UNION ALL
     SELECT e.store || ':' || e.store_product_id, 'extra key ' || e.key
       FROM dist_store_product_entitlements e
      WHERE e.product = ?
        AND NOT EXISTS (SELECT 1 FROM dist_store_products m
                         WHERE m.product = e.product AND m.store = e.store
                           AND m.store_product_id = e.store_product_id AND m.flag = e.key)`,
    product,
    product,
  );
  for (const m of mappings)
    out.push({ kind: "mapping", ref: m.ref, detail: m.detail });
  return out;
}
