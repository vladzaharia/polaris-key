/**
 * Config's settings slice (ST-03, notes/S-18 Appendix A.2 `config.*`), contributed through the
 * descriptor (`configService.settings`), never imported by Core (rule 6).
 *
 * Not to be confused with what Config DELIVERS: catalog keys, flags and secrets are customer
 * config (S-18 §4.1), not Polaris settings. The catalog appears here only as the one claimable
 * unit an operator may edit in the console (S-18 D3).
 */

import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "config", offBehaviour: "hide" } as const;

export const CONFIG_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["config"],
  entries: [
    setting({
      key: "config.catalog",
      scope: "product",
      service: "config",
      area: "config.catalog",
      label: "Config catalog",
      description:
        "The product's catalog of config keys, flags and secrets, claimed as one unit: a console edit claims the whole catalog.",
      keywords: ["schema", "flags", "keys"],
      docs: "/docs/features/managed-config/catalog/",
      value: { kind: "json", schema: "schema.schema.json" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "schema:entries" },
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: ["core/data.ts"],
      storage: { kind: "rich", adapter: "product_schema" },
    }),
    setting({
      key: "config.profiles",
      scope: "product",
      service: "config",
      area: "config.profiles",
      label: "Profiles",
      description:
        "Reusable managed-payload baselines tiers point at. Each row is claimed on its own (S-18 D3).",
      docs: "/docs/features/managed-config/profiles/",
      value: { kind: "json", schema: "profiles (product.schema.json)" },
      defaultValue: [],
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:licensing.profiles" },
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      wire: ["document"],
      readers: ["services/config/document.ts"],
      storage: { kind: "rich", adapter: "profiles" },
    }),
    setting({
      key: "config.edgeMint.recipes",
      scope: "product",
      service: "config",
      area: "config.edgeMint",
      label: "Edge-mint recipes",
      description:
        "Recipes that mint short-lived third-party credentials at the edge for licensed devices. Each recipe still needs an operator approval.",
      docs: "/docs/features/managed-config/edge-mint/",
      value: { kind: "json", schema: "edgeMint (product.schema.json)" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:edgeMint" },
      critical: true,
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: ["services/config/mint.ts"],
      storage: { kind: "rich", adapter: "edge_mint_config" },
    }),
  ],
};
