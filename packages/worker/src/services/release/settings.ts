/**
 * Release's settings slice (ST-03, notes/S-18 Appendix A.2 `release.*`), contributed through the
 * descriptor (`releaseService.settings`), never imported by Core (rule 6). The `.pkey/release`
 * block's own fields (ST-19b) live in `manifestSettings.ts` and are spread in after the
 * compatibility window.
 */

import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";
import { RELEASE_COLUMN_ADAPTERS } from "./settingsColumns.js";
import { RELEASE_MANIFEST_SETTINGS } from "./manifestSettings.js";

const VISIBLE = { service: "release", offBehaviour: "hide" } as const;

export const RELEASE_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["release"],
  // ST-04: how the entries stored in Release's tables are decoded and written.
  columns: RELEASE_COLUMN_ADAPTERS,
  entries: [
    setting({
      key: "release.compatWindow",
      scope: "product",
      service: "release",
      area: "release.compatibility",
      label: "Compatibility window",
      description:
        "The oldest and newest app versions a licence document admits. Builds outside it are refused at activation and refresh.",
      keywords: ["compatMin", "compatMax", "version window"],
      docs: "/docs/features/ship-builds/releases/compatibility/",
      value: { kind: "json", schema: "{ min, max } semver bounds" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "claimable",
      // One value, two sibling manifest fields (ST-19b): `alsoPaths` lets this entry declare
      // `compatMax` beside `compatMin` instead of a second entry for the same window. Storage
      // names `compat_min`; `compat_max` sits beside it and `compat_source` marks both.
      manifest: {
        path: "product:product.compatMin",
        alsoPaths: ["product:product.compatMax"],
      },
      confirm: { change: "L1" },
      visibleWhen: { service: "release", offBehaviour: "readOnly" },
      wire: ["discovery", "document"],
      readers: [
        "core/products.ts",
        "core/discovery.ts",
        "core/licensing/gate.ts",
      ],
      storage: { kind: "column", table: "products", column: "compat_min" },
    }),
    ...RELEASE_MANIFEST_SETTINGS,
    setting({
      key: "release.artifactPolicy",
      scope: "product",
      service: "release",
      area: "release.sync",
      label: "Artifact policy",
      description:
        "Which channels, architectures and installers a GitHub release must carry before it is accepted.",
      docs: "/docs/features/ship-builds/releases/artifacts/",
      value: { kind: "json", schema: "artifactPolicy (release.schema.json)" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "manifest",
      manifest: { path: "release:release.artifactPolicy" },
      confirm: { change: "L0" },
      visibleWhen: VISIBLE,
      readers: ["services/release/config.ts", "services/release/health.ts"],
      storage: {
        kind: "column",
        table: "release_config",
        column: "artifact_policy_json",
      },
    }),
    setting({
      key: "release.sparkleEd25519Pub",
      rbacArea: "keys",
      scope: "product",
      service: "release",
      area: "release.signing",
      label: "Sparkle update key",
      description:
        "The Ed25519 public key appcast signatures are checked against. Whoever holds the matching private key can sign updates.",
      keywords: ["sparkle", "appcast", "signature"],
      docs: "/docs/features/ship-builds/releases/github-sync/",
      value: { kind: "string", pattern: "^[A-Za-z0-9+/=]+$", maxLength: 64 },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "manifest",
      manifest: { path: "release:release.sparkleEd25519Pub" },
      securityWidening: true,
      widensWhen: "any",
      critical: true,
      confirm: { change: "L2" },
      visibleWhen: VISIBLE,
      // Update's discovery publishes it as `sparkleEd25519PublicKey` (`update/index.ts`).
      wire: ["discovery"],
      readers: ["services/release/sparkle.ts", "services/update/feed.ts"],
      storage: {
        kind: "column",
        table: "release_config",
        column: "sparkle_ed25519_pub",
      },
    }),
    setting({
      key: "release.packages.prunePrereleases",
      scope: "product",
      service: "release",
      area: "release.packages",
      label: "Prune builds of main",
      description:
        "Feed retention: when a package version is published on stable, delete that package's builds of main below it (X-main.N, PyPI X.devN) from every feed. Stable and beta versions are never touched; the bytes are reclaimed once nothing else references them. Off by default: a product opts in. Always on for the platform's own feeds.",
      keywords: [
        "retention",
        "prerelease",
        "main channel",
        "dev builds",
        "feeds",
        "cleanup",
      ],
      docs: "/docs/build/install/",
      value: { kind: "boolean" },
      // Off for a tenant product, which opts in; the system product is locked on (`prune.ts`).
      defaultValue: false,
      merge: "cascade",
      ownership: "operator",
      confirm: { on: "L1", off: "L0" },
      visibleWhen: VISIBLE,
      readers: [
        "services/release/packages/prune.ts",
        "console/handlers/feeds.ts",
      ],
      storage: {
        kind: "column",
        table: "release_package_retention",
        column: "prune_prereleases",
      },
      since: "feed-prune",
    }),
  ],
};
