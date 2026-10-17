/**
 * Release's scheduled work, contributed on its descriptor (`contributes.maintenance`, P0-19).
 * Step names are unchanged from when `scheduled.ts` ran them inline.
 */

import type { MaintenanceContribution } from "../../core/contributions.js";
import { lazyDeltaProducts } from "../../core/assets/deltaDemand.js";
import { reconcilePackageFileRefs } from "./packages/refReconcile.js";
import { sweepLazyDeltas } from "./packs/deltas/sweep.js";
import { backfillReleaseMirrors } from "./mirror.js";

export const releaseMaintenance: MaintenanceContribution = {
  async late({ db, env, now }, rec) {
    if (!env) return;
    // P4-17: the lazy-delta sweep (`packs/deltas/sweep.ts`), one fault-isolated step per opted-in
    // product (`lazyDeltas:<slug>`): refresh the demand aggregate, enqueue the pairs that turned
    // hot (to `DELTA_QUEUE`; the consumer Worker encodes them), and mark cold the deltas no
    // device used for 30 days. Nothing at all while the `LAZY_DELTAS` switch is off (the platform
    // settings store, A-13: a `[vars]` `off` is a hard off). Before the blob collector, so a delta
    // marked cold tonight loses its ref before tonight's mark pass.
    let products: string[] = [];
    try {
      products = await lazyDeltaProducts(env, db);
    } catch (e) {
      rec.fail("lazyDeltas:products", e);
    }
    for (const product of products)
      await rec.step(`lazyDeltas:${product}`, async () => {
        const r = await sweepLazyDeltas(env, db, product, now);
        return r.demandRows + r.queued + r.cold;
      });
    // HA-08: release files still owing a copy of ours (S-20 §6.8): on first deploy the backfill of
    // every existing release, afterwards the retry of failed ones once their back-off elapsed, at
    // most `MIRROR_BACKFILL_MAX_PER_RUN` per night, to `pkey-assets-<env>`. Before the collector,
    // which never drops either ref a copy is held by.
    await rec.step("releaseMirrors", () =>
      backfillReleaseMirrors(env, db, now),
    );
  },

  /** Heal package refs the deploy window's old Worker wrote as `artifact`, every tick. */
  async registry({ db }, rec) {
    await rec.step("packageFileRefs", () =>
      reconcilePackageFileRefs(db, "cron"),
    );
  },
};
