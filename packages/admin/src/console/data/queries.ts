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
import type { FeedEcosystem, FeedScope } from "../../api.js";

const product = (slug: string, ...rest: (string | number)[]): QueryKey => [
  "product",
  slug,
  ...rest,
];

export const qk = {
  me: (): QueryKey => ["me"],
  products: (): QueryKey => ["products"],

  // platform (instance-wide; notes/S-13 §9.2)
  platformVersion: (): QueryKey => ["platform", "version"],
  platformDeployment: (): QueryKey => ["platform", "deployment"],
  platformActivity: (): QueryKey => ["platform", "activity"],
  platformSettings: (): QueryKey => ["platform", "settings"],
  /** The KEK keyring status (`GET /products/kek`): instance-wide, so under `platform`. */
  platformKek: (): QueryKey => ["platform", "kek"],
  /** Settings → History: the settings writes of the platform trail (under `platformActivity`). */
  platformSettingsHistory: (): QueryKey => ["platform", "activity", "settings"],
  platformOperations: (): QueryKey => ["platform", "operations"],
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
  /** Every product's queries (a platform-wide write that changes what each product shows). */
  allProducts: (): QueryKey => ["product"],
  /** The product detail row. Match it with `exact: true`; as a prefix it is the whole product. */
  product: (slug: string): QueryKey => product(slug),

  // core
  services: (slug: string) => product(slug, "core", "services"),
  devices: (slug: string) => product(slug, "core", "devices"),
  devicesSummary: (slug: string) => product(slug, "core", "devices", "summary"),
  device: (slug: string, id: string) =>
    product(slug, "core", "devices", "record", id),
  activity: (slug: string) => product(slug, "core", "activity"),
  secrets: (slug: string) => product(slug, "core", "secrets"),
  keys: (slug: string) => product(slug, "core", "keys"),
  ciPublisher: (slug: string) => product(slug, "core", "ci", "publisher"),
  ciTokens: (slug: string) => product(slug, "core", "ci", "tokens"),
  blobGc: (slug: string) => product(slug, "core", "blob-gc"),

  // license
  licenses: (slug: string) => product(slug, "license", "licenses"),
  license: (slug: string, id: string) =>
    product(slug, "license", "licenses", id),
  tiers: (slug: string) => product(slug, "license", "tiers"),
  fingerprintPolicy: (slug: string) => product(slug, "license", "enrollment"),

  // config
  catalog: (slug: string) => product(slug, "config", "catalog"),
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
};

function qkFeeds(scope: FeedScope): QueryKey {
  return qk.pkgFeeds(scope);
}
