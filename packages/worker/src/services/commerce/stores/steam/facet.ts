/** The Steam Commerce facet (P0-27.4). See `../facet.ts`. No push notifications. */

import { isStoreProductId } from "../../../../core/licensing/storeGrants.js";
import type { CommerceFacet } from "../facet.js";
import { steamContext } from "./context.js";
import {
  isSteamAppId,
  isSteamTicket,
  recheckSteamOwnership,
  verifySteamClaim,
  type SteamContext,
} from "./purchases.js";

export const STEAM_COMMERCE: CommerceFacet<
  SteamContext,
  { ticket: string; dlcAppId: string },
  never,
  { recheckSteamOwnership: typeof recheckSteamOwnership }
> = {
  store: "steam",
  adapter: "steam",
  context: steamContext,
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
    verify: (ctx, input, binding) =>
      verifySteamClaim(ctx, input.ticket, input.dlcAppId, binding),
  },
  recheck: { recheckSteamOwnership },
};
