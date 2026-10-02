/**
 * A Diceroll-shaped release store (P2-07): a Godot game shipping six builds — macOS, Windows,
 * Linux, iOS, Android and the web — as the admin read model returns them
 * (`GET …/release/releases`, `GET …/release/channels`).
 *
 *   v0.4.2  newest; five builds — the iOS build is missing (review still pending)
 *   v0.4.1  all six builds, with signature sidecars and a loose checksum file
 *   v0.4.0  yanked
 *   v0.3.0  a legacy release the GitHub sync indexed without a descriptor (no builds)
 *
 * The channels model resolves per platform on the SERVER; the fixture states the answer the
 * worker gives for this store (iOS falls back to v0.4.1), and the console must render it.
 */

import type {
  ReleaseArtifactDto,
  ReleaseBuildDto,
  ReleaseChannelsResponse,
  ReleaseDto,
  ReleaseStoreResponse,
} from "../src/api.js";

export const SLUG = "diceroll";

/** A deterministic 64-hex SHA-256 stand-in, distinct per seed. */
export function sha(seed: number): string {
  return (seed.toString(16).padStart(4, "0") + "ab").repeat(11).slice(0, 64);
}

const SIX: ReleaseBuildDto[] = [
  {
    buildId: "macos-universal",
    platform: "macos",
    arch: "universal",
    format: "zip",
    buildNumber: "41",
    minOs: "12.0",
  },
  {
    buildId: "windows-x86_64",
    platform: "windows",
    arch: "x86_64",
    format: "zip",
    buildNumber: "41",
    minOs: null,
  },
  {
    buildId: "linux-x86_64",
    platform: "linux",
    arch: "x86_64",
    format: "tar.gz",
    buildNumber: "41",
    minOs: null,
  },
  {
    buildId: "ios-arm64",
    platform: "ios",
    arch: "arm64",
    format: "ipa",
    buildNumber: "1041",
    minOs: "15.0",
  },
  {
    buildId: "android-arm64",
    platform: "android",
    arch: "arm64",
    format: "aab",
    buildNumber: "4041",
    minOs: "24",
  },
  {
    buildId: "web-wasm32",
    platform: "web",
    arch: "wasm32",
    format: "zip",
    buildNumber: "41",
    minOs: null,
  },
];

function payload(
  release: string,
  build: ReleaseBuildDto,
  seed: number,
): ReleaseArtifactDto {
  const store = build.platform === "ios";
  return {
    artifactId: `${release}-${build.buildId}`,
    name: `diceroll-${release}-${build.buildId}.${build.format ?? "bin"}`,
    kind: build.format ?? "binary",
    platform: build.platform,
    arch: build.arch,
    sizeBytes: 48_000_000 + seed,
    access: "licensed",
    buildId: build.buildId,
    role: "payload",
    sha256: sha(seed),
    locations: store
      ? [{ provider: "store" }]
      : build.platform === "web"
        ? [{ provider: "external", url: "https://cdn.example.test/web.zip" }]
        : [
            { provider: "r2", key: `blobs/sha256/${sha(seed)}` },
            { provider: "github", asset: `diceroll-${build.buildId}` },
          ],
  };
}

function signature(
  release: string,
  build: ReleaseBuildDto,
  seed: number,
): ReleaseArtifactDto {
  return {
    artifactId: `${release}-${build.buildId}-sig`,
    name: `diceroll-${release}-${build.buildId}.sig`,
    kind: "signature",
    platform: build.platform,
    arch: build.arch,
    sizeBytes: 64,
    access: "licensed",
    buildId: build.buildId,
    role: "signature",
    sha256: sha(seed + 500),
    locations: [{ provider: "r2", key: `blobs/sha256/${sha(seed + 500)}` }],
  };
}

const V041: ReleaseDto = {
  releaseId: "v0.4.1",
  deliverable: "app",
  version: "0.4.1",
  seq: 3,
  channel: null,
  title: "Loaded dice",
  publishedAt: 1_727_000_000,
  sourceUrl: "https://github.com/vladzaharia/diceroll/releases/tag/v0.4.1",
  status: "ok",
  yank: null,
  builds: SIX,
  artifacts: [
    ...SIX.map((b, i) => payload("v0.4.1", b, 100 + i)),
    signature("v0.4.1", SIX[0]!, 100),
    signature("v0.4.1", SIX[1]!, 101),
    {
      artifactId: "v0.4.1-sums",
      name: "SHA256SUMS",
      kind: "checksum",
      platform: null,
      arch: null,
      sizeBytes: 512,
      access: "public",
      buildId: null,
      role: "checksum",
      sha256: sha(999),
      locations: [{ provider: "github", asset: "SHA256SUMS" }],
    },
  ],
};

const FIVE = SIX.filter((b) => b.platform !== "ios");

const V042: ReleaseDto = {
  releaseId: "v0.4.2",
  deliverable: "app",
  version: "0.4.2",
  seq: 4,
  channel: null,
  title: "Snake eyes",
  publishedAt: 1_728_000_000,
  sourceUrl: "https://github.com/vladzaharia/diceroll/releases/tag/v0.4.2",
  status: "ok",
  yank: null,
  builds: FIVE,
  artifacts: FIVE.map((b, i) => payload("v0.4.2", b, 200 + i)),
};

const V040: ReleaseDto = {
  releaseId: "v0.4.0",
  deliverable: "app",
  version: "0.4.0",
  seq: 2,
  channel: null,
  title: null,
  publishedAt: 1_726_000_000,
  sourceUrl: null,
  status: "ok",
  yank: {
    reason: "corrupts saves on Android",
    at: 1_726_500_000,
    by: "admin:u1",
  },
  builds: [SIX[4]!],
  artifacts: [payload("v0.4.0", SIX[4]!, 300)],
};

const V030: ReleaseDto = {
  releaseId: "v0.3.0",
  deliverable: "app",
  version: "0.3.0",
  seq: 1,
  channel: null,
  title: "First roll",
  publishedAt: 1_720_000_000,
  sourceUrl: "https://github.com/vladzaharia/diceroll/releases/tag/v0.3.0",
  status: "ok",
  yank: null,
  builds: [],
  artifacts: [
    {
      artifactId: "9001",
      name: "diceroll-macos.zip",
      kind: "zip",
      platform: "macos",
      arch: "universal",
      sizeBytes: 40_000_000,
      access: "licensed",
      buildId: null,
      role: "payload",
      sha256: null,
      locations: null,
    },
  ],
};

export const STORE: ReleaseStoreResponse = {
  releases: [V042, V041, V040, V030],
  channels: [
    { channel: "stable", releaseId: "v0.4.2", modifiedAt: 1_728_000_100 },
  ],
  floors: [
    {
      channel: "stable",
      version: "0.4.2",
      releaseId: "v0.4.2",
      raisedAt: 1_728_000_100,
      loweredBy: null,
      loweredAt: null,
    },
  ],
};

const PLATFORMS = ["android", "ios", "linux", "macos", "web", "windows"];

/** v0.4.2 everywhere it has a build; iOS falls back to v0.4.1 (README §3.4). */
const SERVED: Record<string, string | null> = {
  android: "v0.4.2",
  ios: "v0.4.1",
  linux: "v0.4.2",
  macos: "v0.4.2",
  web: "v0.4.2",
  windows: "v0.4.2",
};

export const CHANNELS: ReleaseChannelsResponse = {
  deliverables: [
    {
      deliverable: "app",
      kind: "app",
      platforms: PLATFORMS,
      channels: [
        {
          deliverable: "app",
          channel: "stable",
          pointer: null,
          pinned: false,
          includes: null,
          minSupported: null,
          critical: false,
          source: "manifest",
          modifiedAt: null,
          modifiedBy: null,
          resolved: "v0.4.2",
          byPlatform: SERVED,
        },
        {
          deliverable: "app",
          channel: "beta",
          pointer: "v0.4.2",
          pinned: true,
          includes: ["stable"],
          minSupported: "0.4.0",
          critical: true,
          source: "admin",
          modifiedAt: 1_728_000_200,
          modifiedBy: "admin:u1",
          resolved: "v0.4.2",
          byPlatform: SERVED,
        },
      ],
    },
  ],
};
