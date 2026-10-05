/**
 * The licence line of the app-consent view (WIRE-CONTRACT-V4 §12.7.3, plans/PX-W13.md §2.3).
 *
 * THE one place the passthrough reads licences. Licensing is under review (S-19): the holder of
 * account-wide entitlements is the account signed in on the device, each device has one anchor
 * licence chosen `rank-first`, and `licensing.entitlementModel` decides whether the others count.
 * Every assumption about how many licences or grants a device can draw on lives here, so a change
 * to that model changes this file and nothing else.
 *
 * The anchor is a DRY RUN: it writes nothing and binds nothing. Until I-09's inline rank-first
 * steps (and LX-10's `chooseAnchor`) land, it is the best usable licence in the portal's own order
 * (status, then no expiry, then the later expiry, then the newer activation). `more` counts the
 * account's other usable licences for THIS product under `combined`, never names and never other
 * products; under `legacy` it is 0. The model is `legacy` until LX-06 lands and ST-04's resolver
 * can read it.
 */

import type { ConsentItem } from "@polaris-key/protocol/identity";
import type { Db } from "../../../core/platform.js";
import type { ProductPublic } from "../../../core/products.js";
import { getTier } from "../../../core/data.js";
import { rankedLicensesFor } from "../portal/library.js";

/** S-19's `licensing.entitlementModel`. `legacy` reproduces today's documents byte for byte. */
export type EntitlementModel = "legacy" | "combined";

/** The product's entitlement model: `legacy` until LX-06 and ST-04's resolver land. */
export function entitlementModelFor(_product: ProductPublic): EntitlementModel {
  return "legacy";
}

/** The `license` consent item for `accountId` on `product`. */
export async function licenseConsentItem(
  db: Db,
  accountId: string,
  product: ProductPublic,
  now: number,
): Promise<Extract<ConsentItem, { kind: "license" }>> {
  const usable = (await rankedLicensesFor(db, accountId, product, now)).filter(
    (l) => l.status !== "suspended" && l.status !== "expired",
  );
  const best = usable[0];
  if (!best) return { kind: "license", anchor: null, more: 0 };
  const tier = best.row.tier_id
    ? await getTier(db, product.slug, best.row.tier_id)
    : null;
  const { deviceLimit, activeSeatCount } = best.seats;
  return {
    kind: "license",
    anchor: {
      name: tier?.label ?? product.name,
      tierName: tier?.label ?? null,
      term: best.row.expires_at ?? "perpetual",
      // The seat this device would take: the next one, or none when every seat is taken.
      seat:
        activeSeatCount < deviceLimit
          ? { position: activeSeatCount + 1, limit: deviceLimit }
          : null,
    },
    more: entitlementModelFor(product) === "combined" ? usable.length - 1 : 0,
  };
}
