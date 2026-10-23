/** The App Store's Commerce facet (P0-27.4). See `../facet.ts`. */

import type { CommerceFacet } from "../facet.js";
import { appleContext } from "./context.js";
import { verifyAppleNotification } from "./notifications.js";
import {
  AppleRejected,
  fetchTransaction,
  verifyAppleClaim,
  type AppleContext,
} from "./purchases.js";

export const APPLE_COMMERCE: Required<
  CommerceFacet<
    AppleContext,
    string,
    { verify: typeof verifyAppleNotification },
    { fetchTransaction: typeof fetchTransaction }
  >
> = {
  store: "app-store",
  adapter: "app-store",
  context: appleContext,
  enabled: (settings) => settings.appStore !== null,
  claim: {
    parse: (body) =>
      typeof body.signedTransaction === "string"
        ? { ok: true, input: body.signedTransaction }
        : { ok: false, message: "signedTransaction is required" },
    verify: async (ctx, signedTransaction) => ({
      purchase: await verifyAppleClaim(ctx, signedTransaction),
    }),
    rejection: (e) => (e instanceof AppleRejected ? e.reason : null),
  },
  notification: { verify: verifyAppleNotification },
  recheck: { fetchTransaction },
};
