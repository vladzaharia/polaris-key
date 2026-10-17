/**
 * Update's integration contribution (P0-19; consumed by ST-40). Update keeps no rows of its own: it
 * is a feed over Release's truth and Distribution's delivery, so what it needs is whether both
 * providers answer for this product.
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const updateIntegration: IntegrationContributor = async ({ hooks }) => ({
  prerequisites: [
    { id: "release", met: hooks.releaseCatalog() !== null },
    { id: "distribution", met: hooks.delivery() !== null },
  ],
  facts: {},
});
