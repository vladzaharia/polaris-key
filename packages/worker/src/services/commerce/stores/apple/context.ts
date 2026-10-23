/** The apple store context a product is set up for (settings plus a pinned credential).
 *  Moved out of `bridge.ts` by P0-27.4 so a facet can name it without importing the bridge. */

import type { ServiceContext } from "../../../../core/registry.js";
import type { CommerceSettings } from "../../settings.js";
import { appStoreCredential, type AppleContext } from "./purchases.js";

export async function appleContext(
  ctx: Pick<ServiceContext, "env" | "db" | "now"> & {
    product: { slug: string };
  },
  settings: CommerceSettings,
): Promise<AppleContext | null> {
  if (!settings.appStore) return null;
  const credentialId = await appStoreCredential(
    ctx.env,
    ctx.db,
    ctx.product.slug,
    settings.appStore.bundleId,
  );
  if (!credentialId) return null;
  return {
    env: ctx.env,
    db: ctx.db,
    product: ctx.product.slug,
    now: ctx.now,
    settings: settings.appStore,
    credentialId,
  };
}
