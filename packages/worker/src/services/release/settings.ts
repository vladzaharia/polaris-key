/**
 * Release's settings slice (ST-03, notes/S-18 Appendix A.2 `release.*`), contributed through the
 * descriptor (`releaseService.settings`), never imported by Core (rule 6).
 */

import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "release", offBehaviour: "hide" } as const;

export const RELEASE_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["release"],
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
      docs: "/docs/services/release/compatibility/",
      value: { kind: "json", schema: "{ min, max } semver bounds" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:product.compatMin" },
      confirm: { change: "L1" },
      visibleWhen: { service: "release", offBehaviour: "readOnly" },
      wire: ["discovery", "document"],
      readers: ["core/products.ts", "core/discovery.ts", "core/gate.ts"],
      storage: { kind: "column", table: "products", column: "compat_min" },
    }),
    setting({
      key: "release.artifactPolicy",
      scope: "product",
      service: "release",
      area: "release.sync",
      label: "Artifact policy",
      description:
        "Which channels, architectures and installers a GitHub release must carry before it is accepted.",
      docs: "/docs/services/release/artifacts/",
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
      scope: "product",
      service: "release",
      area: "release.signing",
      label: "Sparkle update key",
      description:
        "The Ed25519 public key appcast signatures are checked against. Whoever holds the matching private key can sign updates.",
      keywords: ["sparkle", "appcast", "signature"],
      docs: "/docs/services/release/github-sync/",
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
      readers: ["services/release/sparkle.ts", "services/update/feed.ts"],
      storage: {
        kind: "column",
        table: "release_config",
        column: "sparkle_ed25519_pub",
      },
    }),
  ],
};
