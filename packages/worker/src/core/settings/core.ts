/**
 * Core's product slice (ST-03, notes/S-18 Appendix A.2 `core.*`): product settings no opt-in
 * service owns. Most are still columns on `products`; ST-01b gives them `source` claims and
 * later packages move them into `product_settings` (`storage` says where each lives today).
 *
 * Seeded with the settings that already exist and that the rules must see from the start (the
 * security-widening ones). The rest of A.2's `core.*` rows are registered by the packages that
 * build them (ST-06's coverage test lists what is still pending).
 */

import { setting } from "./define.js";
import type { SettingDef } from "./types.js";

export const CORE_SLICE: readonly SettingDef[] = [
  setting({
    key: "core.name",
    scope: "product",
    service: "core",
    area: "general",
    label: "Product name",
    description:
      "The display name shown in the console, the portal and the discovery document.",
    docs: "/docs/admin/products/",
    value: { kind: "string", maxLength: 200 },
    defaultValue: "",
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:name" },
    confirm: { change: "L0" },
    wire: ["discovery"],
    readers: ["core/products.ts", "core/discovery.ts"],
    storage: { kind: "column", table: "products", column: "name" },
  }),
  setting({
    key: "core.adminGroup",
    scope: "product",
    service: "core",
    area: "access",
    label: "Admin group",
    description:
      "The identity-provider group named by the manifest as this product's administrators. Manifest-only (owner decision 1).",
    docs: "/docs/admin/products/",
    value: { kind: "string", maxLength: 200 },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "product:adminGroup" },
    securityWidening: true,
    widensWhen: "any",
    critical: true,
    confirm: { change: "L1" },
    readers: ["core/products.ts", "admin/api.ts"],
    storage: { kind: "column", table: "products", column: "admin_group" },
  }),
  setting({
    key: "core.web.origins",
    scope: "product",
    service: "core",
    area: "access",
    label: "Web origins",
    description:
      "Browser origins allowed to call this product's endpoints (the CORS allow-list). Adding one lets that site's scripts call the product.",
    keywords: ["cors", "origin", "browser"],
    docs: "/docs/build/onboarding/",
    value: {
      kind: "list",
      of: { kind: "string", pattern: "^https?://", maxLength: 2048 },
      max: 50,
    },
    defaultValue: [],
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:web.origins" },
    securityWidening: true,
    widensWhen: "any",
    critical: true,
    confirm: { change: "L1" },
    wire: ["header"],
    readers: ["core/products.ts", "core/cors.ts"],
    storage: { kind: "column", table: "products", column: "web_origins_json" },
  }),
  setting({
    key: "core.services",
    scope: "product",
    service: "core",
    area: "services",
    label: "Services",
    description:
      "Which opt-in services this product runs. A service that is off does not exist from outside.",
    keywords: ["modules", "enablement"],
    docs: "/docs/admin/services-enablement/",
    value: { kind: "json", schema: "ServicesMap (core/services.ts)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:modules" },
    confirm: { change: "L1" },
    wire: ["discovery"],
    readers: ["core/services.ts", "core/registry.ts", "core/discovery.ts"],
    storage: { kind: "column", table: "products", column: "services_json" },
  }),
  setting({
    key: "core.presentation",
    scope: "product",
    service: "core",
    area: "general",
    label: "Icon and accent",
    description:
      "The product's icon and accent colours (light and dark), declared in .pkey/product and shown by the console, the portal and the SDK UI kits. Manifest-only.",
    keywords: ["icon", "accent", "brand", "colour", "color"],
    docs: "/docs/build/manifest/",
    value: {
      kind: "json",
      schema: "ManifestPresentation (@polaris-key/manifest)",
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "product:presentation" },
    confirm: { change: "L0" },
    wire: ["discovery"],
    storage: { kind: "scalar" },
    since: "ST-06",
    // HA-04 added the manifest field; HA-12 stores it and carries it in discovery.
    pending: { wp: "HA-12" },
  }),
  setting({
    key: "core.trustPolicy",
    scope: "product",
    service: "core",
    area: "access",
    label: "Device trust policy",
    description:
      "Which attestation a device must present to enrol (App Attest, Play Integrity) and whether it is enforced. Relaxing it lets unattested clients enrol.",
    keywords: ["attestation", "app attest", "play integrity"],
    docs: "/docs/services/core/device-trust/",
    value: { kind: "json", schema: "TrustPolicy (core/deviceTrust.ts)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "operator",
    securityWidening: true,
    widensWhen: "any",
    critical: true,
    confirm: { change: "L2" },
    readers: ["core/products.ts", "core/deviceTrust.ts"],
    storage: {
      kind: "column",
      table: "products",
      column: "trust_policy_json",
    },
  }),
];
