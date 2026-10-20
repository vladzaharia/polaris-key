/**
 * The facts the console's Features page shows as each feature's status (ST-38): what a feature
 * holds, not whether it is "set up". Read with `GET …/services`, a handful of indexed counts.
 *
 * Every fact is read whatever the feature's state: a feature turned off keeps its data (its
 * settings and rows return when it is turned on), and the page decides what to show.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { readyStorefronts } from "../../services/commerce/public.js";

export interface FeatureFacts {
  /** Licensing: the product's tiers and licences. */
  licensing: { tiers: number; licenses: number };
  /** Managed config: the published catalog version, `null` before the first publish. */
  managedConfig: { catalogVersion: number | null };
  /** Ship builds: the app's latest release and its release track, `null` before the first. */
  shipBuilds: { latest: { version: string; channel: string | null } | null };
  /**
   * Commerce: the stores with a configured storefront (settings saved and the credential resolves, as
   * the Commerce overview's `setupOf`) and the store purchases that are live, which the
   * Attention state "Store refunds are not landing" reads while Commerce is off.
   */
  commerce: { storefronts: number; storeGrants: number };
}

export async function featureFactsOf(
  env: Env,
  db: Db,
  product: string,
): Promise<FeatureFacts> {
  const [tiers, licenses, catalog, release, commerce, storeGrants] =
    await Promise.all([
      db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tiers WHERE product = ?",
        product,
      ),
      db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM licenses WHERE product = ?",
        product,
      ),
      db.first<{ v: number | null }>(
        "SELECT MAX(catalog_version) AS v FROM product_schema WHERE product = ? AND active = 1",
        product,
      ),
      db.first<{ version: string; channel: string | null }>(
        `SELECT version, channel FROM release_metadata
        WHERE product = ? AND deliverable_id = 'app'
        ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1`,
        product,
      ),
      readyStorefronts(env, db, product),
      db.first<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM grants WHERE product = ? AND state = 'active'
                 AND source IN ('app-store', 'play', 'steam'))
            + (SELECT COUNT(*) FROM license_store_grants WHERE product = ? AND state = 'active') AS n`,
        product,
        product,
      ),
    ]);
  return {
    licensing: { tiers: tiers?.n ?? 0, licenses: licenses?.n ?? 0 },
    managedConfig: { catalogVersion: catalog?.v ?? null },
    shipBuilds: {
      latest: release
        ? { version: release.version, channel: release.channel ?? null }
        : null,
    },
    commerce: {
      storefronts: commerce,
      storeGrants: storeGrants?.n ?? 0,
    },
  };
}
