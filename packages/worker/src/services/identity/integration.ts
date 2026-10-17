/**
 * Identity's integration contribution (P0-19; consumed by ST-40): whether the product has its own
 * sign-in configured and how many people have signed in to it. Reads Identity's own tables.
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const identityIntegration: IntegrationContributor = async ({
  db,
  product,
}) => {
  const oidc = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM oidc_config WHERE product = ? AND issuer IS NOT NULL",
    product.slug,
  );
  const subjects = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM account_product_subjects WHERE product = ?",
    product.slug,
  );
  return {
    prerequisites: [{ id: "oidc", met: Number(oidc?.n ?? 0) > 0 }],
    facts: { signedIn: Number(subjects?.n ?? 0) },
  };
};
