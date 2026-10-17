/**
 * Distribution's settings slice (ST-03, notes/S-18 Appendix A.2 `distribution.*`), contributed
 * through the descriptor (`distributionService.settings`), never imported by Core (rule 6).
 */

import { RELEASE_PLATFORMS } from "@polaris-key/manifest";
import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "distribution", offBehaviour: "hide" } as const;

export const DISTRIBUTION_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["distribution"],
  entries: [
    setting({
      key: "distribution.access",
      rbacArea: "settings",
      scope: "product",
      service: "distribution",
      area: "distribution.access",
      label: "Download access",
      description:
        "Who may download each deliverable's bytes: anyone, a registered device, a licensed one, or an entitled one. Loosening it gives the files away.",
      keywords: ["artifacts", "downloads", "licensed", "public"],
      docs: "/docs/features/ship-builds/channels/delivery/",
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
    // ST-42 (SETUP W5): the platforms the operator plans to ship, answered at create ("What do
    // you ship?") before any build exists. Console-owned; a platform that has builds is shown
    // whether or not it is listed here. Unset means no answer yet.
    setting({
      key: "distribution.intendedPlatforms",
      scope: "product",
      service: "distribution",
      area: "distribution.outlets",
      label: "Planned platforms",
      description:
        "The platforms the product will ship on, before any build exists. Storefronts that do not fit them are left out of the catalogue.",
      keywords: ["platforms", "macos", "ios", "android", "windows", "linux"],
      docs: "/docs/features/ship-builds/channels/",
      value: {
        kind: "list",
        of: { kind: "enum", values: RELEASE_PLATFORMS },
        max: RELEASE_PLATFORMS.length,
      },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "operator",
      confirm: { change: "L0" },
      visibleWhen: VISIBLE,
      readers: ["core/products/createDefaults.ts"],
      storage: { kind: "scalar" },
      since: "ST-42",
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
      docs: "/docs/features/ship-builds/channels/",
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
      docs: "/docs/features/ship-builds/channels/",
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
    // ST-19b: `.pkey/distribution`'s `transports`. Every ingest deletes and rewrites the rows
    // (`outlets.ts`) and no admin route writes them, so the manifest owns them. A pack whose
    // transport on an outlet cannot float is pinned in the signed feed (`update/packParts.ts`).
    setting({
      key: "distribution.transports",
      scope: "product",
      service: "distribution",
      area: "distribution.outlets",
      label: "Transports",
      description:
        "Which transport carries each deliverable on each outlet: a deliverable's own entry, else the packs entry for a pack, else the default (pkey-cdn when unset).",
      keywords: ["pkey-cdn", "embedded", "play-pad", "apple-ba", "steam-depot"],
      docs: "/docs/features/ship-builds/channels/delivery/",
      value: { kind: "json", schema: "transports (distribution.schema.json)" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "manifest",
      manifest: { path: "distribution:transports" },
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      wire: ["document"],
      readers: [
        "services/distribution/outlets.ts",
        "services/distribution/availability.ts",
        "services/distribution/delivery.ts",
      ],
      storage: { kind: "rich", adapter: "dist_transports" },
      since: "ST-19b",
    }),
    // F-02/F-11: one `dist_registry_feeds` row per owner and ecosystem (enabled, access mode,
    // namespace, size cap). Console-owned: a feed is switched on from the Feeds page.
    setting({
      key: "distribution.feeds",
      scope: "product",
      service: "distribution",
      area: "distribution.feeds",
      label: "Package feeds",
      description:
        "Per ecosystem: whether the product's feed answers, who may read it, its namespace and the largest package it accepts. The platform's feeds policy bounds it.",
      keywords: ["npm", "pypi", "registry", "packages"],
      docs: "/docs/features/ship-builds/channels/",
      value: {
        kind: "json",
        schema: "dist_registry_feeds rows (registry/settings.ts)",
      },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "operator",
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      readers: [
        "services/distribution/registry/settings.ts",
        "services/distribution/registry/authorize.ts",
      ],
      storage: { kind: "rich", adapter: "dist_registry_feeds" },
      since: "ST-09",
    }),
    setting({
      key: "distribution.commerce",
      rbacArea: "commerce",
      scope: "product",
      service: "distribution",
      area: "distribution.commerce",
      label: "Commerce",
      description:
        "Which store purchases unlock what, and whether sandbox and test purchases count. Operator-only by design: a repo push must never decide which purchases unlock a flag.",
      keywords: ["purchases", "iap", "steam", "sandbox"],
      docs: "/docs/features/ship-builds/commerce/",
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
