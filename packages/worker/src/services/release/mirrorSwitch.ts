/**
 * Whether Polaris Key mirrors a product's release files (HA-08; notes/S-20 owner decision 6,
 * §6.8, §6.10). The ONE place the answer is read: the producers, the consumer and the legacy
 * download alias (`mirror.ts`, `source.ts`) all ask here.
 *
 * Owner decision 6: mirroring is ON by default for every product, existing ones included. HA-10
 * registered the two settings that turn it off, and this function reads them:
 *
 *   - `assets.hosting.enabled` (the platform kill switch, `core/assetHosting.ts`): off returns
 *     every consumer to today's behaviour: nothing is queued or copied, and the legacy alias
 *     streams from GitHub;
 *   - `assets.releases.mirror` (product, operator-owned, default on, `core/assetSettings.ts`):
 *     off copies no new file for that product, so GitHub serves the files without a copy, and the
 *     legacy alias streams from GitHub.
 *
 * And only for a product that exists and runs Release (a product with Release off has no truth
 * store to serve from). Copies already made stay valid either way: their `r2` locations are
 * hash-pinned. The release-file quota (`assets.quota.releaseBytes`) is not a switch: it stops new
 * copies (`mirror.ts`, `core/hostedAssets.ts`), never the serving of the ones already made.
 */

import type { Db } from "../../core/platform.js";
import { parseServices } from "../../core/services.js";
import { assetHostingEnabled } from "../../core/assetHosting.js";
import { productAssetSettings } from "../../core/assetSettings.js";
import type { SettingsEnv } from "../../core/platformSettings.js";
import type { ProductFacts } from "../../core/settings/resolve.js";

/** Does Polaris Key mirror `product`'s release files now? */
export async function releaseMirrorEnabled(
  env: SettingsEnv,
  db: Db,
  product: string,
): Promise<boolean> {
  if (!(await assetHostingEnabled(env, db))) return false;
  const row = await db.first<ProductFacts & { services_json: string | null }>(
    `SELECT * FROM products
      WHERE slug = ? AND deleted_at IS NULL AND COALESCE(status, 'active') != 'deleted'`,
    product,
  );
  if (!row) return false;
  if (!parseServices(row.services_json).services.release.enabled) return false;
  return (await productAssetSettings(env, db, row))?.releaseMirror ?? false;
}
