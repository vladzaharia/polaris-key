/**
 * Whether Polaris Key mirrors a product's release files (HA-08; notes/S-20 owner decision 6,
 * §6.8, §6.10). The ONE place the answer is read: the producers, the consumer and the legacy
 * download alias (`mirror.ts`, `source.ts`) all ask here.
 *
 * Owner decision 6: mirroring is ON by default for every product, existing ones included. HA-10
 * registers the two settings that can turn it off, and this function then reads them:
 *
 *   - `assets.releases.mirror` (product, operator-owned): off keeps GitHub-only serving for that
 *     product;
 *   - `assets.hosting.enabled` (platform kill switch): off returns every consumer to today's
 *     behaviour.
 *
 * Until then the answer is the code default, `RELEASE_MIRROR_DEFAULT`, for every product that
 * exists and runs Release (a product with Release off has no truth store to serve from). Copies
 * already made stay valid either way: their `r2` locations are hash-pinned.
 */

import type { Db, Env } from "../../core/platform.js";
import { parseServices } from "../../core/services.js";

/** The code default until HA-10 registers `assets.releases.mirror`: on (owner decision 6). */
export const RELEASE_MIRROR_DEFAULT = true;

/** Does Polaris Key mirror `product`'s release files now? */
export async function releaseMirrorEnabled(
  _env: Pick<Env, "BLOBS">,
  db: Db,
  product: string,
): Promise<boolean> {
  if (!RELEASE_MIRROR_DEFAULT) return false;
  const row = await db.first<{ services_json: string | null }>(
    `SELECT services_json FROM products
      WHERE slug = ? AND deleted_at IS NULL AND COALESCE(status, 'active') != 'deleted'`,
    product,
  );
  if (!row) return false;
  return parseServices(row.services_json).services.release.enabled;
}
