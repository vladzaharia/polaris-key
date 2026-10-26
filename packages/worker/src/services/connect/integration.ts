/**
 * Cloud Connect's integration contribution (consumed by ST-40). It keeps no rows yet and requires
 * Identity, which `validateServices` already guarantees while it is on; it has nothing of its own
 * to report.
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const connectIntegration: IntegrationContributor = async () => ({
  prerequisites: [],
  facts: {},
});
