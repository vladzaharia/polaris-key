/**
 * Identity's `discoverVisibility` descriptor hook (LK-12b, `core/hooks.ts`): would a new account,
 * signed in and holding nothing, be offered this product to add in Discover? The download page
 * reads it to decide whether to show "Add to library".
 *
 * It is the storefront engine's own persona preview (`previewPersona`) for the most ordinary
 * person there is: a platform account with no groups, no verified email domain, no linked store
 * and nothing in its library. So the answer cannot drift from Discover: the deployment switch,
 * the product's portal and its `listed` setting, purchase-only and operator-issued products
 * (no path), and the audience all come from the engine. A link-only listing (audience
 * `everyone`, nothing to add) is not "Add to library", so only an `add` verdict counts.
 * Read-only; no account row is read.
 */

import type { HookContext } from "../../../../core/hooks.js";
import { previewPersona, type Persona } from "./obtain.js";

/** A new account: signed in with the platform IdP, nothing else, nothing held. */
const NEW_ACCOUNT: Persona = {
  platformAccount: true,
  groups: [],
  emailDomain: null,
  stores: [],
  holds: false,
};

export async function discoverVisibility(ctx: HookContext): Promise<boolean> {
  const preview = await previewPersona(
    ctx.env,
    ctx.db,
    ctx.product.slug,
    NEW_ACCOUNT,
    ctx.now,
    { hooksFor: () => ctx.hooks },
  );
  return preview.verdict.visible && preview.verdict.cta === "add";
}
