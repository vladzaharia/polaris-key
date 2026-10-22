/** The App Store's Commerce facet (P0-27.4). See `../facet.ts`. */

import type { CommerceFacet } from "../facet.js";
import { appleContext } from "./context.js";
import { verifyAppleNotification } from "./notifications.js";
import {
  fetchTransaction,
  verifyAppleClaim,
  type AppleContext,
} from "./purchases.js";

export const APPLE_COMMERCE: CommerceFacet<
  AppleContext,
  string,
  { verify: typeof verifyAppleNotification },
  { fetchTransaction: typeof fetchTransaction }
> = {
  store: "app-store",
  adapter: "app-store",
  context: appleContext,
  claim: {
    parse: (body) =>
      typeof body.signedTransaction === "string"
        ? { ok: true, input: body.signedTransaction }
        : { ok: false, message: "signedTransaction is required" },
    verify: (ctx, signedTransaction) =>
      verifyAppleClaim(ctx, signedTransaction),
  },
  notification: { verify: verifyAppleNotification },
  recheck: { fetchTransaction },
};
