/**
 * Set a product's Polaris Key listing (`storefront.polarisKey.*`) the way the Worker does since
 * ST-04: through `writeSetting()`, the one write path, with the PS-02 rules applied by
 * `listingSettingWrites` (the Discover switch derives the listing state; `discover_enabled` stays
 * in step). Fixtures use it where they used to pass listing fields to the portal-settings upsert.
 */

import type { Db } from "../src/db/types.js";
import { SETTINGS } from "../src/mount.js";
import { writeSettings } from "../src/core/settings/write.js";
import {
  getPortalProductSettings,
  listingSettingWrites,
  type ListingPatch,
  type PortalProductSettingsRow,
} from "../src/services/identity/portal/repo.js";
import { NOW } from "./seed.js";
import { ROOT_PRINCIPAL } from "./rbacFixtures.js";

export async function writeListing(
  db: Db,
  slug: string,
  patch: ListingPatch,
  now: number = NOW,
): Promise<PortalProductSettingsRow> {
  const current = await getPortalProductSettings(db, slug);
  const res = await writeSettings(
    { env: {}, db, registry: SETTINGS },
    listingSettingWrites(current, patch),
    {
      actor: { sub: "test", name: null, email: null },
      origin: "console",
      principal: ROOT_PRINCIPAL,
      now,
      product: slug,
      strict: false,
    },
  );
  if (!res.ok) throw new Error(`writeListing(${slug}): ${res.message}`);
  return getPortalProductSettings(db, slug);
}
