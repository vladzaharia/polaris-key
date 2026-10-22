/** The Google Play Commerce facet (P0-27.4). See `../facet.ts`. */

import type { CommerceFacet } from "../facet.js";
import { playContext } from "./context.js";
import { decodeRtdn, verifyPushJwt } from "./notifications.js";
import {
  getProductPurchase,
  isPlaySku,
  isPurchaseToken,
  listVoidedPurchases,
  playPurchase,
  playPurchasesClient,
  type PlayContext,
} from "./purchases.js";

export const PLAY_COMMERCE: CommerceFacet<
  PlayContext,
  { productId: string; purchaseToken: string },
  { verifyPush: typeof verifyPushJwt; decode: typeof decodeRtdn },
  { listVoidedPurchases: typeof listVoidedPurchases }
> = {
  store: "play",
  adapter: "google-play",
  context: playContext,
  claim: {
    parse: (body) =>
      isPlaySku(body.productId) && isPurchaseToken(body.purchaseToken)
        ? {
            ok: true,
            input: { productId: body.productId, purchaseToken: body.purchaseToken },
          }
        : { ok: false, message: "productId and purchaseToken are required" },
    verify: async (ctx, input) =>
      playPurchase(
        ctx.settings,
        input.productId,
        input.purchaseToken,
        await getProductPurchase(
          playPurchasesClient(ctx, "commerce:claim"),
          input.productId,
          input.purchaseToken,
        ),
      ),
  },
  notification: { verifyPush: verifyPushJwt, decode: decodeRtdn },
  recheck: { listVoidedPurchases },
};
