/**
 * Commerce's public surface for the console (`test/boundaries.test.ts`): the one module under
 * `services/commerce/` that `console/` may import.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { setupOf } from "./admin.js";
import { readCommerceSettings } from "./settings.js";

/** The stores that can sell now: their settings are saved and the credential resolves. The same
 *  answer as the Commerce overview's per-store status (`setupOf`). */
export async function readyStorefronts(
  env: Env,
  db: Db,
  slug: string,
): Promise<number> {
  const setup = await setupOf(
    { env, db, product: { slug } },
    await readCommerceSettings(db, slug),
  );
  return Object.values(setup).filter((s) => s.configured).length;
}
