/**
 * The console's summary read: one fact per service for every product, for Home's product cards
 * (owner request 2026-10-06; docs/design/console-product-card/). It is the slice of ADMIN.md's A-8
 * (`GET /summary`, "Home at scale") the cards need:
 *
 *   license       { active }               licences that are active and not expired
 *   release       { version, channel }     the newest app release any channel serves, and the
 *                 | null                   channel serving it (`stable` first on a tie); null
 *                                          when no channel serves a release yet
 *   distribution  { storefronts }          storefronts (A-18j adapters) the product has a live
 *                                          outlet for; adapters sharing one outlet kind count
 *                                          once (`STOREFRONT_GROUPS`)
 *   identity      { users }                users the product's Users page lists
 *
 * Each fact is ONE grouped query across every product, so the read costs the registry list plus
 * four statements however many products there are; no card fetches anything of its own. A fact
 * is present only for a product that runs its service. Config's fact (the catalog's schema
 * version) already rides `/me`; Update has none, and Cloud Sync has none until U-05 stores usage.
 */

import type { Db } from "../../db/types.js";
import type { ProductRow } from "../../core/repo.js";
import { serviceStateOf } from "../../core/services.js";
import { STOREFRONT_ADAPTERS } from "../../core/storefront/adapter.js";
import { countListedUsersByProduct } from "../../services/identity/accounts/productUsers.js";

export interface ProductSummary {
  license?: { active: number };
  release?: { version: string; channel: string } | null;
  distribution?: { storefronts: number };
  identity?: { users: number };
}

async function activeLicenses(
  db: Db,
  now: number,
): Promise<Map<string, number>> {
  const rows = await db.all<{ product: string; n: number }>(
    `SELECT product, COUNT(*) AS n FROM licenses
      WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)
      GROUP BY product`,
    now,
  );
  return new Map(rows.map((r) => [r.product, Number(r.n)]));
}

async function latestReleases(
  db: Db,
): Promise<Map<string, { version: string; channel: string }>> {
  const rows = await db.all<{
    product: string;
    version: string;
    channel: string;
  }>(
    `SELECT product, version, channel FROM (
       SELECT c.product AS product, m.version AS version, c.channel AS channel,
              ROW_NUMBER() OVER (
                PARTITION BY c.product
                ORDER BY COALESCE(m.published_at, m.created_at) DESC,
                         c.channel = 'stable' DESC, c.channel
              ) AS rn
         FROM release_channels c
         JOIN release_metadata m
           ON m.product = c.product AND m.release_id = c.release_id
         LEFT JOIN release_yanks y
           ON y.product = m.product AND y.release_id = m.release_id
        WHERE c.release_id IS NOT NULL AND m.deliverable_id = 'app'
          AND y.release_id IS NULL
     ) WHERE rn = 1`,
  );
  return new Map(
    rows.map((r) => [r.product, { version: r.version, channel: r.channel }]),
  );
}

/**
 * Storefronts as the outlets can tell them apart. A storefront (an A-18j adapter) applies when
 * the product has a live outlet of one of its kinds, as the Storefronts page decides it. Adapters
 * that ride exactly the same kinds (Homebrew, Scoop and Polaris Key's own page all ride `direct`)
 * count once: one direct outlet cannot say which of them is set up.
 */
const STOREFRONT_GROUPS: readonly (readonly string[])[] = [
  ...new Map(
    STOREFRONT_ADAPTERS.filter((a) => a.outletKinds.length > 0).map((a) => [
      [...a.outletKinds].sort().join(","),
      a.outletKinds as readonly string[],
    ]),
  ).values(),
];

async function storefronts(db: Db): Promise<Map<string, number>> {
  const rows = await db.all<{ product: string; kind: string }>(
    `SELECT product, kind FROM dist_outlets
      WHERE removed_at IS NULL GROUP BY product, kind`,
  );
  const kinds = new Map<string, Set<string>>();
  for (const r of rows)
    kinds.set(r.product, (kinds.get(r.product) ?? new Set()).add(r.kind));
  const out = new Map<string, number>();
  for (const [product, held] of kinds)
    out.set(
      product,
      STOREFRONT_GROUPS.filter((group) => group.some((k) => held.has(k)))
        .length,
    );
  return out;
}

/**
 * The summary of every product in `products` (the registry rows the caller may see), keyed by
 * slug. Rows of products outside `products` (another tenant's, or a deleted product's) are read by
 * the grouped queries but never returned.
 */
export async function productSummaries(
  db: Db,
  products: ProductRow[],
  now: number,
): Promise<Record<string, ProductSummary>> {
  const [licenses, releases, stores, users] = await Promise.all([
    activeLicenses(db, now),
    latestReleases(db),
    storefronts(db),
    countListedUsersByProduct(db),
  ]);
  const out: Record<string, ProductSummary> = {};
  for (const p of products) {
    const on = serviceStateOf(p).services;
    const s: ProductSummary = {};
    if (on.license.enabled) s.license = { active: licenses.get(p.slug) ?? 0 };
    if (on.release.enabled) s.release = releases.get(p.slug) ?? null;
    if (on.distribution.enabled)
      s.distribution = { storefronts: stores.get(p.slug) ?? 0 };
    if (on.identity.enabled) s.identity = { users: users.get(p.slug) ?? 0 };
    out[p.slug] = s;
  }
  return out;
}
