/**
 * The Polaris Locker switches as settings rows (ST-14, notes/S-18 §4.10): `portal.enabled`,
 * `portal.keyReissue` and `identity.keyEntry.claimByKey`, each a row-backed `product_settings`
 * entry (registered by Identity's slice, `services/identity/settings.ts`). Before ST-14 they were
 * columns of Identity's `portal_product_settings`; migration 00XX_portal_settings_rows copied them
 * once and the table's switch columns are no longer read (ST-25 drops them).
 *
 * Read here, in Core, because Core's own paths (the refusal's `manageUrl`) and every Identity
 * reader need the same answer and Core may not import a service. No row is the default: portal
 * on, key reissue off, claim by key off. None of the three inherits from the platform, so the
 * stored row IS the resolved value; an expired break-glass claim (ST-20) reads as no row, as the
 * resolver reads it.
 */

import type { Db } from "../db/types.js";
import { tryParseJson } from "../platform/json.js";
import { jsonList, jsonListArg } from "./sqlIn.js";

export const PORTAL_ENABLED_SETTING = "portal.enabled";
export const PORTAL_KEY_REISSUE_SETTING = "portal.keyReissue";
export const CLAIM_BY_KEY_SETTING_KEY = "identity.keyEntry.claimByKey";

/** The registered defaults, written down once for the readers and the migration test. */
export const PORTAL_TOGGLE_DEFAULTS = {
  portalEnabled: true,
  keyReissueEnabled: false,
  claimByKey: false,
} as const;

export interface PortalToggles {
  portalEnabled: boolean;
  keyReissueEnabled: boolean;
  claimByKey: boolean;
}

/** A product's three switches in force (`now` is seconds; an expired claim row is no row). */
export async function readPortalToggles(
  db: Db,
  product: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<PortalToggles> {
  const rows = await db.all<{
    key: string;
    value_json: string | null;
    expires_at: number | null;
  }>(
    `SELECT key, value_json, expires_at FROM product_settings
      WHERE product = ? AND key IN ${jsonList()}`,
    product,
    jsonListArg([
      PORTAL_ENABLED_SETTING,
      PORTAL_KEY_REISSUE_SETTING,
      CLAIM_BY_KEY_SETTING_KEY,
    ]),
  );
  const value = (key: string, fallback: boolean): boolean => {
    const row = rows.find((r) => r.key === key);
    if (!row || (row.expires_at !== null && row.expires_at <= now))
      return fallback;
    const parsed =
      row.value_json === null ? undefined : tryParseJson(row.value_json);
    return typeof parsed === "boolean" ? parsed : fallback;
  };
  return {
    portalEnabled: value(
      PORTAL_ENABLED_SETTING,
      PORTAL_TOGGLE_DEFAULTS.portalEnabled,
    ),
    keyReissueEnabled: value(
      PORTAL_KEY_REISSUE_SETTING,
      PORTAL_TOGGLE_DEFAULTS.keyReissueEnabled,
    ),
    claimByKey: value(
      CLAIM_BY_KEY_SETTING_KEY,
      PORTAL_TOGGLE_DEFAULTS.claimByKey,
    ),
  };
}

/**
 * SQL for "this product's portal is on", for a query that selects over products: `productExpr` is
 * the product slug column (`l.product`, `p.slug`). True when no live `portal.enabled = false` row
 * exists, the same answer as {@link readPortalToggles}.
 */
export function portalEnabledSql(productExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM product_settings pe
            WHERE pe.product = ${productExpr} AND pe.key = '${PORTAL_ENABLED_SETTING}'
              AND pe.value_json = 'false'
              AND (pe.expires_at IS NULL OR pe.expires_at > CAST(strftime('%s', 'now') AS INTEGER)))`;
}
