/**
 * Cloud Sync's retention (`contributes.maintenance`, U-05.9; L17): `sync_product_daily` keeps 90
 * days. Nightly, per swept product, whatever the product's enablement (a switched-off service's
 * rows age out too). The directory and the aggregate are not pruned here: the object and the
 * product's deletion own them.
 */

import type { MaintenanceContribution } from "../../core/contributions.js";
import { dayOf } from "./do/directory.js";

export const DAILY_RETENTION_DAYS = 90;

export const syncMaintenance: MaintenanceContribution = {
  async product({ db, product, now }, rec) {
    const cutoff = dayOf((now - DAILY_RETENTION_DAYS * 86_400) * 1000);
    await rec.step(`syncDaily:${product}`, () =>
      db.runChanges(
        "DELETE FROM sync_product_daily WHERE product = ? AND day < ?",
        product,
        cutoff,
      ),
    );
  },
};
