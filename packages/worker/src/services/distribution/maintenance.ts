/**
 * Distribution's scheduled work, contributed on its descriptor (`contributes.maintenance`, P0-19).
 */

import type { MaintenanceContribution } from "../../core/contributions.js";
import { pruneEvents as pruneConnectorEvents } from "./connectors/state.js";

export const distributionMaintenance: MaintenanceContribution = {
  /**
   * P5-02: store-connector webhook events past `CONNECTOR_EVENT_RETENTION_SECONDS` (30 days). In
   * the nightly sweep and not on the connector poll tick, because the poll reaches only live
   * products with Distribution on and a loadable signing key: a deleted or disabled product's raw
   * payloads would otherwise be kept forever.
   */
  async product({ db, product, now }, rec) {
    await rec.drain(`connectorEvents:${product}`, (limit) =>
      pruneConnectorEvents(db, product, now, limit),
    );
  },
};
