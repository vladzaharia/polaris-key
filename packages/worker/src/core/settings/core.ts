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
import {
  GROUP_LABELS_MAX,
  LISTING_AUDIENCES,
  LISTING_STATES,
  OBTAIN_PATH_KINDS,
} from "../storefront/polarisKeyListing.js";

/**
 * The Polaris Key storefront's product settings (PS-02, notes/S-21 §6.2). Core's, not
 * Distribution's: every product can be listed whether or not it runs the distribution service.
 * Columns on Identity's `portal_product_settings` (migration 0075), beside `discover_enabled`,
 * which still forces `unlisted` until PS-11 (`core/storefront/polarisKeyListing.ts`).
 */
const STOREFRONT_DOCS = "/docs/services/identity/portal/#polaris-key-listing";
const STOREFRONT_READERS = [
  "core/storefront/polarisKeyListing.ts",
  "services/identity/portal/storefrontListing.ts",
  "services/identity/admin.ts",
] as const;
const storefrontColumn = (column: string) =>
  ({ kind: "column", table: "portal_product_settings", column }) as const;

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

  setting({
    key: "storefront.polarisKey.listed",
    scope: "product",
    service: "core",
    area: "storefront",
    label: "Listing",
    description:
      "Whether the Polaris Key library lists this product. Auto lists it where auto-issue or a mapped group would give it to the person (today's Discover); Listed adds every other way to obtain it; Unlisted hides it in the portal while every policy keeps working.",
    keywords: ["discover", "library", "storefront", "unlisted", "visibility"],
    docs: STOREFRONT_DOCS,
    value: { kind: "enum", values: LISTING_STATES },
    defaultValue: "auto",
    merge: "cascade",
    // Operator-only: a manifest must not publish a product to the storefront behind the
    // operator's back (S-18 D22's reasoning, which this entry supersedes).
    ownership: "operator",
    confirm: { change: "L1" },
    readers: STOREFRONT_READERS,
    storage: storefrontColumn("store_listed"),
    since: "PS-02",
  }),
  setting({
    key: "storefront.polarisKey.audience",
    scope: "product",
    service: "core",
    area: "storefront",
    label: "Audience",
    description:
      "Who sees the listing. Eligible shows it only to a person who can obtain it now; Everyone shows it to every signed-in person, the one exception to never revealing a product a person cannot get.",
    keywords: ["discover", "visibility", "enumeration", "everyone"],
    docs: STOREFRONT_DOCS,
    value: { kind: "enum", values: LISTING_AUDIENCES },
    defaultValue: "eligible",
    merge: "cascade",
    widensWhen: "higher",
    critical: true,
    ownership: "operator",
    // An ordered enum: up (toward everyone) is the typed, level-2 change (owner decision 5).
    confirm: { up: "L2", down: "L0" },
    readers: STOREFRONT_READERS,
    storage: storefrontColumn("store_audience"),
    since: "PS-02",
  }),
  setting({
    key: "storefront.polarisKey.offerPaths",
    scope: "product",
    service: "core",
    area: "storefront",
    label: "Ways to obtain",
    description:
      "Which reasons may list the product for a person (a mapped group, auto-issue, an open product, store ownership, the product's own sign-in, an email domain). Unset offers every one, including ways added later.",
    keywords: ["obtain paths", "eligibility", "discover"],
    docs: STOREFRONT_DOCS,
    value: {
      kind: "list",
      of: { kind: "enum", values: OBTAIN_PATH_KINDS },
      max: OBTAIN_PATH_KINDS.length,
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "operator",
    confirm: { change: "L1" },
    readers: STOREFRONT_READERS,
    storage: storefrontColumn("store_offer_paths_json"),
    since: "PS-02",
  }),
  setting({
    key: "storefront.polarisKey.groupLabels",
    scope: "product",
    service: "core",
    area: "storefront",
    label: "Group labels",
    description:
      'How an identity-provider group is named on the listing ("Included with Aperture Seven"), at most 40 characters. A group without a label shows as "For members of <group>".',
    keywords: ["groups", "copy", "discover"],
    docs: STOREFRONT_DOCS,
    value: {
      kind: "json",
      schema: `GroupLabels (core/storefront/polarisKeyListing.ts, ≤ ${GROUP_LABELS_MAX})`,
    },
    defaultValue: {},
    merge: "cascade",
    // S-21 §6.2 makes this claimable once `.pkey/product` carries `storefront.groupLabels`; until
    // the manifest has that field there is nothing to claim from, so it is operator-owned.
    ownership: "operator",
    confirm: { change: "L0" },
    readers: STOREFRONT_READERS,
    storage: storefrontColumn("store_group_labels_json"),
    since: "PS-02",
  }),
];
