/**
 * The audit trail a manifest resync leaves behind.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────────
 *
 * `grep -n audit services/release/resync.ts githubWebhook.ts` used to return nothing. Every
 * OTHER mutation of product state appends an `audit` row naming the actor from a verified
 * session — except the one that needs no session at all: a push to `.pkey/` on a linked repo's
 * default branch, by anyone with write access, rewriting the admin group, the tiers, the IdP
 * config, the access modes and the catalog. `product_sync_state` recorded that a sync HAPPENED
 * and which coarse sections it touched (`["product","schema","tiers"]`), which is a progress
 * indicator, not a record of what changed — and it is overwritten by the next sync, so the
 * previous value is gone.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────────────────────
 *
 * Snapshot the manifest-owned state before the writes and again after, then emit one audit row
 * per field whose value actually MOVED. Diffing beats instrumenting each write for two reasons:
 * the ownership guards (`services_source`, `*_access_source`, the sealed-secret carry-forward)
 * mean an attempted write is not the same thing as a change, and a resync of an unchanged
 * manifest — the overwhelmingly common case, since any push under `.pkey/` triggers one — must
 * stay a clean no-op that writes no audit rows at all.
 *
 * Volatile bookkeeping columns are stripped (`modified_at` is stamped with `now` on every
 * resync, so leaving it in would make every resync look like a change to everything).
 *
 * Child collections are diffed as ONE field each rather than per row. `profiles`/`tiers`/… are
 * DELETEd and re-INSERTed wholesale, so a per-row diff would let one hostile manifest with a
 * thousand tiers turn into a thousand audit rows; whole-table granularity keeps the number of
 * rows a single push can append a small constant.
 */

import type { Db } from "../../core/platform.js";

/** Columns that change on every write and say nothing about WHAT changed. */
const VOLATILE_COLUMNS = new Set(["modified_at", "modified_by", "created_at"]);

/** A field name -> its serialised value. `null` means "the row/table does not exist". */
export type ManifestStateSnapshot = Record<string, string | null>;

function stable(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (VOLATILE_COLUMNS.has(key)) continue;
    out[key] = row[key];
  }
  return out;
}

function serialise(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Everything a `.pkey/` manifest can write, in one comparable shape.
 *
 * `SELECT *` rather than a column list on purpose: a column added to one of these tables later
 * is a column a manifest can potentially write, and it should join the audit automatically
 * rather than silently escape it.
 */
export async function manifestStateSnapshot(
  db: Db,
  product: string,
): Promise<ManifestStateSnapshot> {
  const snapshot: ManifestStateSnapshot = {};

  const singletons: Array<[string, string]> = [
    ["products", "SELECT * FROM products WHERE slug = ?"],
    ["release_config", "SELECT * FROM release_config WHERE product = ?"],
  ];
  for (const [table, sql] of singletons) {
    const row = await db.first<Record<string, unknown>>(sql, product);
    if (!row) {
      snapshot[table] = null;
      continue;
    }
    for (const [column, value] of Object.entries(stable(row))) {
      snapshot[`${table}.${column}`] = serialise(value);
    }
  }

  const active = await db.first<{ catalog_json: string }>(
    "SELECT catalog_json FROM product_schema WHERE product = ? AND active = 1 ORDER BY catalog_version DESC LIMIT 1",
    product,
  );
  snapshot["catalog"] = active?.catalog_json ?? null;

  const collections: Array<[string, string]> = [
    ["oidc_config", "SELECT * FROM oidc_config WHERE product = ?"],
    ["profiles", "SELECT * FROM profiles WHERE product = ? ORDER BY id"],
    ["tiers", "SELECT * FROM tiers WHERE product = ? ORDER BY id"],
    [
      "provisioning_config",
      "SELECT * FROM provisioning_config WHERE product = ? ORDER BY claim",
    ],
    [
      "edge_mint_config",
      "SELECT * FROM edge_mint_config WHERE product = ? ORDER BY id",
    ],
  ];
  for (const [field, sql] of collections) {
    const rows = await db.all<Record<string, unknown>>(sql, product);
    snapshot[field] = JSON.stringify(rows.map(stable));
  }

  return snapshot;
}

/** The field names whose serialised value differs between two snapshots, in stable order. */
export function changedFields(
  before: ManifestStateSnapshot,
  after: ManifestStateSnapshot,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => (before[name] ?? null) !== (after[name] ?? null))
    .sort();
}
