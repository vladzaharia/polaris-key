/**
 * Commerce's integration contribution (P0-19; consumed by ST-40). It reports no prerequisite or
 * fact yet: which store is ready is the console's setup state (`admin.ts` `setupOf`) until
 * CM-21 and CM-23 give it a place here. License, its one requirement, is guaranteed while
 * Commerce is on (`commerce_requires_license`).
 */

import type { IntegrationContributor } from "../../core/contributions.js";

export const commerceIntegration: IntegrationContributor = async () => ({
  prerequisites: [],
  facts: {},
});
