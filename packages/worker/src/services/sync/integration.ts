/**
 * Cloud Sync's integration contribution (P0-19; consumed by ST-40). Sync keeps no rows yet (the
 * device routes are U-05's) and requires Config and Identity, which `validateServices` already
 * guarantees while it is on; it has nothing of its own to report.
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const syncIntegration: IntegrationContributor = async () => ({
  prerequisites: [],
  facts: {},
});
