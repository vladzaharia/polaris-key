/**
 * Every query key, in one module (docs/design/ADMIN.md §4 "Hooks", components.md §7).
 *
 * Keys are arrays, so invalidation works by PREFIX:
 *
 *   ["me"]                                       the session
 *   ["products"]                                 the registry list
 *   ["product", slug]                            one product's detail (exact)
 *   ["product", slug, <area>, <resource>, …]     everything else about that product
 *   ["platform", <resource>]                     instance-wide, product-less (A-11 to A-13)
 *
 * Invalidating `["product", slug]` without `exact` therefore refreshes everything about one
 * product (resync), `["product", slug, "license", "licenses"]` refreshes the list AND every
 * license record under it, and so on. `mutations.ts` declares which prefixes each write
 * invalidates.
 *
 * The areas mirror the console sections (`core`, `license`, `config`, `release`, `distribution`,
 * `update`, `identity`), so §5.4's names read straight across: `release.compat.*` is
 * `qk.compat(slug)` as a prefix.
 */

import type { QueryKey } from "@tanstack/react-query";
import type { AlertScope, FeedEcosystem, FeedScope } from "../../api.js";

const product = (slug: string, ...rest: (string | number)[]): QueryKey => [
  "product",
  slug,
  ...rest,
];

export const qk = {
  me: (): QueryKey => ["me"],
  /** ST-29: who can give access to an area in a scope (NoAccessPage). */
  accessAdmins: (scope: string, area: string): QueryKey => [
    "access-admins",
    scope,
    area,
  ],
  products: (): QueryKey => ["products"],
  /** I-41: a support code resolved to its product and user. */
  supportCode: (code: string): QueryKey => ["support-code", code],
  /** ST-52: the palette's entity search (memory only; a pasted key can be the query). */
  search: (q: string): QueryKey => ["palette-search", q],
  /** New product (ST-43): W22 repositories, W23 create check, W24 slug check. */
  githubRepositories: (q: string): QueryKey => ["new-product", "repos", q],
  createCheck: (repo: string): QueryKey => ["new-product", "check", repo],
  slugCheck: (slug: string): QueryKey => ["new-product", "slug", slug],
  /** What needs the operator across every product (`GET /attention`; Home, the switcher). */
  attention: (): QueryKey => ["attention"],
  /** Platform ready (`GET /platform/ready`; Home, platform admins). */
  platformReady: (): QueryKey => ["platform", "ready"],

  // platform (instance-wide; notes/S-13 §9.2)
  platformVersion: (): QueryKey => ["platform", "version"],
  platformDeployment: (): QueryKey => ["platform", "deployment"],
  platformActivity: (): QueryKey => ["platform", "activity"],
  /** ST-51: Platform → Activity's feed for one filter set, and one event by id. */
  platformActivityFeed: (filters: string): QueryKey => [
    "platform",
    "activity",
    "feed",
    filters,
  ],
  platformActivityEvent: (id: string): QueryKey => [
    "platform",
    "activity",
    "event",
    id,
  ],
  platformSettings: (): QueryKey => ["platform", "settings"],
  /** ST-16: the reach of a product default or bound, per proposed value. */
  platformReach: (key: string, value?: number): QueryKey => [
    "platform",
    "settings",
    "reach",
    key,
    value ?? null,
  ],
  /** Settings → Licensing: the reserved entitlement-name report (LX-05). */
  platformReservedNames: (): QueryKey => ["platform", "reserved-names"],
  /** The KEK keyring status (`GET /products/kek`): instance-wide, so under `platform`. */
  platformKek: (): QueryKey => ["platform", "kek"],
  /** Settings → History: the settings writes of the platform trail (under `platformActivity`). */
  platformSettingsHistory: (): QueryKey => ["platform", "activity", "settings"],
  platformOperations: (): QueryKey => ["platform", "operations"],
  /** The admin API tokens (`GET /manage/api/tokens`): the deployment's, so under `platform`. */
  apiTokens: (): QueryKey => ["platform", "api-tokens"],
  personalTokens: (): QueryKey => ["platform", "personal-tokens"],
  /** The signed-in operator's own sign-in methods (ST-30c.4). */
  myMethods: (): QueryKey => ["account", "methods"],
  /** Platform → Members: the roster, the root rule and the invites (ST-31.11). */
  members: (): QueryKey => ["platform", "members"],
  /** Platform → Members → SSO rules: the stored rules and the connections (ST-32.7). */
  accessRules: (): QueryKey => ["platform", "access-rules"],
  /** Platform → Members → SSO rules: the open `admin_group` conversion offers (ST-32.8). */
  accessOffers: (): QueryKey => ["platform", "access-offers"],
  /** Product → Settings → Members (ST-31.14): one product's admins, invites and platform roles. */
  productMembers: (slug: string) => product(slug, "members"),
  myPersonalTokens: (): QueryKey => ["me", "personal-tokens"],
  /** Platform → Connections (I-31): the page and every connection on it. */
  platformConnections: (): QueryKey => ["platform", "connections"],
  platformConnection: (id: string): QueryKey => ["platform", "connections", id],
  /** Every store connection; as a prefix, also every store's apps listing. */
  platformStores: (): QueryKey => ["platform", "store-connections"],
  platformStoreApps: (store: string, tracks: boolean): QueryKey => [
    "platform",
    "store-connections",
    store,
    "apps",
    tracks ? "tracks" : "plain",
  ],
  /**
   * Package feeds (F-11), in either scope: `["platform", "feeds", …]` or
   * `["product", slug, "distribution", "feeds", …]`. As a prefix, a scope's whole Feeds area.
   */
  pkgFeeds: (scope: FeedScope): QueryKey =>
    scope.kind === "platform"
      ? ["platform", "feeds"]
      : product(scope.slug, "distribution", "feeds"),
  /** Alert destinations (ST-27), in either scope. */
  alertDestinations: (scope: AlertScope): QueryKey =>
    scope.kind === "platform"
      ? ["platform", "alerts"]
      : product(scope.slug, "alerts"),
  pkgFeed: (scope: FeedScope, eco: FeedEcosystem): QueryKey => [
    ...qkFeeds(scope),
    eco,
  ],
  pkgFeedPackages: (
    scope: FeedScope,
    eco: FeedEcosystem,
    q: string,
    owner: string,
  ): QueryKey => [...qkFeeds(scope), eco, "packages", "list", q, owner],
  pkgFeedPackage: (
    scope: FeedScope,
    eco: FeedEcosystem,
    owner: string,
    name: string,
  ): QueryKey => [...qkFeeds(scope), eco, "packages", "record", owner, name],
  pkgFeedActivity: (scope: FeedScope, eco: FeedEcosystem): QueryKey => [
    ...qkFeeds(scope),
    eco,
    "activity",
  ],
  /** F-21: the scope's registry tokens; `license` narrows to one licence's (`""` = all). */
  pkgFeedTokens: (scope: FeedScope, license: string): QueryKey => [
    ...qkFeeds(scope),
    "tokens",
    license,
  ],
  /** F-36: the cleanup setting and its notice. */
  pkgFeedRetention: (scope: FeedScope): QueryKey => [
    ...qkFeeds(scope),
    "retention",
  ],
  /** F-38a: the cleanup dry run (a POST that stores nothing). */
  pkgFeedPrune: (scope: FeedScope): QueryKey => [...qkFeeds(scope), "prune"],
  /** Every product's queries (a platform-wide write that changes what each product shows). */
  allProducts: (): QueryKey => ["product"],
  /** The product detail row. Match it with `exact: true`; as a prefix it is the whole product. */
  product: (slug: string): QueryKey => product(slug),

  // commerce
  commerceView: (slug: string) => product(slug, "commerce", "view"),

  // core
  services: (slug: string) => product(slug, "core", "services"),
  devices: (slug: string) => product(slug, "core", "devices"),
  devicesSummary: (slug: string) => product(slug, "core", "devices", "summary"),
  device: (slug: string, id: string) =>
    product(slug, "core", "devices", "record", id),
  /** I-12: the product's users, keyed by pairwise subject. */
  users: (slug: string) => product(slug, "core", "users"),
  user: (slug: string, subject: string) =>
    product(slug, "core", "users", "record", subject),
  /** U-03: the subject's account overrides; under the record, so a Users write refreshes it. */
  userOverrides: (slug: string, subject: string) =>
    product(slug, "core", "users", "record", subject, "overrides"),
  /** The subject's data export, read once on demand (never cached). */
  userExport: (slug: string, subject: string) =>
    product(slug, "core", "users", "record", subject, "export"),
  activity: (slug: string) => product(slug, "core", "activity"),
  secrets: (slug: string) => product(slug, "core", "secrets"),
  keys: (slug: string) => product(slug, "core", "keys"),
  /** ST-41: the Integration read model (ST-40). */
  integration: (slug: string) => product(slug, "core", "integration"),
  trustPolicy: (slug: string) => product(slug, "core", "trust-policy"),
  ciPublisher: (slug: string) => product(slug, "core", "ci", "publisher"),
  ciTokens: (slug: string) => product(slug, "core", "ci", "tokens"),
  blobGc: (slug: string) => product(slug, "core", "blob-gc"),
  /** HA-06: the product's hosted-asset slots (the Presentation page). */
  hostedAssets: (slug: string) => product(slug, "core", "assets"),
  /** HA-10: usage against the quotas and the hosted-asset settings (under the slots' prefix). */
  assetUsage: (slug: string) => product(slug, "core", "assets", "usage"),

  // license
  licenses: (slug: string) => product(slug, "license", "licenses"),
  license: (slug: string, id: string) =>
    product(slug, "license", "licenses", id),
  /** The Licenses page's loaded pages (P0-29); under the licenses prefix, so every licence write refreshes them. */
  licensesPages: (slug: string) =>
    product(slug, "license", "licenses", "_pages"),
  /** The Licenses band's holder-state counts; under the licenses prefix, so every licence write refreshes them. */
  licenseHolderCounts: (slug: string) =>
    product(slug, "license", "licenses", "_holderCounts"),
  /** One row of the list, to learn whether the product has any licence; under the licenses prefix. */
  licensesFirst: (slug: string) =>
    product(slug, "license", "licenses", "_first"),
  /** The "Clean up duplicates" list; under the licenses prefix, so every licence write refreshes it. */
  licenseCleanup: (slug: string) =>
    product(slug, "license", "licenses", "_cleanup"),
  /** LX-30: the holder moves of one licence (I-12's relink history for it); under its record. */
  licenseHolderMoves: (slug: string, id: string) =>
    product(slug, "license", "licenses", id, "_moves"),
  /** LX-28/LX-30: every batch of the product, all pages fetched (`{ batches }`). */
  licenseBatches: (slug: string) => product(slug, "license", "batches"),
  licenseBatch: (slug: string, id: string) =>
    product(slug, "license", "batches", id),
  tiers: (slug: string) => product(slug, "license", "tiers"),
  fingerprintPolicy: (slug: string) => product(slug, "license", "enrollment"),
  /** LX-06: the row-backed settings of one area; every area under one prefix (`productSettingsAll`). */
  productSettings: (slug: string, area: string) =>
    product(slug, "core", "settings", area),
  productSettingsAll: (slug: string) => product(slug, "core", "settings"),
  /** ST-17: the claims against the manifest; under `productSettingsAll`, so a revert refreshes it. */
  settingsDrift: (slug: string) => product(slug, "core", "settings", "drift"),
  /** ST-08: every row-backed setting of the product in one read (Settings → All settings). */
  productSettingsEvery: (slug: string) =>
    product(slug, "core", "settings", "every"),

  // config
  catalog: (slug: string) => product(slug, "config", "catalog"),
  syncUsage: (slug: string) => product(slug, "sync", "usage"),
  connectPeople: (slug: string) => product(slug, "connect", "people"),
  connectUsage: (slug: string) => product(slug, "connect", "usage"),
  /** The version history (A-6). Under the catalog prefix, so a publish refreshes it. */
  catalogVersions: (slug: string) =>
    product(slug, "config", "catalog", "versions"),
  catalogVersion: (slug: string, version: number) =>
    product(slug, "config", "catalog", "versions", version),
  /** Who sets these keys (A-7b); the keys sorted and joined, so one set is one entry. */
  catalogUsage: (slug: string, keys: readonly string[]) =>
    product(slug, "config", "catalog", "usage", [...keys].sort().join(",")),
  profiles: (slug: string) => product(slug, "config", "profiles"),
  profile: (slug: string, id: string) =>
    product(slug, "config", "profiles", "record", id),
  /** The resolved payload stack of a license's profiles (LicenseDetail). */
  profileStack: (slug: string, stackKey: string) =>
    product(slug, "config", "profiles", "stack", stackKey),
  mint: (slug: string) => product(slug, "config", "mint"),

  // release
  releases: (slug: string) => product(slug, "release", "releases"),
  releaseHealth: (slug: string) => product(slug, "release", "health"),
  ciReadiness: (slug: string) => product(slug, "release", "ci-readiness"),
  setupPullRequest: (slug: string) =>
    product(slug, "release", "setup-pull-request"),
  channels: (slug: string) => product(slug, "release", "channels"),
  deliverables: (slug: string) => product(slug, "release", "deliverables"),
  packReleases: (slug: string, deliverable?: string) =>
    deliverable === undefined
      ? product(slug, "release", "packReleases")
      : product(slug, "release", "packReleases", deliverable),
  /** One pack variant's files index (immutable per release; cached so reopening is free). */
  packFiles: (
    slug: string,
    deliverable: string,
    releaseId: string,
    variant: string,
  ) =>
    product(
      slug,
      "release",
      "packReleases",
      deliverable,
      "files",
      releaseId,
      variant,
    ),
  delegations: (slug: string) => product(slug, "release", "delegations"),
  compat: (slug: string, offset?: number) =>
    offset === undefined
      ? product(slug, "release", "compat")
      : product(slug, "release", "compat", offset),
  /**
   * One update simulation, keyed on its inputs. It sits under `release.compat`, so every write
   * that changes what a device would get (channel policy, yanks, rollouts, readiness) makes it
   * stale with the matrix.
   */
  simulate: (slug: string, inputs: string) =>
    product(slug, "release", "compat", "simulate", inputs),

  // distribution
  /** A-22: one product's channel read model (`GET …/distribution/channels`). */
  channelPage: (slug: string) => product(slug, "distribution", "channels"),
  matrix: (slug: string, variant?: string) =>
    variant === undefined
      ? product(slug, "distribution", "matrix")
      : product(slug, "distribution", "matrix", variant),
  /**
   * The app's newest releases × outlets, as the Release pages read it: the Compatibility overlay
   * and a release record's Distribution tab (`limit` = the matrix maximum). Under the matrix
   * prefix, so every rollout and readiness write refreshes it with the Matrix (CMP-4).
   */
  matrixOverlay: (slug: string) =>
    product(slug, "distribution", "matrix", "overlay"),
  rollouts: (slug: string) => product(slug, "distribution", "rollouts"),
  /** Update health; with `windowHours`, one window's reading (the prefix is every window). */
  health: (slug: string, windowHours?: number) =>
    windowHours === undefined
      ? product(slug, "distribution", "health")
      : product(slug, "distribution", "health", windowHours),
  access: (slug: string) => product(slug, "distribution", "access"),
  credentials: (slug: string) => product(slug, "distribution", "credentials"),
  readiness: (slug: string) => product(slug, "distribution", "readiness"),
  outlets: (slug: string) => product(slug, "distribution", "outlets"),
  distributionKeys: (slug: string) => product(slug, "distribution", "keys"),
  connectors: (slug: string) => product(slug, "distribution", "connectors"),
  /** A-18j: the storefront flow (every store's plan); as a prefix, also the slot board. */
  storefronts: (slug: string) => product(slug, "distribution", "storefronts"),
  storefrontSlots: (slug: string) =>
    product(slug, "distribution", "storefronts", "slots"),
  /**
   * PS-06: the Polaris Key panel (the first-party `status` op). Under `storefronts`, so a
   * storefront write refreshes it; as a prefix, also its analytics.
   */
  polarisKey: (slug: string) =>
    product(slug, "distribution", "storefronts", "polaris-key"),
  polarisKeyAnalytics: (slug: string) =>
    product(slug, "distribution", "storefronts", "polaris-key", "analytics"),
  /** A-18b: the listing model; as a prefix, also its fit report and release notes. */
  listing: (slug: string) => product(slug, "distribution", "listing"),
  listingFit: (slug: string, release: string | null) =>
    product(slug, "distribution", "listing", "fit", release ?? ""),
  listingNotes: (slug: string, release: string) =>
    product(slug, "distribution", "listing", "notes", release),
  /**
   * One connector read (A-17g: the App Store Distribute flow and App Store products). Under
   * `connectors`, so every connector control makes it stale.
   */
  connectorRead: (slug: string, kind: string, path: string, query = "") =>
    product(slug, "distribution", "connectors", kind, path, query),
  /** The operator-owned `packageFeeds` switch (F-11; Core → Services). */
  packageFeedsSwitch: (slug: string) =>
    product(slug, "distribution", "package-feeds"),

  // update
  feed: (slug: string) => product(slug, "update", "feed"),

  // identity
  portal: (slug: string) => product(slug, "identity", "portal"),
  /** I-12: sign-in through this product (the passthrough header name, claimByKey, 4.8). */
  signInSettings: (slug: string) =>
    product(slug, "identity", "sign-in-settings"),
};

function qkFeeds(scope: FeedScope): QueryKey {
  return qk.pkgFeeds(scope);
}
