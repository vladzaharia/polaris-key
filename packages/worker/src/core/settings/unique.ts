/**
 * A setting value one owner holds at a time (`SettingDef.uniqueAcrossProducts`).
 *
 * A native sign-in link is scoped by the audience an app declares (a Google web client id, an Apple
 * team id), so two products that name the same value share a scope. Products of ONE owner may share
 * it; products of different owners may not. The owner of a product is the GitHub account or
 * organisation its release config names (`release_config.gh_owner`, case-insensitive). A product
 * with no such owner is its own owner, so it never shares a value.
 */

import type { Db } from "../../db/types.js";

/**
 * The slug of another live product that stores `value` under `key` and belongs to a different
 * owner than `slug`, or `null`.
 */
export async function valueHeldByOtherOwner(
  db: Db,
  slug: string,
  key: string,
  value: unknown,
): Promise<string | null> {
  if (typeof value !== "string" || value === "") return null;
  const rows = await db.all<{ product: string; owner: string | null }>(
    `SELECT s.product AS product, lower(r.gh_owner) AS owner
       FROM product_settings s
       JOIN products p ON p.slug = s.product
       LEFT JOIN release_config r ON r.product = s.product
      WHERE s.key = ?
        AND lower(s.value_json) = lower(?)
        AND s.product != ?
        AND COALESCE(p.status, 'active') != 'deleted'
      ORDER BY s.product`,
    key,
    JSON.stringify(value),
    slug,
  );
  if (rows.length === 0) return null;
  const mine = await db.first<{ owner: string | null }>(
    "SELECT lower(gh_owner) AS owner FROM release_config WHERE product = ?",
    slug,
  );
  const owner = mine?.owner ?? null;
  const other = rows.find((r) => owner === null || r.owner !== owner);
  return other?.product ?? null;
}
