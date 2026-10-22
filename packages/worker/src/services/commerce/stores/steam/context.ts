/** The steam store context a product is set up for (settings plus a pinned credential).
 *  Moved out of `bridge.ts` by P0-27.4 so a facet can name it without importing the bridge. */

import type { ServiceContext } from "../../../../core/registry.js";
import type { CommerceSettings } from "../../settings.js";
import { steamCredential, type SteamContext } from "./purchases.js";

export async function steamContext(
  ctx: Pick<ServiceContext, "env" | "db" | "now"> & {
    product: { slug: string };
  },
  settings: CommerceSettings,
): Promise<SteamContext | null> {
  if (!settings.steam) return null;
  const credentialId = await steamCredential(
    ctx.env,
    ctx.db,
    ctx.product.slug,
    settings.steam.appId,
  );
  if (!credentialId) return null;
  return {
    env: ctx.env,
    db: ctx.db,
    product: ctx.product.slug,
    now: ctx.now,
    settings: settings.steam,
    credentialId,
  };
}
