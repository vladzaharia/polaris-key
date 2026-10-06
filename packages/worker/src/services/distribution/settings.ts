/**
 * Distribution's settings slice (ST-03, notes/S-18 Appendix A.2 `distribution.*`), contributed
 * through the descriptor (`distributionService.settings`), never imported by Core (rule 6).
 */

import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "distribution", offBehaviour: "hide" } as const;

export const DISTRIBUTION_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["distribution"],
  entries: [
    setting({
      key: "distribution.access",
      scope: "product",
      service: "distribution",
      area: "distribution.access",
      label: "Download access",
      description:
        "Who may download each deliverable's bytes: anyone, a registered device, a licensed one, or an entitled one. Loosening it gives the files away.",
      keywords: ["artifacts", "downloads", "licensed", "public"],
      docs: "/docs/services/distribution/delivery/",
      value: { kind: "json", schema: "dist_access rows (access.ts)" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "release:release.access.artifacts" },
      securityWidening: true,
      widensWhen: "any",
      critical: true,
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: [
        "services/distribution/access.ts",
        "services/distribution/bytes.ts",
      ],
      storage: { kind: "rich", adapter: "dist_access" },
    }),
    setting({
      key: "distribution.capabilities",
      scope: "product",
      service: "distribution",
      area: "distribution.outlets",
      label: "Outlet capabilities",
      description:
        "What an install that arrived through each outlet may do (fetch new code, run downloaded scripts, sell things). The starting point is the compiled default for the outlet's kind; an operator may only narrow it.",
      keywords: ["codeUpdates", "downloadedScripts", "commerce", "outlets"],
      docs: "/docs/services/distribution/",
      value: {
        kind: "json",
        schema: "CapabilitySet per outlet (capabilities.ts)",
      },
      defaultValue: null,
      allowUnset: true,
      // S-18 A.2 lists this as narrow-only from the manifest; the code says otherwise:
      // `.pkey/distribution` may not mention capabilities at all
      // (`capabilities_not_manifest_writable`). Operator-owned, narrowing the compiled defaults.
      merge: "cascade",
      ownership: "operator",
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: ["services/distribution/capabilities.ts"],
      storage: { kind: "rich", adapter: "dist_outlets" },
    }),
    setting({
      key: "distribution.outlets",
      scope: "product",
      service: "distribution",
      area: "distribution.outlets",
      label: "Outlets",
      description:
        "The places the product is distributed (direct, App Store, Play, Steam, …) with each store's identity for it.",
      keywords: ["stores", "appleId", "bundleId", "packageName"],
      docs: "/docs/services/distribution/",
      value: { kind: "json", schema: "outlets (distribution.schema.json)" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "manifest",
      manifest: { path: "distribution:outlets" },
      confirm: { change: "L0" },
      visibleWhen: VISIBLE,
      readers: ["services/distribution/outlets.ts"],
      storage: { kind: "rich", adapter: "dist_outlets" },
    }),
    setting({
      key: "distribution.commerce",
      scope: "product",
      service: "distribution",
      area: "distribution.commerce",
      label: "Commerce",
      description:
        "Which store purchases unlock what, and whether sandbox and test purchases count. Operator-only by design: a repo push must never decide which purchases unlock a flag.",
      keywords: ["purchases", "iap", "steam", "sandbox"],
      docs: "/docs/services/distribution/commerce/",
      value: {
        kind: "json",
        schema: "commerce settings (commerce/settings.ts)",
      },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "operator",
      critical: true,
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: ["services/distribution/commerce/settings.ts"],
      storage: { kind: "rich", adapter: "dist_connector_settings" },
    }),
  ],
};
