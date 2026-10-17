/**
 * `GET /api/platform/settings/:key/reach[?value=N]` (ST-16): how many products a change to a
 * platform default or bound reaches, for the confirm dialog, and which are clamped today.
 *
 *  - a default (`productLink.default`) reaches the products that set no value of their own;
 *  - a bound (`productLink.bound`, `policy`) reaches the products whose value, set or the product
 *    default, sits on the permissive side of the new bound. Those are shown with the value they
 *    set and the effective one. A platform write never rewrites a product row: it clamps it.
 *
 * Read-only: counts and slugs, no value of any other setting.
 */

import type { Db } from "../../db/types.js";
import { adminJson } from "../../core/console/respond.js";
import { isSettingValue } from "../../core/settings/resolve.js";
import type { SettingDef } from "../../core/settings/types.js";
import { SETTINGS } from "../../mount.js";

export interface ReachView {
  /** `default`: products inheriting; `bound`: products clamped by it. */
  kind: "default" | "bound";
  /** Products in the count's base (system products excluded). */
  total: number;
  /** Products the change reaches. */
  reaches: number;
  /** Up to `SHOWN` of the clamped products: what each set and what is in effect. */
  clamped: { product: string; set: unknown; effective: unknown }[];
}

const SHOWN = 5;

interface Own {
  product: string;
  value_json: string | null;
}

function parse(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

export async function reachOf(
  db: Db,
  def: SettingDef,
  platformValue: unknown,
  now: number,
): Promise<ReachView> {
  const productDef = SETTINGS.get(def.key, "product");
  const products = (
    await db.all<{ slug: string }>(
      "SELECT slug FROM products WHERE system IS NOT 1 ORDER BY slug",
    )
  ).map((p) => p.slug);
  const own = new Map<string, unknown>();
  for (const r of await db.all<Own>(
    "SELECT product, value_json FROM product_settings WHERE key = ? AND value_json IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)",
    def.key,
    now,
  )) {
    const v = parse(r.value_json);
    // A value that is no value of the product entry is ignored by the resolver too.
    if (productDef && v !== undefined && isSettingValue(productDef, v))
      own.set(r.product, v);
  }
  const total = products.length;
  if (!def.productLink?.bound || typeof platformValue !== "number") {
    return {
      kind: "default",
      total,
      reaches: products.filter((p) => !own.has(p)).length,
      clamped: [],
    };
  }
  const max = def.policyBound === "max";
  const clamped = products.flatMap((product) => {
    const set = own.has(product) ? own.get(product) : productDef?.defaultValue;
    if (typeof set !== "number") return [];
    return (max ? set > platformValue : set < platformValue)
      ? [{ product, set, effective: platformValue }]
      : [];
  });
  return {
    kind: "bound",
    total,
    reaches: clamped.length,
    clamped: clamped.slice(0, SHOWN),
  };
}

export async function reach(
  db: Db,
  def: SettingDef,
  platformValue: unknown,
  now: number,
): Promise<Response> {
  return adminJson(await reachOf(db, def, platformValue, now));
}
