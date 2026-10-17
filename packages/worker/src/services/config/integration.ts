/**
 * Config's integration contribution (P0-19; consumed by ST-40): whether the product has a catalog
 * and what hangs off it. Reads Config's own tables.
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const configIntegration: IntegrationContributor = async ({
  db,
  product,
}) => {
  const catalog = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM product_schema WHERE product = ? AND active = 1",
    product.slug,
  );
  const profiles = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM profiles WHERE product = ?",
    product.slug,
  );
  return {
    prerequisites: [{ id: "catalog", met: Number(catalog?.n ?? 0) > 0 }],
    facts: {
      schemaVersion: product.schemaVersion ?? null,
      profiles: Number(profiles?.n ?? 0),
    },
  };
};
