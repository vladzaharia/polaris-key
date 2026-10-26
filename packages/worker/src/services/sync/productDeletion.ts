/**
 * Cloud Sync's erasure for a deleted product (U-05.8; `core/products/store.ts` `deleteProduct`
 * collects the statements through `contributes.productDeletion`, and the console's delete handler
 * runs the purge through `contributes.productPurge` first).
 *
 * The objects: a person's data lives in a Durable Object that cannot be listed, so the directory
 * (`sync_directory`, one row per (product, subject) that was ever written) is the enumeration.
 * `purgeProductObjects` takes its subjects in pages, erases each object (alarm, then storage), and
 * only then deletes that subject's directory row, so a crash or a failed call leaves the row that
 * points at the object still to erase, and the run is simply repeated. The statements then drop
 * whatever rows remain, and the product's aggregates (which hold no subject). The first thing a
 * run does is set the purge flag, which the push route reads (`purgeFlag.ts`).
 */

import type {
  ProductDeletionContributor,
  ProductPurgeContributor,
} from "../../core/contributions.js";
import { deleteCloudSync } from "./do/client.js";
import { markProductPurging } from "./purgeFlag.js";

/** Objects erased per run: each is one subrequest, and a run must stay inside the Worker's limit. */
export const PURGE_OBJECTS_PER_RUN = 400;
const PAGE = 100;

export const syncProductDeletion: ProductDeletionContributor = (product) => [
  { sql: "DELETE FROM sync_directory WHERE product = ?", params: [product] },
  {
    sql: "DELETE FROM sync_product_usage WHERE product = ?",
    params: [product],
  },
  {
    sql: "DELETE FROM sync_product_daily WHERE product = ?",
    params: [product],
  },
];

export const syncProductPurge: ProductPurgeContributor = async ({
  db,
  env,
  product,
}) => {
  // First, before any object is erased: from here a push is refused (`purgeFlag.ts`), so a device
  // that still authenticates cannot recreate what this run erases. Renewed by every run.
  await markProductPurging(env, product);
  let erased = 0;
  for (;;) {
    const page = await db.all<{ subject: string }>(
      "SELECT subject FROM sync_directory WHERE product = ? ORDER BY subject LIMIT ?",
      product,
      PAGE,
    );
    if (page.length === 0) {
      // The flag stays: the product row flips after this returns, and a push in the gap must
      // still be refused. Its TTL ends it.
      return { done: true };
    }
    for (const { subject } of page) {
      if (erased >= PURGE_OBJECTS_PER_RUN) return { done: false };
      await deleteCloudSync(env, { product, subject });
      await db.run(
        "DELETE FROM sync_directory WHERE product = ? AND subject = ?",
        product,
        subject,
      );
      erased++;
    }
  }
};
