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
 * Columns on Identity's `portal_product_settings` (migration 0085), beside `discover_enabled`,
 * which still forces `unlisted` until PS-11 (`core/storefront/polarisKeyListing.ts`).
 */
const STOREFRONT_DOCS = "/docs/services/identity/portal/";
const STOREFRONT_READERS = [
  "core/storefront/polarisKeyListing.ts",
  "services/identity/portal/storefrontListing.ts",
  "services/identity/admin.ts",
  // PS-03: the obtain-path engine resolves every candidate's listing from its candidate row.
  "services/identity/portal/store/obtain.ts",
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
    manifest: { path: "product:product.name" },
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
    manifest: { path: "product:product.adminGroup" },
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
    key: "core.manifest.authoritative",
    scope: "product",
    service: "core",
    area: "general",
    label: "Manifest-authoritative",
    description:
      "The product's .pkey/ is the only writer of its display name, licence defaults, web origins, catalog and licensing settings: a console edit to one is refused unless it is a break-glass claim, which needs a reason and expires after 7 days or at the first resync or deploy that changes that field, whichever comes first. Settings claimed through their older markers (services, the compatibility window, update access, the device policies) are not refused yet. Off by default; always on, and locked, for the system product.",
    keywords: ["break-glass", "gitops", "claims", "lock", "single writer"],
    docs: "/docs/admin/products/",
    value: { kind: "boolean" },
    defaultValue: false,
    merge: "cascade",
    ownership: "operator",
    confirm: { on: "L1", off: "L1" },
    // S-18 §4.5 item 8: the system product's settings come from the monorepo's root .pkey/ with
    // each deploy, so no row can turn this off there (the system-lock rule, `rules.ts`).
    systemLock: { value: true },
    readers: [
      // ST-04: the one write path decides it (`authority.ts`), for every route that claims.
      "core/settings/authority.ts",
      "core/settings/write.ts",
      "core/settingsClaims.ts",
      "admin/handlers/products.ts",
    ],
    storage: { kind: "scalar" },
    since: "ST-20",
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
  // ST-19b: `.pkey/product`'s `devices.registration`. It shares `services_json` with
  // `core.services` (the blob's `registration` key, `core/services.ts`): the console's Services
  // page writes it (`core/servicesAdmin.ts`, its own Save action) and that write claims the blob
  // through `services_source`, so it is claimable like the enablement beside it.
  setting({
    key: "core.registration",
    scope: "product",
    service: "core",
    area: "services",
    label: "Device registration",
    description:
      "Who may mint a device token: open, requires-identity or requires-license. Unset follows the services: requires-license with License on, else requires-identity with Identity on, else open. Opening it lets any client register a device.",
    keywords: ["devices.registration", "register", "device token", "open"],
    docs: "/docs/services/core/device-principal/",
    value: {
      kind: "enum",
      values: ["open", "requires-identity", "requires-license"],
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:devices.registration" },
    securityWidening: true,
    widensWhen: "any",
    critical: true,
    confirm: { change: "L1" },
    wire: ["discovery", "refusal"],
    readers: [
      "core/services.ts",
      "core/register.ts",
      "core/discovery.ts",
      "core/servicesAdmin.ts",
    ],
    storage: { kind: "column", table: "products", column: "services_json" },
    since: "ST-19b",
  }),
  // ST-19b: `.pkey/product`'s `secrets.required`, names only. A manifest names a secret and never
  // carries its value: an operator sets each value on Keys & secrets, sealed in `product_secrets`,
  // and only its presence is shown. No Worker file reads `secrets.required` yet (the validator
  // collects it for `pkey validate`; the console's setup check derives the required names from
  // `oidc` and `edgeMint`), so the entry is pending on ST-08 with no readers and storage `none`.
  // ST-08, which owns the `table:product_secrets` PENDING entry, extends this entry with that
  // table and its readers rather than registering a second one.
  setting({
    key: "core.secrets",
    scope: "product",
    service: "core",
    area: "keys",
    label: "Required secrets",
    description:
      "The names of the sealed secrets this product needs an operator to set (a custom OIDC client's secret, an edge-mint signing key). The manifest names them, never their values; each value is set on Keys & secrets and only its presence is ever shown.",
    keywords: [
      "secrets.required",
      "product secrets",
      "sealed",
      "missing secrets",
    ],
    docs: "/docs/admin/secrets-and-keys/",
    value: {
      kind: "json",
      schema:
        "secrets.required: uppercase names or { name } (product.schema.json)",
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "product:secrets.required" },
    sensitivity: "secret",
    confirm: { change: "L0" },
    storage: { kind: "none" },
    since: "ST-19b",
    pending: { wp: "ST-08" },
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
    // HA-04 added the manifest field; HA-12 stores it in its own manifest-only column (plans/HA-11.md
    // Q5) and carries the accents in discovery's `core.presentation` (WIRE-CONTRACT-V4 §5.5). The
    // column adapter is decode-only, so a console write is refused.
    storage: { kind: "column", table: "products", column: "presentation_json" },
    readers: [
      "core/products.ts",
      "core/presentation.ts",
      "core/discovery.ts",
      "services/identity/portal/library.ts",
    ],
    since: "ST-06",
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
