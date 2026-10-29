/**
 * Whether silent restore is served for a product (I-49.6; plans/I-49-slices.md D-10, D-6;
 * V5 §12.11.8 "Gates"): the platform launch gate `launch.identityRestore` (off by default) AND
 * the product setting `identity.restore` (on by default, the developer's opt-out). The caller has
 * already established that Identity is on for the product, as the registry does before it
 * dispatches any `/identity/*` route.
 *
 * Only enrolling (`POST restore`), the restore grant and the discovery members read this. It is
 * checked BEFORE any lookup, so an off answer reads and consumes nothing. Nothing that revokes a
 * key reads it (`store.ts`): sign-out, `DELETE restore`, device removal, Connected apps removal,
 * the account's deletion and the 180-day sweep run whatever this says.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import {
  readRowSettings,
  type RowSettingProduct,
} from "../../../core/rowSettings.js";
import { getProduct } from "../../../core/products/store.js";
import { IDENTITY_RESTORE } from "../settings.js";

/** The product's `identity.restore` in force: true unless a developer switched it off. */
export async function readRestoreSetting(
  db: Db,
  product: RowSettingProduct,
): Promise<boolean> {
  const [view] = await readRowSettings(db, product, [IDENTITY_RESTORE]);
  return view!.value !== false;
}

/** Is silent restore served for this product now? The gate first: off reads nothing else. */
export async function restoreServed(
  env: Env,
  db: Db,
  slug: string,
): Promise<boolean> {
  if (!(await launchGateOn(env, db, "launch.identityRestore"))) return false;
  const row = await getProduct(db, slug);
  if (!row) return false;
  return readRestoreSetting(db, row);
}
