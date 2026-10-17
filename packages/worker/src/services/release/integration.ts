/**
 * Release's integration contribution (P0-19; consumed by ST-40): whether a repository is linked
 * and whether a release has been published. Reads Release's own tables.
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const releaseIntegration: IntegrationContributor = async ({
  db,
  product,
}) => {
  const linked = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM release_config WHERE product = ? AND gh_repo IS NOT NULL",
    product.slug,
  );
  const releases = await db.first<{ n: number; latest: number | null }>(
    "SELECT COUNT(*) AS n, MAX(published_at) AS latest FROM release_metadata WHERE product = ? AND published_at IS NOT NULL",
    product.slug,
  );
  return {
    prerequisites: [{ id: "repository", met: Number(linked?.n ?? 0) > 0 }],
    facts: {
      releases: Number(releases?.n ?? 0),
      latestPublishedAt: releases?.latest ?? null,
    },
  };
};
