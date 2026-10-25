/** The play store context a product is set up for (settings plus a pinned credential).
 *  Moved out of `bridge.ts` by P0-27.4 so a facet can name it without importing the bridge. */

import type { ServiceContext } from "../../../../core/registry.js";
import type { CommerceSettings } from "../../settings.js";
import {
  effectivePlaySettings,
  playCredential,
  type PlayContext,
} from "./purchases.js";

export async function playContext(
  ctx: Pick<ServiceContext, "env" | "db" | "now"> & {
    product: { slug: string };
  },
  settings: CommerceSettings,
): Promise<PlayContext | null> {
  if (!settings.play) return null;
  const credentialId = await playCredential(
    ctx.env,
    ctx.db,
    ctx.product.slug,
    settings.play.packageName,
  );
  if (!credentialId) return null;
  return {
    env: ctx.env,
    db: ctx.db,
    product: ctx.product.slug,
    now: ctx.now,
    // A-16: the platform's RTDN push identity where the product leaves it unset.
    settings: await effectivePlaySettings(ctx.env, ctx.db, settings.play),
    credentialId,
  };
}
