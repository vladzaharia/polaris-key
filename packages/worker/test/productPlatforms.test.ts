import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { SERVICE_SLUGS, type ServicesMap } from "../src/core/services.js";
import { productPlatforms } from "../src/services/distribution/facts.js";
import type { Db } from "../src/db/types.js";
import type {
  CatalogBuild,
  CatalogDeclaredBuild,
  ServiceHooks,
} from "../src/core/hooks.js";

const SLUG = "diceroll";

interface Rel {
  id: string;
  yanked?: boolean;
  builds: [string, string, string | null][]; // platform, arch, format
}

/** A Release hook that serves `channels` (name → newest-first releases) and `declared`. */
function hooksOf(
  channels: Record<string, Rel[]>,
  declared: CatalogDeclaredBuild[] = [],
  kinds = ["app"],
): ServiceHooks {
  const all = Object.values(channels).flat();
  return {
    releaseCatalog: () => ({
      deliverables: async () =>
        kinds.map((kind) => ({ id: kind, kind, packType: null })),
      declaredBuilds: async () => declared,
      knownChannels: async () => Object.keys(channels),
      channelReleases: async (_d: string, channel: string) => ({
        channel,
        releases: (channels[channel] ?? []).map((r) => ({
          releaseId: r.id,
          yanked: r.yanked === true,
        })),
      }),
      builds: async (id: string): Promise<CatalogBuild[]> =>
        (all.find((r) => r.id === id)?.builds ?? []).map(
          ([platform, arch, format], i) => ({
            releaseId: id,
            buildId: `b${i}`,
            platform,
            arch,
            format,
            buildNumber: null,
            minOs: null,
            metadata: null,
          }),
        ),
    }),
  } as unknown as ServiceHooks;
}

async function world(): Promise<Db> {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  return db;
}

const run = (db: Db, hooks: ServiceHooks) =>
  productPlatforms({ db, product: SLUG, hooks, now: NOW });

async function outlet(db: Db, id: string, kind: string, identity: unknown) {
  await db.run(
    `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    SLUG,
    id,
    kind,
    JSON.stringify(identity),
    NOW,
    NOW,
  );
}

async function planned(db: Db, platforms: string[]) {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES (?, 'distribution.intendedPlatforms', ?, 'console', 1, ?, 'test')`,
    SLUG,
    JSON.stringify(platforms),
    NOW,
  );
}

describe("productPlatforms (A-20.2)", () => {
  it("Windows-only builds give [windows]", async () => {
    const db = await world();
    const out = await run(
      db,
      hooksOf({
        stable: [{ id: "v1", builds: [["windows", "x86_64", "msi"]] }],
      }),
    );
    expect(out.platforms).toEqual([
      {
        platform: "windows",
        arches: ["x86_64"],
        formats: ["msi"],
        sources: ["builds"],
      },
    ]);
    expect(out.kinds).toEqual(["app"]);
  });

  it("an arm64-only build gives arches [arm64]", async () => {
    const db = await world();
    const out = await run(
      db,
      hooksOf({ stable: [{ id: "v1", builds: [["macos", "arm64", "dmg"]] }] }),
    );
    expect(out.platforms[0]).toMatchObject({
      platform: "macos",
      arches: ["arm64"],
    });
  });

  it("a declared but unpublished build is sourced `declared` only", async () => {
    const db = await world();
    const out = await run(
      db,
      hooksOf({}, [
        {
          buildId: "linux",
          platform: "linux",
          arch: "x86_64",
          format: "appimage",
        },
      ]),
    );
    expect(out.platforms).toEqual([
      {
        platform: "linux",
        arches: ["x86_64"],
        formats: ["appimage"],
        sources: ["declared"],
      },
    ]);
  });

  it("merges builds with the declaration and the newest release per channel", async () => {
    const db = await world();
    const out = await run(
      db,
      hooksOf(
        {
          stable: [{ id: "v2", builds: [["macos", "arm64", "dmg"]] }],
          beta: [
            { id: "v3", builds: [["macos", "x86_64", "dmg"]] },
            { id: "v2", builds: [["macos", "arm64", "dmg"]] },
          ],
        },
        [{ buildId: "m", platform: "macos", arch: "arm64", format: "dmg" }],
        ["app", "pack"],
      ),
    );
    expect(out.platforms).toEqual([
      {
        platform: "macos",
        arches: ["arm64", "x86_64"],
        formats: ["dmg"],
        sources: ["builds", "declared"],
      },
    ]);
    expect(out.kinds).toEqual(["app", "pack"]);
  });

  it("planned only", async () => {
    const db = await world();
    await planned(db, ["ios", "android"]);
    const out = await run(db, hooksOf({}));
    expect(out.platforms).toEqual([
      { platform: "android", arches: [], formats: [], sources: ["planned"] },
      { platform: "ios", arches: [], formats: [], sources: ["planned"] },
    ]);
  });

  it("a bare direct adds nothing; an explicit direct.platforms adds", async () => {
    const db = await world();
    await outlet(db, "d1", "direct", {});
    expect((await run(db, hooksOf({}))).platforms).toEqual([]);
    await outlet(db, "d2", "direct", { platforms: ["linux", "windows"] });
    await outlet(db, "s1", "steam", { platforms: ["macos"] });
    expect((await run(db, hooksOf({}))).platforms).toEqual([
      { platform: "linux", arches: [], formats: [], sources: ["outlet"] },
      { platform: "windows", arches: [], formats: [], sources: ["outlet"] },
    ]);
  });

  it("a removed outlet adds nothing", async () => {
    const db = await world();
    await outlet(db, "d2", "direct", { platforms: ["linux"] });
    await db.run("UPDATE dist_outlets SET removed_at = ?", NOW);
    expect((await run(db, hooksOf({}))).platforms).toEqual([]);
  });

  it("yanked releases are ignored", async () => {
    const db = await world();
    const out = await run(
      db,
      hooksOf({
        stable: [
          { id: "v2", yanked: true, builds: [["windows", "x86_64", "msi"]] },
          { id: "v1", builds: [["linux", "x86_64", "deb"]] },
        ],
      }),
    );
    expect(out.platforms.map((p) => p.platform)).toEqual(["linux"]);
    const none = await run(
      db,
      hooksOf({
        stable: [
          { id: "v1", yanked: true, builds: [["linux", "x86_64", "deb"]] },
        ],
      }),
    );
    expect(none.platforms).toEqual([]);
  });

  it("Release off: builds and declared are empty, planned and outlet still answer", async () => {
    const db = await world();
    await planned(db, ["web"]);
    const out = await run(db, { releaseCatalog: () => null } as ServiceHooks);
    expect(out).toEqual({
      platforms: [
        { platform: "web", arches: [], formats: [], sources: ["planned"] },
      ],
      kinds: [],
    });
  });

  it("the real hook answers declaredBuilds from the app declaration", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await db.run(
      `INSERT INTO release_deliverables
         (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at)
       VALUES (?, 'app', 'app', NULL, ?, 'manifest', ?, ?)
       ON CONFLICT(product, deliverable_id) DO UPDATE SET def_json = excluded.def_json`,
      SLUG,
      JSON.stringify({
        kind: "app",
        versioning: { scheme: "semver", buildNumber: null },
        channels: {},
        artifacts: [
          {
            id: "win-zip",
            platform: "windows",
            arch: "x86_64",
            format: "zip",
            role: "payload",
            match: "*.zip",
          },
        ],
      }),
      NOW,
      NOW,
    );
    const product = (await loadProduct(env, db, SLUG))!;
    const catalog = buildHooks(
      SERVICES,
      Object.fromEntries(
        SERVICE_SLUGS.map((x) => [
          x,
          { enabled: ["license", "config", "release"].includes(x) },
        ]),
      ) as ServicesMap,
      { env, db, product, now: NOW },
    ).releaseCatalog();
    expect(await catalog!.declaredBuilds()).toEqual([
      {
        buildId: "win-zip",
        platform: "windows",
        arch: "x86_64",
        format: "zip",
      },
    ]);
  });
});
