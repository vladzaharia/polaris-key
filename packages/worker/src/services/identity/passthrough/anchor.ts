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
 * products; under `legacy` it is 0. The model is `legacy` for every product until LX-09 ships
 * (the lead's decision D1 on LX-06: the combined model changes behaviour only with LX-09, which
 * moves `COMBINED_ENTITLEMENT_MODEL_SINCE` to its own deploy time). The plumbing is in place:
 * `resolvedEntitlementModel` reads the product's `licensing.entitlementModel` through ST-04's
 * resolver, and LX-09 switches `entitlementModelFor` to it.
 */

import type { ConsentItem } from "@polaris-key/protocol/identity";
import type { Db, Env } from "../../../core/platform.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { resolveProductSetting } from "../../../core/settings/resolve.js";
import type { ProductPublic } from "../../../core/products.js";
import { getTier } from "../../../core/data.js";
import { rankedLicensesFor } from "../portal/library.js";

/** S-19's `licensing.entitlementModel`. `legacy` reproduces today's documents byte for byte. */
export type EntitlementModel = "legacy" | "combined";

/** The registry key of the model (License's slice; read through the resolver, rule 6). */
const ENTITLEMENT_MODEL_KEY = "licensing.entitlementModel";

/**
 * The product's entitlement model as the licence line uses it: `legacy`, for every product, until
 * LX-09 ships (decision D1 on LX-06: until then only the displayed default changes, and LX-09
 * moves the cut-over to its own deploy time). LX-09 returns `resolvedEntitlementModel(ctx,
 * product)` here.
 */
export async function entitlementModelFor(
  _ctx: { env: Env; db: Db; registry?: SettingsRegistry },
  _product: ProductPublic,
): Promise<EntitlementModel> {
  return "legacy";
}

/**
 * The product's `licensing.entitlementModel`, resolved (ST-04's resolver: its `legacyDefault`
 * before the cut-over, the manifest or a console claim over it). A caller without the settings
 * registry (a context built by hand) reads `legacy`, which reproduces today's documents byte for
 * byte, as does any value the registry does not know. Not read until LX-09 (see above).
 */
export async function resolvedEntitlementModel(
  ctx: { env: Env; db: Db; registry?: SettingsRegistry },
  product: ProductPublic,
): Promise<EntitlementModel> {
  if (!ctx.registry?.get(ENTITLEMENT_MODEL_KEY, "product")) return "legacy";
  const r = await resolveProductSetting(
    { env: ctx.env, db: ctx.db, registry: ctx.registry },
    product.slug,
    ENTITLEMENT_MODEL_KEY,
  );
  return r?.value === "combined" ? "combined" : "legacy";
}

/** The `license` consent item for `accountId` on `product`. */
export async function licenseConsentItem(
  db: Db,
  accountId: string,
  product: ProductPublic,
  now: number,
  settings?: { env: Env; registry?: SettingsRegistry },
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
    more:
      settings &&
      (await entitlementModelFor({ ...settings, db }, product)) === "combined"
        ? usable.length - 1
        : 0,
  };
}
