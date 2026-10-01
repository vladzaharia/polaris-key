/**
 * Operator-owned connector settings (P5-03): `dist_connector_settings`, one JSON object per
 * (product, connector). The only reader and writer of that table.
 *
 * A connector owns the SHAPE (it validates on write and normalises on read, falling back to safe
 * defaults); this module only stores it. Writes come from a connector's console control, so they
 * are platform-admin actions, audited there with the session's subject. No ingest, resync or
 * manifest field reaches this table: a repo push must never switch on an automatic action.
 */

import type { Db } from "../../../core/platform.js";

export interface ConnectorSettingsRow {
  product: string;
  connector: string;
  settings_json: string;
  updated_at: number;
  updated_by: string;
}

/** The stored settings object of one connector, or `null` when none was ever saved (or the stored
 *  JSON is not an object). The caller normalises it. */
export async function readConnectorSettings(
  db: Db,
  product: string,
  connector: string,
): Promise<{
  value: Record<string, unknown>;
  updatedAt: number;
  updatedBy: string;
} | null> {
  const row = await db.first<ConnectorSettingsRow>(
    "SELECT * FROM dist_connector_settings WHERE product = ? AND connector = ?",
    product,
    connector,
  );
  if (!row) return null;
  try {
    const v = JSON.parse(row.settings_json) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return {
      value: v as Record<string, unknown>,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  } catch {
    return null;
  }
}

/** Replace one connector's settings with an already-validated object. */
export async function writeConnectorSettings(
  db: Db,
  product: string,
  connector: string,
  value: Record<string, unknown>,
  by: string,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_connector_settings
       (product, connector, settings_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (product, connector) DO UPDATE SET
       settings_json = excluded.settings_json,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    product,
    connector,
    JSON.stringify(value),
    now,
    by,
  );
}
