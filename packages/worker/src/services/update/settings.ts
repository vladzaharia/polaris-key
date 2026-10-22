/**
 * Update's settings slice (ST-03, notes/S-18 Appendix A.2 `update.*`), contributed through the
 * descriptor (`updateService.settings`), never imported by Core (rule 6).
 */

import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";
import { UPDATE_COLUMN_ADAPTERS } from "../release/settingsColumns.js";
import { UPDATE_ADAPTERS } from "../release/settingsAdapters.js";

const VISIBLE = { service: "update", offBehaviour: "hide" } as const;

export const UPDATE_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["update"],
  // ST-04: the access mode lives in Release's `release_config`, so Release's adapter writes it
  // (Update → Release is the one sanctioned cross-service edge, D-05). The operator policy is a
  // `product_settings` row since ST-11.
  columns: UPDATE_COLUMN_ADAPTERS,
  adapters: UPDATE_ADAPTERS,
  entries: [
    setting({
      key: "update.metadataAccess",
      rbacArea: "settings",
      scope: "product",
      service: "update",
      area: "update.access",
      label: "Release metadata access",
      description:
        "Who may read release metadata and update feeds: anyone, a registered device, or a licensed one. Loosening it exposes what the product ships.",
      keywords: ["public", "licensed", "authenticated", "entitled", "feed"],
      docs: "/docs/features/ship-builds/updates/",
      value: {
        kind: "enum",
        values: ["public", "authenticated", "licensed", "entitled"],
      },
      defaultValue: "public",
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "release:release.access.metadata" },
      securityWidening: true,
      widensWhen: "any",
      critical: true,
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: [
        "services/release/settingsAdapters.ts",
        "services/release/access.ts",
      ],
      storage: {
        kind: "column",
        table: "release_config",
        column: "metadata_access",
      },
    }),
    setting({
      key: "update.operatorPolicy",
      scope: "product",
      service: "update",
      area: "update.policy",
      label: "Operator update policy",
      description:
        "Operator-owned update requirements no manifest can loosen: a required Sparkle signature and the minimum OS.",
      docs: "/docs/features/ship-builds/updates/",
      value: { kind: "json", schema: "operator_policy_json (update/admin.ts)" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "operator",
      critical: true,
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: [
        "services/update/feed.ts",
        "services/release/settingsAdapters.ts",
      ],
      storage: { kind: "scalar" },
    }),
  ],
};
