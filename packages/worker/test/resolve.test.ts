/**
 * P2-05 — per-platform resolution over the release model v2 (`services/release/resolve.ts`).
 *
 * The pure core is table-driven over fixtures: includes, pointer, pin, yank, a release missing
 * one platform, universal and any, the version schemes, and the tag filter. The D1 shell
 * (`resolveBuild`) is then driven against a migrated database to prove it reads the same rows
 * the model writes.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalChannel,
  channelCandidates,
  channelClosure,
  compareVersions,
  parsesInScheme,
  resolveBuild,
  resolveCandidates,
  versionSchemeOf,
  type Candidate,
  type PolicyView,
  type ResolveInput,
} from "../src/services/release/resolve.js";
import {
  setChannelPolicy,
  stmtUpsertBuild,
  stmtEnsureAppDeliverable,
  yankRelease,
} from "../src/services/release/model.js";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

type B = [buildId: string, platform: string | null, arch: string];

let seqCounter = 0;
function rel(
  version: string,
  over: Partial<Candidate> & { b?: B[] } = {},
): Candidate {
  const { b, ...rest } = over;
  return {
    releaseId: `v${version}`,
    version,
    seq: ++seqCounter,
    channel: null,
    prerelease: version.includes("-"),
    tag: `v${version}`,
    builds: (b ?? []).map(([buildId, platform, arch]) => ({
      buildId,
      platform,
      arch,
    })),
    ...rest,
  };
}

const ALL: B[] = [
  ["macos", "macos", "universal"],
  ["win", "windows", "x86_64"],
  ["ios", "ios", "arm64"],
  ["android", "android", "any"],
];
const NO_IOS: B[] = ALL.filter(([id]) => id !== "ios");

function input(over: Partial<ResolveInput>): ResolveInput {
  return {
    deliverable: "app",
    scheme: "semver",
    selector: { type: "channel", channel: "stable" },
    releases: [],
    yanked: new Set(),
    policies: new Map(),
    manualChannels: [],
    ...over,
  };
}

const pol = (p: Partial<PolicyView>): PolicyView => ({
  pointer: null,
  pinned: false,
  includes: null,
  ...p,
});

// ── The table ────────────────────────────────────────────────────────────────────────────────

const v100 = rel("1.0.0", { b: ALL });
const v110 = rel("1.1.0", { b: ALL });
const v120 = rel("1.2.0", { b: NO_IOS });
const v130b = rel("1.3.0-beta.1", { b: ALL });
const base = [v100, v110, v120, v130b];

interface Row {
  name: string;
  in: Partial<ResolveInput>;
  /** Expected release id, or null for "nothing resolves". */
  want: string | null;
  via?: "newest" | "pinned" | "version";
  build?: string;
}

const TABLE: Row[] = [
  {
    name: "stable: the newest non-prerelease by semver, not list order",
    in: { releases: [v120, v100, v110, v130b] },
    want: "v1.2.0",
    via: "newest",
  },
  {
    name: "iOS falls back to the newest release with an iOS build",
    in: { releases: base, target: { platform: "ios" } },
    want: "v1.1.0",
    build: "ios",
  },
  {
    name: "a build id selects by build, with the same per-platform fallback",
    in: { releases: base, target: { buildId: "ios" } },
    want: "v1.1.0",
    build: "ios",
  },
  {
    name: "a platform with no build anywhere resolves nothing",
    in: { releases: base, target: { platform: "linux" } },
    want: null,
  },
  {
    name: "universal matches every arch",
    in: { releases: base, target: { platform: "macos", arch: "arm64" } },
    want: "v1.2.0",
    build: "macos",
  },
  {
    name: "any matches every arch",
    in: { releases: base, target: { platform: "android", arch: "armv7" } },
    want: "v1.2.0",
    build: "android",
  },
  {
    name: "a concrete arch does not match another concrete arch",
    in: { releases: base, target: { platform: "windows", arch: "arm64" } },
    want: null,
  },
  {
    name: "beta includes stable by default (beta ⊇ stable)",
    in: {
      releases: [v100, v110],
      selector: { type: "channel", channel: "beta" },
    },
    want: "v1.1.0",
  },
  {
    name: "beta prefers a newer prerelease over stable",
    in: { releases: base, selector: { type: "channel", channel: "beta" } },
    want: "v1.3.0-beta.1",
  },
  {
    name: "stable does not include beta",
    in: {
      releases: [v100, v130b],
      selector: { type: "channel", channel: "stable" },
    },
    want: "v1.0.0",
  },
  {
    name: "a policy can narrow beta's includes to nothing",
    in: {
      releases: [v100, v110],
      selector: { type: "channel", channel: "beta" },
      policies: new Map([["beta", pol({ includes: [] })]]),
    },
    want: null,
  },
  {
    name: "an explicit release channel overrides the prerelease flag",
    in: {
      releases: [v100, rel("2.0.0", { channel: "beta", b: ALL })],
      selector: { type: "channel", channel: "stable" },
    },
    want: "v1.0.0",
  },
  {
    name: "a yanked release is never offered on a moving selector",
    in: { releases: base, yanked: new Set(["v1.2.0"]) },
    want: "v1.1.0",
  },
  {
    name: "a yanked release still resolves by explicit version",
    in: {
      releases: base,
      yanked: new Set(["v1.2.0"]),
      selector: { type: "version", version: "1.2.0" },
    },
    want: "v1.2.0",
    via: "version",
  },
  {
    name: "a version selector honours the per-platform target",
    in: {
      releases: base,
      selector: { type: "version", version: "1.2.0" },
      target: { platform: "ios" },
    },
    want: null,
  },
  {
    name: "a pinned channel serves its pointer even when newer releases exist",
    in: {
      releases: base,
      policies: new Map([["stable", pol({ pointer: "v1.1.0", pinned: true })]]),
    },
    want: "v1.1.0",
    via: "pinned",
  },
  {
    name: "a pinned pointer resolves even when it is yanked (explicit pin)",
    in: {
      releases: base,
      yanked: new Set(["v1.1.0"]),
      policies: new Map([["stable", pol({ pointer: "v1.1.0", pinned: true })]]),
    },
    want: "v1.1.0",
    via: "pinned",
  },
  {
    name: "a pinned channel falls back per platform to releases at or below the pointer",
    in: {
      releases: base,
      policies: new Map([["stable", pol({ pointer: "v1.2.0", pinned: true })]]),
      target: { platform: "ios" },
    },
    want: "v1.1.0",
  },
  {
    name: "an unpinned pointer is a member: a promoted prerelease can serve stable",
    in: {
      releases: base,
      policies: new Map([["stable", pol({ pointer: "v1.3.0-beta.1" })]]),
    },
    want: "v1.3.0-beta.1",
  },
  {
    name: "an unpinned pointer below the newest does not hold the channel back",
    in: {
      releases: base,
      policies: new Map([["stable", pol({ pointer: "v1.0.0" })]]),
    },
    want: "v1.2.0",
  },
  {
    name: "a yanked unpinned pointer is dropped",
    in: {
      releases: [v100, rel("1.5.0-rc.1", { b: ALL })],
      yanked: new Set(["v1.5.0-rc.1"]),
      policies: new Map([["stable", pol({ pointer: "v1.5.0-rc.1" })]]),
    },
    want: "v1.0.0",
  },
  {
    name: "a tag in ignoreTags is never an app candidate",
    in: { releases: base, ignoreTags: new Set(["v1.2.0"]) },
    want: "v1.1.0",
  },
  {
    name: "a tag outside stableTagPattern is not an app candidate",
    in: {
      releases: [
        v100,
        rel("9.9.9", { tag: "channels", releaseId: "channels" }),
      ],
      stableTagPattern: "^v\\d+\\.\\d+\\.\\d+$",
    },
    want: "v1.0.0",
  },
  {
    name: "a pack ignores the app's tag filter",
    in: {
      deliverable: "game.core",
      releases: [v100, rel("2.0.0", { tag: "pack-2.0.0", releaseId: "p2" })],
      stableTagPattern: "^v\\d+\\.\\d+\\.\\d+$",
    },
    want: "p2",
  },
  {
    name: "a manual channel resolves by its own regex, outside stableTagPattern",
    in: {
      releases: [
        v100,
        rel("2026.1.1", { tag: "nightly-2026.1.1", releaseId: "n1" }),
        rel("2026.1.2", { tag: "nightly-2026.1.2", releaseId: "n2" }),
      ],
      selector: { type: "channel", channel: "nightly" },
      manualChannels: [{ name: "nightly", regex: "nightly-.+" }],
    },
    want: "n2",
  },
  {
    name: "a tagless descriptor release is a candidate without a tag filter",
    in: {
      releases: [
        v100,
        rel("1.4.0", { tag: null, releaseId: "app@1.4.0", b: ALL }),
      ],
      stableTagPattern: "^v\\d+\\.\\d+\\.\\d+$",
    },
    want: "app@1.4.0",
  },
  {
    name: "4part orders numerically",
    in: {
      scheme: "4part",
      releases: [
        rel("1.0.0.9", { releaseId: "a", tag: null }),
        rel("1.0.0.10", { releaseId: "b", tag: null }),
      ],
    },
    want: "b",
  },
  {
    name: "semver+build orders by the numeric build metadata",
    in: {
      scheme: "semver+build",
      releases: [
        rel("1.0.0+9", { releaseId: "a", tag: null }),
        rel("1.0.0+10", { releaseId: "b", tag: null }),
      ],
    },
    want: "b",
  },
  {
    name: "plain semver ties on build metadata and falls to seq",
    in: {
      scheme: "semver",
      releases: [
        rel("1.0.0+10", { releaseId: "a", tag: null, seq: 5 }),
        rel("1.0.0+9", { releaseId: "b", tag: null, seq: 6 }),
      ],
    },
    want: "b",
  },
  {
    name: "an unknown channel resolves nothing",
    in: { releases: base, selector: { type: "channel", channel: "nope" } },
    want: null,
  },
];

describe("resolveCandidates (table)", () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const got = resolveCandidates(input(row.in));
      expect(got?.release.releaseId ?? null).toBe(row.want);
      if (row.via) expect(got?.via).toBe(row.via);
      if (row.build) expect(got?.build?.buildId).toBe(row.build);
    });
  }
});

describe("resolution helpers", () => {
  it("canonicalChannel: staging is beta unless a manual staging exists; latest is stable", () => {
    expect(canonicalChannel("staging")).toBe("beta");
    expect(canonicalChannel("latest")).toBe("stable");
    expect(canonicalChannel("beta")).toBe("beta");
    expect(
      canonicalChannel("staging", [{ name: "staging", regex: "s-.+" }]),
    ).toBe("staging");
    expect(canonicalChannel("Beta")).toBeNull();
    expect(canonicalChannel("a/b")).toBeNull();
    // An own-key lookup: a prototype key is a plain (unknown) channel name, never `Object`.
    expect(canonicalChannel("constructor")).toBe("constructor");
  });

  it("channelClosure follows includes transitively and survives cycles", () => {
    const policies = new Map([
      ["nightly", pol({ includes: ["beta"] })],
      ["beta", pol({ includes: ["stable", "nightly"] })],
    ]);
    expect([...channelClosure("nightly", policies)].sort()).toEqual([
      "beta",
      "nightly",
      "stable",
    ]);
  });

  it("version schemes parse and compare", () => {
    expect(parsesInScheme("4part", "1.2.3.4")).toBe(true);
    expect(parsesInScheme("4part", "1.2.3")).toBe(false);
    expect(parsesInScheme("semver", "1.2.3-rc.1+7")).toBe(true);
    expect(compareVersions("4part", "1.2.3.10", "1.2.3.9")).toBeGreaterThan(0);
    expect(compareVersions("semver", "1.2.3", "1.2.3-rc.1")).toBeGreaterThan(0);
    // client-core's ordering (P3-03): SemVer 2.0's grammar and precedence, exact past 2^53.
    expect(parsesInScheme("semver", "1.2.3-01")).toBe(false);
    expect(parsesInScheme("semver", "v1.2.3")).toBe(false);
    expect(
      compareVersions("semver", "1.2.3-alpha.10", "1.2.3-alpha.9"),
    ).toBeGreaterThan(0);
    expect(
      compareVersions(
        "4part",
        "1.2.3.9007199254740993",
        "1.2.3.9007199254740992",
      ),
    ).toBeGreaterThan(0);
    expect(
      compareVersions("semver+build", "1.2.3+45", "1.2.3+9"),
    ).toBeGreaterThan(0);
    expect(compareVersions("semver", "1.2.3", "not a version")).toBe(0);
    // P3-03: def_json is P2-04's ManifestAppDeliverable, so the scheme is versioning.scheme.
    expect(
      versionSchemeOf({
        def_json:
          '{"kind":"app","versioning":{"scheme":"4part","buildNumber":null},"channels":{},"artifacts":[]}',
      }),
    ).toBe("4part");
    expect(
      versionSchemeOf({ def_json: '{"versioning":{"scheme":"semver+build"}}' }),
    ).toBe("semver+build");
    expect(
      versionSchemeOf({ def_json: '{"versioning":{"scheme":"weird"}}' }),
    ).toBe("semver");
    // The shape P2-05 read, which no writer ever produced, is not a scheme.
    expect(versionSchemeOf({ def_json: '{"versionScheme":"4part"}' })).toBe(
      "semver",
    );
    expect(versionSchemeOf(null)).toBe("semver");
  });
});

// ── The D1 shell ─────────────────────────────────────────────────────────────────────────────

const SLUG = "djdl";

async function seedRelease(
  db: Db,
  tag: string,
  opts: { prerelease?: boolean; builds?: B[]; channel?: string } = {},
): Promise<void> {
  const version = tag.replace(/^v/, "");
  await db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, metadata_access, artifacts_access, published_at,
        metadata_json, created_at, modified_at, deliverable_id, seq, channel)
     VALUES (?, ?, ?, 'public', 'public', ?, ?, ?, ?, 'app',
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM release_metadata WHERE product = ? AND deliverable_id = 'app'), ?)`,
    SLUG,
    tag,
    version,
    NOW,
    JSON.stringify({ tag, prerelease: !!opts.prerelease }),
    NOW,
    NOW,
    SLUG,
    opts.channel ?? null,
  );
  for (const [buildId, platform, arch] of opts.builds ?? []) {
    const s = stmtUpsertBuild(
      { product: SLUG, releaseId: tag, buildId, platform, arch },
      NOW,
    );
    await db.run(s.sql, ...s.params);
  }
}

async function seedDb(): Promise<Db> {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  const s = stmtEnsureAppDeliverable(SLUG, NOW);
  await db.run(s.sql, ...s.params);
  await seedRelease(db, "v1.0.0", { builds: ALL });
  await seedRelease(db, "v1.1.0", { builds: ALL });
  await seedRelease(db, "v1.2.0", { builds: NO_IOS });
  await seedRelease(db, "v1.3.0-beta.1", { prerelease: true, builds: ALL });
  return db;
}

describe("resolveBuild over D1", () => {
  it("resolves the same rules from the stored rows", async () => {
    const db = await seedDb();
    const at = async (selector: string, platform?: string) =>
      (
        await resolveBuild(db, SLUG, {
          selector,
          ...(platform ? { platform } : {}),
        })
      )?.release.release_id ?? null;
    expect(await at("stable")).toBe("v1.2.0");
    expect(await at("latest")).toBe("v1.2.0");
    expect(await at("stable", "ios")).toBe("v1.1.0");
    expect(await at("beta")).toBe("v1.3.0-beta.1");
    // `staging` is the legacy spelling of `beta` (P0-04 plan §10).
    expect(await at("staging")).toBe("v1.3.0-beta.1");
    expect(await at("1.0.0")).toBe("v1.0.0");
    expect(await at("nightly")).toBeNull();
  });

  it("follows yanks and pins written through the model", async () => {
    const db = await seedDb();
    await yankRelease(db, SLUG, "v1.2.0", "broken", "admin:u1", NOW);
    let r = await resolveBuild(db, SLUG, { selector: "stable" });
    expect(r?.release.release_id).toBe("v1.1.0");

    await setChannelPolicy(
      db,
      { product: SLUG, deliverableId: "app", channel: "stable" },
      { pointerReleaseId: "v1.0.0", pinned: true },
      { source: "admin", by: "admin:u1", now: NOW },
    );
    r = await resolveBuild(db, SLUG, { selector: "stable", buildId: "win" });
    expect(r?.release.release_id).toBe("v1.0.0");
    expect(r?.build?.build_id).toBe("win");
    expect(r?.via).toBe("pinned");
  });

  it("answers null for an unknown deliverable or a product with no releases", async () => {
    const db = await seedDb();
    expect(
      await resolveBuild(db, SLUG, { deliverable: "nope", selector: "stable" }),
    ).toBeNull();
    expect(await resolveBuild(db, "other", { selector: "stable" })).toBeNull();
  });
});

// ── P2b-05: a channel's whole history, newest first ──────────────────────────────────────────

describe("channelCandidates (the storefront feeds' history)", () => {
  it("lists every member newest first, beta including stable, yanks removed", () => {
    const releases = [
      rel("1.0.0", { b: ALL }),
      rel("1.1.0", { b: ALL }),
      rel("1.2.0-beta.1", { b: ALL }),
      rel("1.1.1", { b: NO_IOS }),
    ];
    const base = input({ releases, yanked: new Set(["v1.1.1"]) });
    expect(channelCandidates(base, "stable").map((c) => c.releaseId)).toEqual([
      "v1.1.0",
      "v1.0.0",
    ]);
    expect(channelCandidates(base, "beta").map((c) => c.releaseId)).toEqual([
      "v1.2.0-beta.1",
      "v1.1.0",
      "v1.0.0",
    ]);
  });

  it("a pinned channel lists only releases at or below its pointer, the pointer even if yanked", () => {
    const releases = [rel("2.0.0"), rel("2.1.0"), rel("2.2.0")];
    const base = input({
      releases,
      yanked: new Set(["v2.1.0"]),
      policies: new Map([["stable", pol({ pointer: "v2.1.0", pinned: true })]]),
    });
    expect(channelCandidates(base, "stable").map((c) => c.releaseId)).toEqual([
      "v2.1.0",
      "v2.0.0",
    ]);
  });

  it("agrees with resolveCandidates on the head", () => {
    const releases = [rel("3.0.0", { b: ALL }), rel("3.1.0", { b: ALL })];
    const base = input({ releases });
    expect(channelCandidates(base, "stable")[0]!.releaseId).toBe(
      resolveCandidates(base)!.release.releaseId,
    );
  });
});
