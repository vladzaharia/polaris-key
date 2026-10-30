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
import { SETUP_SCHEMA } from "./rules.js";
import { EMPTY_SETUP } from "./setupShape.js";
import type { SettingDef } from "./types.js";
import {
  ASSET_MEDIA_QUOTA_DEFAULT,
  ASSET_MEDIA_QUOTA_MAX,
  ASSET_RELEASE_QUOTA_DEFAULT,
  ASSET_RELEASE_QUOTA_MAX,
  ASSETS_DOCS,
} from "./platform.js";
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
const STOREFRONT_DOCS = "/docs/features/sign-in/customer-portal/";
const STOREFRONT_READERS = [
  "core/storefront/polarisKeyListing.ts",
  "services/identity/portal/storefrontListing.ts",
  "services/identity/admin.ts",
  // PS-03: the obtain-path engine resolves every candidate's listing from its candidate row.
  "services/identity/portal/store/obtain.ts",
] as const;
const storefrontColumn = (column: string) =>
  ({ kind: "column", table: "portal_product_settings", column }) as const;

const PLATFORM_DOCS_PATH = "/docs/operate/platform/settings/";

export const CORE_SLICE: readonly SettingDef[] = [
  setting({
    key: "core.name",
    scope: "product",
    service: "core",
    area: "general",
    label: "Product name",
    description:
      "The display name shown in the console, Polaris Locker and the discovery document.",
    docs: "/docs/operate/console/products/",
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
    rbacArea: "settings",
    scope: "product",
    service: "core",
    area: "access",
    label: "Admin group",
    description:
      "Retired: the manifest field was removed (console SSO rules replace it). The stored value is kept only for the conversion offers, until ST-25 drops it.",
    docs: "/docs/operate/console/products/",
    value: { kind: "string", maxLength: 200 },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "read-only",
    securityWidening: true,
    widensWhen: "any",
    critical: true,
    confirm: { change: "L1" },
    readers: ["core/products.ts", "console/api.ts"],
    storage: { kind: "column", table: "products", column: "admin_group" },
  }),
  setting({
    key: "core.web.origins",
    rbacArea: "keys",
    scope: "product",
    service: "core",
    area: "access",
    label: "Web origins",
    description:
      "Browser origins allowed to call this product's endpoints (the CORS allow-list). Adding one lets that site's scripts call the product.",
    keywords: ["cors", "origin", "browser"],
    docs: "/docs/start/first-product/",
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
    rbacArea: "settings",
    scope: "product",
    service: "core",
    area: "general",
    label: "Manifest-authoritative",
    description:
      "The product's .pkey/ is the only writer of its display name, license defaults, web origins, catalog and licensing settings: a console edit to one is refused unless it is a break-glass claim, which needs a reason and expires after 7 days or at the first resync or deploy that changes that field, whichever comes first. Settings claimed through their older markers (services, the compatibility window, update access, the device policies) are not refused yet. Off by default; always on, and locked, for the system product.",
    keywords: ["break-glass", "gitops", "claims", "lock", "single writer"],
    docs: "/docs/operate/console/products/",
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
      "console/handlers/products.ts",
    ],
    storage: { kind: "scalar" },
    since: "ST-20",
  }),
  setting({
    key: "core.services",
    scope: "product",
    service: "core",
    area: "services",
    label: "Features",
    description:
      "Which opt-in services this product runs. A service that is off does not exist from outside.",
    keywords: ["modules", "enablement"],
    docs: "/docs/operate/console/products/",
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
  // ST-19b: `.pkey/product`'s `secrets.required`, names only. A manifest names a secret and never
  // carries its value: an operator sets each value on Keys & secrets, sealed in `product_secrets`,
  // and only its presence is shown. ST-08 extended the entry with the `product_secrets` table
  // (its adapter and readers) instead of registering a second one: the names come from the
  // manifest, the sealed values from the table, and only presence is ever read back.
  setting({
    key: "core.secrets",
    rbacArea: "keys",
    scope: "product",
    service: "core",
    area: "keys",
    label: "Required secrets",
    description:
      "The names of the sealed secrets this product needs an operator to set (a custom OIDC client's secret, an edge-mint signing key). The manifest names them, never their values; each value is set on Keys and secrets and only its presence is ever shown.",
    keywords: [
      "secrets.required",
      "product secrets",
      "sealed",
      "missing secrets",
    ],
    docs: "/docs/operate/console/keys-and-secrets/",
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
    readers: [
      "core/managedSecrets.ts",
      "core/products.ts",
      "console/handlers/products.ts",
    ],
    storage: { kind: "rich", adapter: "product_secrets" },
    since: "ST-19b",
  }),
  // ST-08: the signing keyring on Keys & secrets. Rows live in `product_keys` (migration 0003);
  // the sealed private half never leaves the Worker, so the setting is the public record.
  setting({
    key: "core.keys",
    rbacArea: "keys",
    scope: "product",
    service: "core",
    area: "keys",
    label: "Signing keys",
    description:
      "The product's Ed25519 signing keys: one active key signs licenses, config and the feed, retired keys stay published so older documents still verify. The private half is sealed and never shown. Rotating or retiring a key changes what devices accept.",
    keywords: ["signing", "kid", "rotate", "keyring", "ed25519", "retire"],
    docs: "/docs/operate/console/keys-and-secrets/",
    value: {
      kind: "json",
      schema: "product_keys rows: kid, status, public key (core/signing.ts)",
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "operator",
    critical: true,
    confirm: { change: "L2" },
    wire: ["document"],
    readers: [
      "core/signing.ts",
      "platform/keyvault.ts",
      "keyTransitions.ts",
      "console/handlers/products.ts",
    ],
    storage: { kind: "rich", adapter: "product_keys" },
    since: "ST-08",
  }),
  setting({
    key: "core.presentation",
    scope: "product",
    service: "core",
    area: "general",
    label: "Icon and accent",
    description:
      "The product's icon and accent colours (light and dark), declared in .pkey/product and shown by the console, Polaris Locker and the SDK UI kits. Manifest-only.",
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
      "services/distribution/listing/inherit.ts",
    ],
    since: "ST-06",
  }),
  setting({
    key: "core.trustPolicy",
    rbacArea: "keys",
    scope: "product",
    service: "core",
    area: "access",
    label: "Device trust policy",
    description:
      "Which attestation a device must present to enrol (App Attest, Play Integrity) and whether it is enforced. Relaxing it lets unattested clients enrol.",
    keywords: ["attestation", "app attest", "play integrity"],
    docs: "/docs/features/licensing/device-trust/",
    value: { kind: "json", schema: "TrustPolicy (core/trust/deviceTrust.ts)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "operator",
    securityWidening: true,
    widensWhen: "any",
    critical: true,
    confirm: { change: "L2" },
    readers: ["core/products.ts", "core/trust/deviceTrust.ts"],
    storage: {
      kind: "column",
      table: "products",
      column: "trust_policy_json",
    },
  }),

  setting({
    key: "storefront.polarisKey.listed",
    rbacArea: "commerce",
    scope: "product",
    service: "core",
    area: "storefront",
    label: "Listed in Polaris Locker",
    description:
      "Whether the Polaris Locker library lists this product. Auto lists it where auto-issue or a mapped group would give it to the person (today's Discover); Listed adds every other way to obtain it; Unlisted hides it in Polaris Locker while every policy keeps working.",
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
    rbacArea: "commerce",
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
    rbacArea: "commerce",
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
    rbacArea: "commerce",
    scope: "product",
    service: "core",
    area: "storefront",
    label: "Group labels",
    description:
      'How an identity-provider group is named on the listing ("Included with Aperture Seven"), at most 40 characters. A group without a label shows as "For <group>".',
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

  // ── Setup choices (ST-39) ───────────────────────────────────────────────────────────────
  // The explicit choices the wizard kit records (Integration hidden, "not using this channel",
  // runner consent, skipped steps). One operator-owned value, no manifest path; whether a step is
  // done is computed from state and never stored. Written through `writeSetting()`.
  setting({
    key: "core.setup",
    scope: "product",
    service: "core",
    area: "setup",
    label: "Setup choices",
    description:
      "What the operator chose in the setup wizards: Integration hidden, channels not in use, consent for the setup runner and skipped steps. Choices only: a step's progress is read from the product, never stored.",
    keywords: ["wizard", "setup", "integration", "skipped", "hidden"],
    docs: "/docs/operate/console/products/",
    value: { kind: "json", schema: SETUP_SCHEMA },
    defaultValue: EMPTY_SETUP,
    merge: "cascade",
    ownership: "operator",
    confirm: { change: "L0" },
    readers: [
      "core/settings/setupShape.ts",
      "services/distribution/channels.ts",
    ],
    storage: { kind: "scalar" },
    since: "ST-39",
  }),

  // ── Hosted assets (HA-10, notes/S-20 §6.10, owner decisions 6 and 9) ────────────────────
  // Core's, like the copies themselves (`core/assets/hostedAssets.ts`): every product has hosted images
  // whether or not it runs Distribution. Operator-owned and never in the manifest: the manifest's
  // author does not pay for the storage. Rows in `product_settings`, written through
  // `writeSetting()` (the console's Presentation page, `console/handlers/hostedAssets.ts`).
  setting({
    key: "assets.releases.mirror",
    scope: "product",
    service: "core",
    area: "assets",
    label: "Mirror release files",
    description:
      "Keeps Polaris Key's own copy of every app release file the product publishes on GitHub or at a URL, and serves it first. Off copies no new release file for this product, so GitHub serves the files without a copy; the copies already made keep serving.",
    keywords: ["mirror", "release files", "github", "r2", "downloads"],
    docs: ASSETS_DOCS,
    value: { kind: "switch" },
    defaultValue: "on",
    merge: "cascade",
    ownership: "operator",
    confirm: { on: "L0", off: "L1" },
    readers: [
      "core/assets/assetSettings.ts",
      "services/release/mirrorSwitch.ts",
    ],
    storage: { kind: "scalar" },
    since: "HA-10",
  }),
  setting({
    key: "assets.quota.mediaBytes",
    scope: "product",
    service: "core",
    area: "assets",
    label: "Media quota",
    description:
      "How many bytes of hosted images (originals and their sizes, not release files) this product may hold. Past it, a new image is refused and the current copy keeps serving. Unset follows the platform default.",
    keywords: ["hosted assets", "storage", "quota", "images"],
    docs: ASSETS_DOCS,
    value: {
      kind: "integer",
      unit: "bytes",
      min: 0,
      max: ASSET_MEDIA_QUOTA_MAX,
    },
    defaultValue: ASSET_MEDIA_QUOTA_DEFAULT,
    merge: "cascade",
    inherits: "platform",
    ownership: "operator",
    confirm: { up: "L1", down: "L1" },
    readers: [
      "core/assets/assetSettings.ts",
      "core/assets/assetQuota.ts",
      "core/assets/hostedAssets.ts",
    ],
    storage: { kind: "scalar" },
    since: "HA-10",
  }),
  setting({
    key: "assets.quota.releaseBytes",
    scope: "product",
    service: "core",
    area: "assets",
    label: "Release-file quota",
    description:
      "How many bytes of mirrored release files this product may hold. Past it, mirroring stops and GitHub keeps serving the files. Unset follows the platform default.",
    keywords: ["hosted assets", "storage", "quota", "mirror", "releases"],
    docs: ASSETS_DOCS,
    value: {
      kind: "integer",
      unit: "bytes",
      min: 0,
      max: ASSET_RELEASE_QUOTA_MAX,
    },
    defaultValue: ASSET_RELEASE_QUOTA_DEFAULT,
    merge: "cascade",
    inherits: "platform",
    ownership: "operator",
    confirm: { up: "L1", down: "L1" },
    readers: [
      "core/assets/assetSettings.ts",
      "core/assets/assetQuota.ts",
      "core/assets/hostedAssets.ts",
      "services/release/mirror.ts",
    ],
    storage: { kind: "scalar" },
    since: "HA-10",
  }),
  // ── Platform-owned product policies (ST-11, notes/S-18 §4.14.4) ─────────────────────────
  // Lazy-delta opt-in and sign-in mail cap: SQL-only until ST-11 (the old
  // lazy-delta and mail-cap tables, copied once into `product_settings` rows and since dropped).
  // Operator-owned, never in the manifest. Rows are written through `writeSetting()`.
  setting({
    key: "deltas.lazy.enabled",
    scope: "product",
    service: "core",
    area: "assets",
    label: "Lazy deltas",
    description:
      "Counts which version pairs this product's devices move between and builds a delta for the hot ones, so those updates download less. Needs lazy deltas on for the platform. Off counts nothing and builds nothing; deltas already built keep serving.",
    keywords: ["delta", "update size", "hot pairs", "downloads"],
    docs: PLATFORM_DOCS_PATH,
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "cascade",
    ownership: "operator",
    confirm: { on: "L0", off: "L0" },
    readers: ["core/assets/deltaDemand.ts"],
    storage: { kind: "scalar" },
    since: "ST-11",
  }),
  setting({
    key: "deltas.lazy.hotDevices",
    scope: "product",
    service: "core",
    area: "assets",
    label: "Devices that make a pair hot",
    description:
      "How many devices must move between the same two versions, without a delta, before one is built. Lower builds more deltas.",
    keywords: ["delta", "threshold", "hot pairs"],
    docs: PLATFORM_DOCS_PATH,
    value: { kind: "integer", unit: "count", min: 1, max: 100_000 },
    defaultValue: 25,
    merge: "cascade",
    ownership: "operator",
    confirm: { up: "L0", down: "L1" },
    readers: ["core/assets/deltaDemand.ts"],
    storage: { kind: "scalar" },
    since: "ST-11",
  }),
  setting({
    key: "deltas.lazy.dailyCap",
    scope: "product",
    service: "core",
    area: "assets",
    label: "Deltas built a day",
    description:
      "The most deltas this product may have built in a day. Zero builds none.",
    keywords: ["delta", "limit", "quota"],
    docs: PLATFORM_DOCS_PATH,
    value: { kind: "integer", unit: "perDay", min: 0, max: 10_000 },
    defaultValue: 20,
    merge: "cascade",
    ownership: "operator",
    confirm: { up: "L1", down: "L0" },
    readers: ["core/assets/deltaDemand.ts"],
    storage: { kind: "scalar" },
    since: "ST-11",
  }),
  setting({
    key: "email.dailyCap",
    scope: "product",
    service: "core",
    area: "general",
    label: "Daily sign-in mail cap",
    description:
      "How many sign-in emails this product can send a day. Unset follows the platform default.",
    keywords: ["limit", "quota", "passthrough", "sign-in", "mail"],
    docs: PLATFORM_DOCS_PATH,
    value: { kind: "integer", unit: "perDay", min: 1, max: 1_000_000 },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "operator",
    confirm: { up: "L1", down: "L0" },
    readers: ["core/notify/emailDelivery.ts"],
    storage: { kind: "scalar" },
    since: "ST-11",
  }),
  // ST-27: this product's alert destinations. They replace the platform's `alerts.destinations`
  // for the alert kinds they take; with none, the platform's apply. Rich: `notify_destinations`,
  // written by `/api/products/<slug>/alerts`.
  setting({
    key: "core.alerts.destinations",
    rbacArea: "settings",
    scope: "product",
    service: "core",
    area: "general",
    label: "Alert destinations",
    description:
      "Where this product's alerts go: email addresses and signed https webhooks, per alert kind. They replace the platform's destinations for the kinds they take; with none set, the platform's apply.",
    keywords: ["notify", "webhook", "email", "alerts", "auto-halt"],
    docs: "/docs/operate/console/products/",
    value: {
      kind: "json",
      schema: "notify_destinations rows (core/notify/alertDestinations.ts)",
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "operator",
    confirm: { change: "L1" },
    readers: ["core/notify/alertDestinations.ts"],
    storage: { kind: "rich", adapter: "notify_destinations" },
    since: "ST-27",
  }),
];
