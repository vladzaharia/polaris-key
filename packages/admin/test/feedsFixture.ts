/**
 * Package feeds (F-11) API bodies, as the worker's `admin/handlers/feeds.ts` answers them: the
 * platform scope (the system product `polaris-key`, our SDKs) and a product scope (`djdl`). The
 * unit suite, the CSP e2e and the screenshot run share them.
 */

import type {
  FeedDetailDto,
  FeedEcosystem,
  FeedPackageDto,
  FeedPackagesPage,
  FeedSummary,
  FeedsOverviewDto,
} from "../src/api.js";

const ORIGIN = "https://pkg.plrs.im";
export const T0 = 1_790_000_000;

const LABELS: Record<FeedEcosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  swift: "Swift",
  maven: "Maven",
  oci: "OCI",
  godot: "Godot",
};

function base(eco: FeedEcosystem, owner: string): string {
  if (eco === "pypi") return `${ORIGIN}/pypi/${owner}/simple/`;
  if (eco === "oci") return `${ORIGIN}/v2/${owner}/`;
  return `${ORIGIN}/${eco}/${owner}/`;
}

const ECOS: FeedEcosystem[] = ["npm", "pypi", "swift", "maven", "oci", "godot"];

function summary(
  eco: FeedEcosystem,
  owner: string,
  over: Partial<FeedSummary> = {},
): FeedSummary {
  return {
    ecosystem: eco,
    label: LABELS[eco],
    configured: true,
    enabled: true,
    accessMode: "public",
    status: "enabled",
    reason: null,
    packages: 0,
    versions: 0,
    lastPublishedAt: null,
    baseUrl: base(eco, owner),
    ...over,
  };
}

const PLATFORM_STATS: Partial<Record<FeedEcosystem, Partial<FeedSummary>>> = {
  npm: { packages: 3, versions: 14, lastPublishedAt: T0 - 3_600 },
  pypi: { packages: 1, versions: 6, lastPublishedAt: T0 - 7_200 },
  swift: { packages: 1, versions: 5, lastPublishedAt: T0 - 86_400 },
  maven: { packages: 6, versions: 18, lastPublishedAt: T0 - 90_000 },
  oci: { packages: 1, versions: 9, lastPublishedAt: T0 - 600 },
  godot: { packages: 1, versions: 4, lastPublishedAt: T0 - 172_800 },
};

export function platformOverview(): FeedsOverviewDto {
  const feeds = ECOS.map((e) => summary(e, "polaris-key", PLATFORM_STATS[e]));
  return {
    scope: "platform",
    owner: "polaris-key",
    ownerName: "Polaris Key",
    distributionEnabled: true,
    packageFeeds: { enabled: true, version: 1, updatedAt: T0 - 900_000 },
    registryOrigin: ORIGIN,
    feeds,
    summary: {
      feedsEnabled: 6,
      packages: 13,
      versions: 56,
      lastPublishedAt: T0 - 600,
    },
    owners: [
      {
        slug: "polaris-key",
        name: "Polaris Key",
        system: true,
        packageFeeds: true,
      },
      { slug: "djdl", name: "DJDL", system: false, packageFeeds: true },
    ],
  };
}

export function productOverview(): FeedsOverviewDto {
  const feeds = ECOS.map((e) =>
    e === "npm"
      ? summary(e, "djdl", {
          packages: 2,
          versions: 7,
          lastPublishedAt: T0 - 5_000,
        })
      : e === "oci"
        ? summary(e, "djdl", {
            packages: 1,
            versions: 3,
            lastPublishedAt: T0 - 50_000,
          })
        : e === "pypi"
          ? summary(e, "djdl", {
              enabled: false,
              status: "off",
              reason: "feed-off",
            })
          : summary(e, "djdl", {
              configured: false,
              enabled: false,
              status: "off",
              reason: "not-set-up",
            }),
  );
  return {
    scope: "product",
    owner: "djdl",
    ownerName: "DJDL",
    distributionEnabled: true,
    packageFeeds: { enabled: true, version: 2, updatedAt: T0 - 100_000 },
    registryOrigin: ORIGIN,
    feeds,
    summary: {
      feedsEnabled: 2,
      packages: 3,
      versions: 10,
      lastPublishedAt: T0 - 5_000,
    },
  };
}

const NAMESPACES: Record<
  string,
  Record<FeedEcosystem, Record<string, unknown>>
> = {
  "polaris-key": {
    npm: { scope: "@polaris-key" },
    pypi: { names: ["polaris-key"] },
    swift: { scope: "polaris-key" },
    maven: { groupPrefixes: ["im.plrs.key"] },
    oci: {},
    godot: { publisher: "polaris-key" },
  },
  djdl: {
    npm: { scope: "@djdl" },
    pypi: {},
    swift: {},
    maven: {},
    oci: {},
    godot: {},
  },
};

/** The worker's feed adapters' declarations (`registry/<ecosystem>/index.ts`). */
const BASE_CAPS = {
  signing: false,
  immutableVersions: true,
  delete: false,
  search: false,
  authChallenge: "basic",
} as const;
const CAPS: Record<FeedEcosystem, FeedDetailDto["capabilities"]> = {
  npm: {
    ...BASE_CAPS,
    yank: false,
    deprecate: true,
    yankPolicy: false,
    channels: "dist-tags",
  },
  pypi: {
    ...BASE_CAPS,
    yank: true,
    deprecate: false,
    yankPolicy: false,
    channels: "none",
  },
  swift: {
    ...BASE_CAPS,
    yank: true,
    deprecate: false,
    yankPolicy: false,
    channels: "latest",
    signing: true,
  },
  maven: {
    ...BASE_CAPS,
    yank: true,
    deprecate: false,
    yankPolicy: true,
    channels: "latest",
  },
  oci: {
    ...BASE_CAPS,
    yank: true,
    deprecate: false,
    yankPolicy: false,
    channels: "tags",
    authChallenge: "oci-bearer",
  },
  godot: {
    ...BASE_CAPS,
    yank: true,
    deprecate: false,
    yankPolicy: false,
    channels: "tags",
    search: true,
  },
};

export function feedDetail(
  scope: "platform" | "product",
  eco: FeedEcosystem,
): FeedDetailDto {
  const overview =
    scope === "platform" ? platformOverview() : productOverview();
  const owner = overview.owner!;
  const feed = overview.feeds.find((f) => f.ecosystem === eco)!;
  return {
    scope,
    owner,
    ownerName: overview.ownerName,
    distributionEnabled: true,
    packageFeeds: overview.packageFeeds,
    registryOrigin: ORIGIN,
    feed,
    settings: {
      enabled: feed.enabled,
      accessMode: "public",
      namespace: NAMESPACES[owner]![eco],
      maxPackageBytes: eco === "oci" ? 5_368_709_120 : 52_428_800,
      upstream: "none",
      ext: {},
      version: feed.configured ? 3 : 0,
      updatedAt: feed.configured ? T0 - 40_000 : null,
      updatedBy: feed.configured ? "u1" : null,
    },
    policy: {
      enabled: true,
      maxPackageBytesCeiling: eco === "oci" ? 5_368_709_120 : 52_428_800,
      version: 1,
      updatedAt: T0 - 900_000,
      updatedBy: null,
    },
    capabilities: CAPS[eco],
    accessModes: [
      { mode: "public", available: true },
      { mode: "authenticated", available: false },
      { mode: "licensed", available: false },
      { mode: "entitled", available: false },
    ],
  };
}

export function packagesPage(
  scope: "platform" | "product",
  eco: FeedEcosystem,
): FeedPackagesPage {
  if (eco === "npm" && scope === "platform")
    return {
      items: [
        {
          owner: "polaris-key",
          deliverableId: "npm.client-core",
          name: "@polaris-key/client-core",
          versions: 5,
          liveVersions: 5,
          latestVersion: "0.9.2",
          lastPublishedAt: T0 - 3_600,
          tags: [
            { tag: "latest", channel: "stable", version: "0.9.2" },
            { tag: "beta", channel: "beta", version: "0.10.0-beta.1" },
          ],
        },
        {
          owner: "polaris-key",
          deliverableId: "npm.node",
          name: "@polaris-key/node",
          versions: 5,
          liveVersions: 4,
          latestVersion: "0.9.2",
          lastPublishedAt: T0 - 3_600,
          tags: [{ tag: "latest", channel: "stable", version: "0.9.2" }],
        },
        {
          owner: "polaris-key",
          deliverableId: "npm.react",
          name: "@polaris-key/react",
          versions: 4,
          liveVersions: 4,
          latestVersion: "0.9.1",
          lastPublishedAt: T0 - 90_000,
          tags: [{ tag: "latest", channel: "stable", version: "0.9.1" }],
        },
      ],
      nextCursor: null,
    };
  if (eco === "npm")
    return {
      items: [
        {
          owner: "djdl",
          deliverableId: "npm.sdk",
          name: "@djdl/sdk",
          versions: 5,
          liveVersions: 5,
          latestVersion: "2.3.0",
          lastPublishedAt: T0 - 5_000,
          tags: [{ tag: "latest", channel: "stable", version: "2.3.0" }],
        },
        {
          owner: "djdl",
          deliverableId: "npm.cli",
          name: "@djdl/cli",
          versions: 2,
          liveVersions: 2,
          latestVersion: "1.0.1",
          lastPublishedAt: T0 - 60_000,
          tags: [{ tag: "latest", channel: "stable", version: "1.0.1" }],
        },
      ],
      nextCursor: null,
    };
  if (eco === "oci")
    return {
      items: [
        {
          owner: scope === "platform" ? "polaris-key" : "djdl",
          deliverableId: "oci.cli",
          name: scope === "platform" ? "pkey" : "djdl-server",
          versions: 9,
          liveVersions: 8,
          latestVersion: "0.9.2",
          lastPublishedAt: T0 - 600,
          tags: [
            { tag: "latest", channel: "stable", version: "0.9.2" },
            { tag: "edge", channel: "edge", version: "0.10.0-dev.4" },
          ],
        },
      ],
      nextCursor: null,
    };
  return { items: [], nextCursor: null };
}

export function packageRecord(
  scope: "platform" | "product",
  eco: FeedEcosystem,
): FeedPackageDto {
  const owner = scope === "platform" ? "polaris-key" : "djdl";
  const name =
    eco === "oci"
      ? scope === "platform"
        ? "pkey"
        : "djdl-server"
      : scope === "platform"
        ? "@polaris-key/node"
        : "@djdl/sdk";
  const file = (v: string) =>
    eco === "oci"
      ? [
          {
            name: `manifest-${v}.json`,
            type: "oci-manifest",
            size: 48_211_002,
            sha256:
              "9f2c4e1b7a0d3c58e6f1a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3",
          },
        ]
      : [
          {
            name: `${name.split("/")[1]}-${v}.tgz`,
            type: "npm-tarball",
            size: 182_344,
            sha256:
              "4b7e1d9a2c5f8e0b3d6a9c2f5e8b1d4a7c0f3e6b9d2a5c8f1e4b7d0a3c6f9e2b",
            sha512:
              "c1f3e5a7b9d1f3e5a7c9b1d3f5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e3a5c7b9d1f3e5a7c9b1d3f5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e3",
            sha1: "8a1c3e5f7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a",
          },
        ];
  const source = {
    kind: "oidc" as const,
    publisher: `github:vladzaharia/${scope === "platform" ? "polaris-key" : "djdl"}`,
    runUrl: "https://github.com/vladzaharia/polaris-key/actions/runs/1849",
    tokenId: null,
  };
  return {
    owner,
    ownerName: scope === "platform" ? "Polaris Key" : "DJDL",
    ecosystem: eco,
    deliverableId:
      eco === "oci" ? "oci.cli" : scope === "platform" ? "npm.node" : "npm.sdk",
    name,
    baseUrl: base(eco, owner),
    capabilities: CAPS[eco],
    tags: [
      {
        tag: "latest",
        channel: "stable",
        version: eco === "oci" ? "0.9.2" : "2.3.0",
      },
    ],
    versions: [
      {
        version: eco === "oci" ? "0.9.2" : "2.3.0",
        releaseId: "r1",
        channel: "stable",
        tags: ["latest"],
        state: "live",
        stateMessage: null,
        publishedAt: T0 - 5_000,
        source,
        size: file("2.3.0")[0]!.size,
        files: file("2.3.0"),
      },
      {
        version: eco === "oci" ? "0.9.1" : "2.2.0",
        releaseId: "r2",
        channel: "stable",
        tags: [],
        state: eco === "npm" ? "deprecated" : "live",
        stateMessage:
          eco === "npm" ? "Use 2.3.0: 2.2.0 drops offline grace." : null,
        publishedAt: T0 - 400_000,
        source: {
          kind: "static",
          publisher: null,
          runUrl: null,
          tokenId: "ci_7Hq2",
        },
        size: file("2.2.0")[0]!.size,
        files: file("2.2.0"),
      },
      {
        version: eco === "oci" ? "0.9.0" : "2.1.0",
        releaseId: "r3",
        channel: "stable",
        tags: [],
        state: eco === "oci" ? "yanked" : "live",
        stateMessage: eco === "oci" ? "Broken arm64 layer." : null,
        publishedAt: T0 - 900_000,
        source,
        size: file("2.1.0")[0]!.size,
        files: file("2.1.0"),
      },
    ],
  };
}

const ACTIVITY = (owner: string, eco: FeedEcosystem) => ({
  items: [
    {
      id: "aud_2",
      at: T0 - 4_000,
      actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
      action: "package.version.deprecate",
      target: { kind: "package", id: `${eco}:@${owner}/sdk@2.2.0` },
      summary: "Deprecated 2.2.0: use 2.3.0",
    },
    {
      id: "aud_1",
      at: T0 - 40_000,
      actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
      action: "feed.settings.update",
      target: { kind: "feed", id: eco },
      summary: "Updated the feed's settings: enabled",
    },
  ],
});

/** Every Feeds route body for both scopes, keyed by API path (exact matches). */
export function feedRoutes(): Record<string, unknown> {
  const routes: Record<string, unknown> = {
    "/manage/api/platform/feeds": platformOverview(),
    "/manage/api/products/djdl/distribution/feeds": productOverview(),
    "/manage/api/products/djdl/distribution/package-feeds": {
      packageFeeds: { enabled: true, version: 2, updatedAt: T0 - 100_000 },
    },
  };
  for (const eco of ECOS) {
    const p = `/manage/api/platform/feeds/${eco}`;
    const q = `/manage/api/products/djdl/distribution/feeds/${eco}`;
    routes[p] = feedDetail("platform", eco);
    routes[q] = feedDetail("product", eco);
    routes[`${p}/packages`] = packagesPage("platform", eco);
    routes[`${q}/packages`] = packagesPage("product", eco);
    routes[`${p}/activity`] = ACTIVITY("polaris-key", eco);
    routes[`${q}/activity`] = ACTIVITY("djdl", eco);
  }
  routes[
    "/manage/api/platform/feeds/npm/packages/polaris-key/%40polaris-key%2Fnode"
  ] = packageRecord("platform", "npm");
  routes["/manage/api/platform/feeds/oci/packages/polaris-key/pkey"] =
    packageRecord("platform", "oci");
  routes[
    "/manage/api/products/djdl/distribution/feeds/npm/packages/%40djdl%2Fsdk"
  ] = packageRecord("product", "npm");
  routes[
    "/manage/api/products/djdl/distribution/feeds/oci/packages/djdl-server"
  ] = packageRecord("product", "oci");
  return routes;
}
