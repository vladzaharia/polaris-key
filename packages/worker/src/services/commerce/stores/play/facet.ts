/** The Google Play Commerce facet (P0-27.4). See `../facet.ts`. */

import type { CommerceFacet } from "../facet.js";
import { playContext } from "./context.js";
import { decodeRtdn, verifyPushJwt } from "./notifications.js";
import {
  PlayRejected,
  acknowledgeOnce,
  getProductPurchase,
  isPlaySku,
  isPurchaseToken,
  listVoidedPurchases,
  playPurchase,
  playPurchasesClient,
  type PlayContext,
} from "./purchases.js";

export const PLAY_COMMERCE: Required<
  CommerceFacet<
    PlayContext,
    { productId: string; purchaseToken: string },
    { verifyPush: typeof verifyPushJwt; decode: typeof decodeRtdn },
    { listVoidedPurchases: typeof listVoidedPurchases }
  >
> = {
  store: "play",
  adapter: "google-play",
  context: playContext,
  enabled: (settings) => settings.play !== null,
  claim: {
    parse: (body) =>
      isPlaySku(body.productId) && isPurchaseToken(body.purchaseToken)
        ? {
            ok: true,
            input: {
              productId: body.productId,
              purchaseToken: body.purchaseToken,
            },
          }
        : { ok: false, message: "productId and purchaseToken are required" },
    verify: async (ctx, input) => {
      const api = playPurchasesClient(ctx, "commerce:claim");
      const purchase = playPurchase(
        ctx.settings,
        input.productId,
        input.purchaseToken,
        await getProductPurchase(api, input.productId, input.purchaseToken),
      );
      return {
        purchase,
        // Play's acknowledge comes after `recordPurchase`, on the same client; a failure never
        // fails the grant.
        settle: async (out) => {
          await acknowledgeOnce(ctx, api, out, purchase);
          return null;
        },
      };
    },
    rejection: (e) => (e instanceof PlayRejected ? e.reason : null),
  },
  notification: { verifyPush: verifyPushJwt, decode: decodeRtdn },
  recheck: { listVoidedPurchases },
};
