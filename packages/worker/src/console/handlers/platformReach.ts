/**
 * What a platform default or bound reaches (ST-16, fix round).
 *
 *  - `reachOf`: `GET /api/platform/settings/:key/reach?value=N`, for the confirm dialog. The
 *    products whose EFFECTIVE value changes between the platform value in force and `value`, each
 *    as `{ product, name, from, to, inherited }`, with the direction of the change. A default
 *    changes the products that set none; a bound changes the products it lowers (a lower ceiling
 *    clamps) or releases (a higher one lets a clamped product use its own value again). Raising a
 *    ceiling therefore reaches the products it currently clamps, not "nothing".
 *  - `standingOf`: what the row shows at rest, sent with the settings list so it is never stale:
 *    a bound's clamped products (each with what it set and what is in effect), a default's
 *    inheriting count and who sets their own.
 *
 * A platform write never rewrites a product row: it clamps. Read-only: counts, names, values.
 */

import type { Db } from "../../db/types.js";
import { parseJsonColumn } from "../../platform/json.js";
import { isSettingValue } from "../../core/settings/resolve.js";
import type { SettingDef } from "../../core/settings/types.js";
import { SETTINGS } from "../../mount.js";

const SHOWN = 5;

export interface ReachProduct {
  product: string;
  name: string;
  from: unknown;
  to: unknown;
  /** The product sets no value of its own. */
  inherited: boolean;
}

export interface ReachView {
  kind: "default" | "bound";
  direction: "lower" | "raise" | "none";
  total: number;
  reaches: number;
  from: unknown;
  to: unknown;
  /** Up to five, in slug order. */
  products: ReachProduct[];
}

export type Standing =
  | {
      kind: "bound";
      total: number;
      count: number;
      products: {
        product: string;
        name: string;
        set: unknown;
        effective: unknown;
        inherited: boolean;
      }[];
    }
  | {
      kind: "default";
      total: number;
      inheriting: number;
      own: { product: string; name: string; value: unknown }[];
    };

interface Fleet {
  products: { slug: string; name: string }[];
  own: Map<string, unknown>;
  productDefault: unknown;
}

async function loadFleet(db: Db, def: SettingDef, now: number): Promise<Fleet> {
  const productDef = SETTINGS.get(def.key, "product");
  const products = await db.all<{ slug: string; name: string }>(
    "SELECT slug, name FROM products WHERE system IS NOT 1 ORDER BY slug",
  );
  const own = new Map<string, unknown>();
  for (const r of await db.all<{ product: string; value_json: string | null }>(
    "SELECT product, value_json FROM product_settings WHERE key = ? AND value_json IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)",
    def.key,
    now,
  )) {
    const v = parseJsonColumn(r.value_json) ?? undefined;
    // A value that is no value of the product entry is ignored by the resolver too.
    if (productDef && v !== undefined && isSettingValue(productDef, v))
      own.set(r.product, v);
  }
  return { products, own, productDefault: productDef?.defaultValue };
}

/** A product's effective value under a platform value `p` (a default or a `max` bound). */
function effective(
  def: SettingDef,
  f: Fleet,
  slug: string,
  p: unknown,
): unknown {
  const own = f.own.has(slug);
  const base = own ? f.own.get(slug) : f.productDefault;
  if (def.productLink?.bound) {
    return typeof base === "number" && typeof p === "number"
      ? def.policyBound === "min"
        ? Math.max(base, p)
        : Math.min(base, p)
      : base;
  }
  return own ? base : p;
}

export async function reachOf(
  db: Db,
  def: SettingDef,
  from: unknown,
  to: unknown,
  now: number,
): Promise<ReachView> {
  const f = await loadFleet(db, def, now);
  const changed = f.products.flatMap((p) => {
    const a = effective(def, f, p.slug, from);
    const b = effective(def, f, p.slug, to);
    return a === b
      ? []
      : [
          {
            product: p.slug,
            name: p.name,
            from: a,
            to: b,
            inherited: !f.own.has(p.slug),
          },
        ];
  });
  const direction =
    typeof from === "number" && typeof to === "number" && from !== to
      ? to < from
        ? "lower"
        : "raise"
      : "none";
  return {
    kind: def.productLink?.bound ? "bound" : "default",
    direction,
    total: f.products.length,
    reaches: changed.length,
    from,
    to,
    products: changed.slice(0, SHOWN),
  };
}

export async function standingOf(
  db: Db,
  def: SettingDef,
  platformValue: unknown,
  now: number,
): Promise<Standing> {
  const f = await loadFleet(db, def, now);
  if (def.productLink?.bound) {
    const clamped = f.products.flatMap((p) => {
      const set = f.own.has(p.slug) ? f.own.get(p.slug) : f.productDefault;
      const eff = effective(def, f, p.slug, platformValue);
      return set === eff
        ? []
        : [
            {
              product: p.slug,
              name: p.name,
              set,
              effective: eff,
              inherited: !f.own.has(p.slug),
            },
          ];
    });
    return {
      kind: "bound",
      total: f.products.length,
      count: clamped.length,
      products: clamped.slice(0, SHOWN),
    };
  }
  const own = f.products.filter((p) => f.own.has(p.slug));
  return {
    kind: "default",
    total: f.products.length,
    inheriting: f.products.length - own.length,
    own: own.slice(0, 2).map((p) => ({
      product: p.slug,
      name: p.name,
      value: f.own.get(p.slug),
    })),
  };
}
