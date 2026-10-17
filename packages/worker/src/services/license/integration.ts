/**
 * License's integration contribution (P0-19; consumed by ST-40): what the console's Integration
 * page needs to know about this product's licensing. Reads License's own tables and Core's
 * `devices`.
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const licenseIntegration: IntegrationContributor = async ({
  db,
  product,
}) => {
  const tiers = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tiers WHERE product = ?",
    product.slug,
  );
  const licenses = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM licenses WHERE product = ?",
    product.slug,
  );
  const devices = await db.first<{ n: number; first: number | null }>(
    "SELECT COUNT(*) AS n, MIN(first_seen) AS first FROM devices WHERE product = ? AND status = 'authorized'",
    product.slug,
  );
  return {
    prerequisites: [{ id: "tiers", met: Number(tiers?.n ?? 0) > 0 }],
    facts: {
      licenses: Number(licenses?.n ?? 0),
      devices: Number(devices?.n ?? 0),
      firstDeviceAt: devices?.first ?? null,
    },
  };
};
