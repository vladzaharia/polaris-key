// Config's catalog writes (moved from core/products/store.ts, P0-26b).

import type { Db, DbStatement } from "../../db/types.js";
import type { SchemaRow } from "../../core/repo.js";

export async function insertSchema(db: Db, row: SchemaRow): Promise<void> {
  await db.run(
    "INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at) VALUES (?, ?, ?, ?, ?)",
    row.product,
    row.catalog_version,
    row.catalog_json,
    row.active,
    row.created_at,
  );
}

/** Build the active-schema INSERT as a statement (for atomic batch). */
export function stmtInsertSchema(row: SchemaRow): DbStatement {
  return {
    sql: "INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at) VALUES (?, ?, ?, ?, ?)",
    params: [
      row.product,
      row.catalog_version,
      row.catalog_json,
      row.active,
      row.created_at,
    ],
  };
}

// ── Schema (catalog) writes ──────────────────────────────────────────────────
export async function deactivateSchemas(
  db: Db,
  product: string,
): Promise<void> {
  await db.run(
    "UPDATE product_schema SET active = 0 WHERE product = ?",
    product,
  );
}
