/**
 * Commerce's settings slice (ST-03; CM-29 moved it from Distribution's `distribution.commerce`),
 * contributed through the descriptor (`commerceService.settings`), never imported by Core (rule 6).
 * Same storage as before (the `commerce` row of `dist_connector_settings`): production held no
 * value, so there is no alias.
 */

import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "commerce", offBehaviour: "hide" } as const;

export const COMMERCE_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["commerce"],
  entries: [
    setting({
      key: "commerce.stores",
      rbacArea: "commerce",
      scope: "product",
      service: "commerce",
      area: "commerce",
      label: "Commerce",
      description:
        "Which stores sell, and whether sandbox and test purchases count. Each store sells for the app typed here or, when left out, the app the product is assigned on that store. Operator-only by design: a repo push must never decide which purchases unlock a flag.",
      keywords: ["purchases", "iap", "steam", "sandbox"],
      docs: "/docs/features/commerce/",
      value: {
        kind: "json",
        schema: "commerce settings (settings.ts)",
      },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "operator",
      critical: true,
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: [
        "services/commerce/settings.ts",
        "services/commerce/identity.ts",
      ],
      storage: { kind: "rich", adapter: "dist_connector_settings" },
    }),
  ],
};
