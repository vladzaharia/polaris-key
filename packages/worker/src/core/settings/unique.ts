/**
 * A setting value one product holds at a time (`SettingDef.uniqueAcrossProducts`).
 *
 * A native sign-in link is scoped by the audience an app declares (a Google web client id, an Apple
 * team id), so two products that name the same value would share a scope. No product-side field
 * proves who a developer is, so the rule is strict: any other live product holding the value
 * refuses the write. Sharing one id across a developer's own products needs a verified-ownership
 * model first.
 */

import type { Db } from "../../db/types.js";

/** The slug of another live product that stores `value` under `key`, or `null`. */
export async function valueHeldByOtherProduct(
  db: Db,
  slug: string,
  key: string,
  value: unknown,
): Promise<string | null> {
  if (typeof value !== "string" || value === "") return null;
  const row = await db.first<{ product: string }>(
    `SELECT s.product AS product
       FROM product_settings s
       JOIN products p ON p.slug = s.product
      WHERE s.key = ?
        AND lower(s.value_json) = lower(?)
        AND s.product != ?
        AND COALESCE(p.status, 'active') != 'deleted'
      ORDER BY s.product
      LIMIT 1`,
    key,
    JSON.stringify(value),
    slug,
  );
  return row?.product ?? null;
}
