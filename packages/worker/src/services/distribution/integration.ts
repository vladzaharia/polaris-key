/**
 * Distribution's integration contribution (P0-19; consumed by ST-40): the outlets the product
 * ships through. Reads Distribution's own tables.
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const distributionIntegration: IntegrationContributor = async ({
  db,
  hooks,
  product,
}) => {
  const outlets = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM dist_outlets WHERE product = ? AND removed_at IS NULL",
    product.slug,
  );
  return {
    prerequisites: [
      { id: "release", met: hooks.releaseCatalog() !== null },
      { id: "outlets", met: Number(outlets?.n ?? 0) > 0 },
    ],
    facts: { outlets: Number(outlets?.n ?? 0) },
  };
};
