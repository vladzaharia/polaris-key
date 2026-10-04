/**
 * Every query key, in one module (docs/design/ADMIN.md §4 "Hooks", components.md §7).
 *
 * Keys are arrays, so invalidation works by PREFIX:
 *
 *   ["me"]                                       the session
 *   ["products"]                                 the registry list
 *   ["product", slug]                            one product's detail (exact)
 *   ["product", slug, <area>, <resource>, …]     everything else about that product
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

const product = (slug: string, ...rest: (string | number)[]): QueryKey => [
  "product",
  slug,
  ...rest,
];

export const qk = {
  me: (): QueryKey => ["me"],
  products: (): QueryKey => ["products"],
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

  // license
  licenses: (slug: string) => product(slug, "license", "licenses"),
  license: (slug: string, id: string) =>
    product(slug, "license", "licenses", id),
  tiers: (slug: string) => product(slug, "license", "tiers"),
  fingerprintPolicy: (slug: string) => product(slug, "license", "enrollment"),

  // config
  catalog: (slug: string) => product(slug, "config", "catalog"),
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
  delegations: (slug: string) => product(slug, "release", "delegations"),
  compat: (slug: string, offset?: number) =>
    offset === undefined
      ? product(slug, "release", "compat")
      : product(slug, "release", "compat", offset),

  // distribution
  matrix: (slug: string, variant?: string) =>
    variant === undefined
      ? product(slug, "distribution", "matrix")
      : product(slug, "distribution", "matrix", variant),
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

  // update
  feed: (slug: string) => product(slug, "update", "feed"),

  // identity
  portal: (slug: string) => product(slug, "identity", "portal"),
};
