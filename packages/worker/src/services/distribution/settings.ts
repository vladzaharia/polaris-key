/**
 * Distribution's settings slice (ST-03, notes/S-18 Appendix A.2 `distribution.*`), contributed
 * through the descriptor (`distributionService.settings`), never imported by Core (rule 6).
 */

import { RELEASE_PLATFORMS } from "@polaris-key/manifest";
import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";
import { DISTRIBUTION_ADAPTERS } from "./settingsAdapters.js";

const VISIBLE = { service: "distribution", offBehaviour: "hide" } as const;

export const DISTRIBUTION_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["distribution"],
  adapters: DISTRIBUTION_ADAPTERS,
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
      readers: [
        "core/products/createDefaults.ts",
        "services/distribution/facts.ts",
      ],
      storage: { kind: "scalar" },
      since: "ST-42",
    }),
    setting({
      key: "distribution.capabilities",
      scope: "product",
      service: "distribution",
      area: "distribution.outlets",
      label: "What each channel allows",
      description:
        "What an install that arrived through each channel may do (fetch new code, run downloaded scripts, sell things). The starting point is the compiled default for the channel's kind; an operator may only narrow it.",
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
      label: "Channels",
      description:
        "The channels the product is distributed through (direct, App Store, Play, Steam, …) with each store's identity for it.",
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
        "Which transport carries each deliverable on each channel: a deliverable's own entry, else the packs entry for a pack, else the default (pkey-cdn when unset).",
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
    // F-34.3: the owner's `packageFeeds` switch, the one off switch of every package feed of the
    // product (reads, publishes, renders). The manifest provisions the row on (F-34.2) only for a
    // product that has none; it never turns it back on. Operator-owned: turning it off is L1.
    setting({
      key: "distribution.packageFeeds",
      scope: "product",
      service: "distribution",
      area: "distribution.feeds",
      label: "Serve package feeds",
      description:
        "Whether the product's package feeds answer at all. Off stops every read and publish of every feed at once; nothing is deleted, and turning it on serves them again.",
      keywords: ["feeds", "packages", "registry", "off switch", "kill switch"],
      docs: "/docs/features/ship-builds/channels/",
      value: { kind: "boolean" },
      defaultValue: false,
      merge: "cascade",
      ownership: "operator",
      confirm: { on: "L0", off: "L1" },
      visibleWhen: VISIBLE,
      readers: [
        "services/distribution/registryFeeds.ts",
        "services/distribution/registry/settings.ts",
        "services/distribution/registryMaterialiser.ts",
        "services/release/packages/native/publish.ts",
        "services/release/packages/ociPush.ts",
        "services/identity/portal/api.ts",
      ],
      storage: { kind: "rich", adapter: "dist_registry_owners" },
      since: "F-34.3",
    }),
    // F-02/F-11: one `dist_registry_feeds` row per owner and ecosystem (enabled, access mode,
    // namespace, size cap). Not console-created: the ingest INSERTS a missing row from
    // `.pkey/release` (F-34.2: Customers, the derived namespace) and nothing else. `operator`
    // means there is no manifest path that sets a value: a row that exists is the operator's, and
    // the manifest never updates, re-enables or widens it (F-34.2, rule: widening is operator-only).
    setting({
      key: "distribution.feeds",
      scope: "product",
      service: "distribution",
      area: "distribution.feeds",
      label: "Package feeds",
      description:
        "Per ecosystem: whether the product's feed answers, who may read it (Public or Customers), its namespace and the largest package it accepts. A package declared in .pkey/release gets a Customers feed on the first sync; only the operator makes it Public. The platform's feeds policy bounds it, and Serve package feeds switches all of them off.",
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
        "services/distribution/ingest.ts",
      ],
      storage: { kind: "rich", adapter: "dist_registry_feeds" },
      since: "ST-09",
    }),
  ],
};
