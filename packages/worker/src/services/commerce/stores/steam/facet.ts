/** The Steam Commerce facet (P0-27.4). See `../facet.ts`. No push notifications. */

import { isStoreProductId } from "../../../../core/licensing/storeGrants.js";
import type { CommerceFacet } from "../facet.js";
import { steamContext } from "./context.js";
import { getPurchase, getStoreProduct, purchaseKeyHash } from "../../state.js";
import {
  SteamRejected,
  isSteamAppId,
  isSteamTicket,
  recheckSteamOwnership,
  verifySteamClaim,
  type SteamContext,
} from "./purchases.js";

type SteamRecheck = { recheckSteamOwnership: typeof recheckSteamOwnership };

export const STEAM_COMMERCE: CommerceFacet<
  SteamContext,
  { ticket: string; dlcAppId: string },
  never,
  SteamRecheck
> & { recheck: SteamRecheck } = {
  store: "steam",
  adapter: "steam",
  context: steamContext,
  enabled: (settings) => settings.steam !== null,
  claim: {
    // The two refusals keep today's order: shape first, then the Steam app id check.
    parse: (body) => {
      if (!isSteamTicket(body.ticket) || !isSteamAppId(body.dlcAppId))
        return {
          ok: false,
          message: "ticket (hex) and dlcAppId are required",
        };
      if (!isStoreProductId("steam", body.dlcAppId))
        return { ok: false, message: "dlcAppId must be a Steam app id" };
      return {
        ok: true,
        input: { ticket: body.ticket, dlcAppId: body.dlcAppId },
      };
    },
    // A-16: only an app this product mapped is ever asked about. Without this a device could use
    // the product's (or the platform group's) publisher key as an ownership oracle for any app
    // the key may query. The refusal is the same as a non-owner's, so it says nothing.
    guard: async (ctx, input) =>
      (await getStoreProduct(ctx.db, ctx.product, "steam", input.dlcAppId))
        ? null
        : "not_owned",
    verify: async (ctx, input, binding) => {
      const purchase = await verifySteamClaim(
        ctx,
        input.ticket,
        input.dlcAppId,
        binding,
      );
      if (purchase.state !== "active") {
        // A non-owner gets nothing; one who owned it before loses the grant.
        const hash = await purchaseKeyHash("steam", purchase.purchaseKey);
        if (!(await getPurchase(ctx.db, ctx.product, "steam", hash)))
          throw new SteamRejected("not_owned");
      }
      return {
        purchase,
        settle: async (out) => (out.state !== "active" ? "not_owned" : null),
      };
    },
    rejection: (e) => (e instanceof SteamRejected ? e.reason : null),
  },
  recheck: { recheckSteamOwnership },
};
