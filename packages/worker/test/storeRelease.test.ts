/**
 * P2-12.3 (plans/P2-12.md D3, §6.2): the truth store in GitHub's shape.
 *
 * `storeRelease()` builds, from the rows a real sync wrote against the fake GitHub, the `Release`
 * the legacy compute steps receive; `resolveStoreSelector` resolves a selector over those rows.
 * Nothing is routed to either yet, so the oracle is the legacy path itself (`resolveSelector`
 * over the same fake GitHub) wherever the legacy path can answer.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW } from "./seed.js";
import {
  envFor,
  github,
  release,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { yankRelease } from "../src/services/release/model.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import { resolveSelector } from "../src/services/release/gateway.js";
import {
  getReleaseConfig,
  type ResolvedConfig,
} from "../src/services/release/config.js";
import { NotFoundError, type Release } from "../src/services/release/github.js";
import {
  checkedDigest,
  resolveStoreSelector,
  storeRelease,
} from "../src/services/release/storeRelease.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { ReleaseAsset } from "../src/services/release/github.js";

function asset(id: number, name: string): ReleaseAsset {
  return {
    id,
    name,
    size: 1000 + id,
    content_type: "text/html",
    browser_download_url: `https://github.com/acme/djdl/releases/download/x/${name}`,
  };
}

const D1 = `sha256:${"1".repeat(64)}`;

/** What the store may not reproduce: `content_type` is the store's derived kind type (never relayed, R6-04). */
const sansContentType = (r: Release): unknown => ({
  ...r,
  assets: r.assets.map(({ content_type: _c, ...a }) => a),
});

interface World {
  db: Db;
  env: Env;
  fetchImpl: FetchImpl;
  state: { releases: Release[] };
  resync: () => Promise<void>;
}

async function world(
  releases: Release[],
  cfg: Record<string, unknown> = {},
): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db, cfg);
  const env = envFor();
  const state = { releases };
  const { fetchImpl } = github(state);
  const resync = async (): Promise<void> => {
    await syncReleaseStore(env, db, SLUG, NOW, fetchImpl);
  };
  await resync();
  return { db, env, fetchImpl, state, resync };
}

const config = async (db: Db) => (await getReleaseConfig(db, SLUG))!;

describe("storeRelease: the Release the legacy compute receives", () => {
  it("equals GitHub's release after a real sync, undescribed", async () => {
    const w = await world([
      release("v1.1.0", [
        asset(201, "djdl-arm64"),
        { ...asset(202, "djdl-1.1.0-arm64.dmg"), digest: D1 },
        asset(203, "djdl-1.1.0-arm64.dmg.sig"),
      ]),
      release("v1.2.0-beta.1", [asset(301, "djdl-beta-arm64")], {
        prerelease: true,
      }),
    ]);
    for (const github of w.state.releases)
      expect(
        sansContentType((await storeRelease(w.db, SLUG, github.tag_name))!),
      ).toEqual(sansContentType(github));
  });

  it("equals GitHub's release for a described release (builds attached)", async () => {
    const db = makeTestDb();
    await seedReleaseProduct(db);
    const env = envFor();
    const state = {
      releases: [
        release("v1.1.0", [
          asset(201, "djdl-arm64"),
          asset(202, "djdl-1.1.0-arm64.dmg"),
        ]),
        release("v1.0.0", [
          asset(101, "djdl-arm64"),
          asset(102, "djdl-1.0.0-arm64.dmg"),
        ]),
      ],
    };
    await syncAndDescribe(env, db, github(state).fetchImpl);
    // The descriptor's hash for the CLI file is the one place the store knows more than GitHub
    // listed (D3: the digest is GitHub's, else the row's sha256).
    const sansDigest = (r: Release) => ({
      ...r,
      assets: r.assets.map(({ digest: _d, ...a }) => a),
    });
    for (const gh of state.releases) {
      const got = (await storeRelease(db, SLUG, gh.tag_name))!;
      expect(sansContentType(sansDigest(got))).toEqual(
        sansContentType(sansDigest(gh)),
      );
      expect(got.assets.find((a) => a.name === "djdl-arm64")!.digest).toMatch(
        /^sha256:[0-9a-f]{64}$/,
      );
    }
  });

  it("offers a descriptor file with a build even when GitHub no longer lists it, but not a stale file", async () => {
    const w = await world([
      release("v1.1.0", [asset(201, "djdl-arm64"), asset(202, "stale.dmg")]),
    ]);
    // A descriptor row (a build) for 201, and a hand-made one for an id GitHub never listed.
    await w.db.run(
      `UPDATE release_artifacts SET build_id = 'cli' WHERE product = ? AND artifact_id = '201'`,
      SLUG,
    );
    await w.db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, access, created_at, build_id, size_bytes)
       VALUES (?, 'v1.1.0', '999', 'described-only', 'public', ?, 'cli', 5)`,
      SLUG,
      NOW,
    );
    w.state.releases = [release("v1.1.0", [asset(201, "djdl-arm64")])];
    await w.resync();
    const got = (await storeRelease(w.db, SLUG, "v1.1.0"))!;
    expect(got.assets.map((a) => a.id)).toEqual([201, 999]);
  });

  it("a clobbered asset offers only the new id, and a deleted asset is gone", async () => {
    const w = await world([
      release("v1.1.0", [
        asset(201, "djdl-arm64"),
        asset(202, "djdl-1.1.0-arm64.dmg"),
      ]),
    ]);
    const ids = async () =>
      (await storeRelease(w.db, SLUG, "v1.1.0"))!.assets.map((a) => a.id);
    expect(await ids()).toEqual([201, 202]);
    // --clobber: the same name under a new id. Both rows exist in the store.
    w.state.releases = [
      release("v1.1.0", [
        asset(211, "djdl-arm64"),
        asset(202, "djdl-1.1.0-arm64.dmg"),
      ]),
    ];
    await w.resync();
    const rows = await w.db.all<{ artifact_id: string }>(
      "SELECT artifact_id FROM release_artifacts WHERE product = ? AND release_id = 'v1.1.0'",
      SLUG,
    );
    expect(rows.map((r) => r.artifact_id).sort()).toContain("201");
    expect(await ids()).toEqual([202, 211]);
    // The dmg is deleted upstream.
    w.state.releases = [release("v1.1.0", [asset(211, "djdl-arm64")])];
    await w.resync();
    expect(await ids()).toEqual([211]);
  });

  it("takes the digest from listedAssets, else the row's sha256, and refuses a malformed digest", async () => {
    const w = await world([
      release("v1.1.0", [
        { ...asset(201, "djdl-arm64"), digest: D1 },
        { ...asset(202, "djdl-2"), digest: "sha256:zzzz" },
        { ...asset(203, "djdl-3"), digest: `sha256:${"A".repeat(64)}` },
        asset(204, "djdl-4"),
      ]),
    ]);
    // The row's own hash backs an asset GitHub gave no valid digest for.
    await w.db.run(
      `UPDATE release_artifacts SET sha256 = ? WHERE product = ? AND artifact_id = '204'`,
      "b".repeat(64),
      SLUG,
    );
    const byId = Object.fromEntries(
      (await storeRelease(w.db, SLUG, "v1.1.0"))!.assets.map((a) => [
        a.id,
        a.digest ?? null,
      ]),
    );
    expect(byId).toEqual({
      201: D1,
      202: null,
      203: `sha256:${"a".repeat(64)}`,
      204: `sha256:${"b".repeat(64)}`,
    });
    expect(checkedDigest("sha256:abc")).toBeNull();
    expect(checkedDigest(`sha256:${"g".repeat(64)}`)).toBeNull();
    expect(checkedDigest(`md5:${"a".repeat(64)}`)).toBeNull();
    expect(checkedDigest(null)).toBeNull();
  });

  it("a release with no listedAssets offers all of its rows", async () => {
    const w = await world([
      release("v1.1.0", [asset(201, "djdl-arm64"), asset(202, "djdl-x86_64")]),
    ]);
    await w.db.run(
      `UPDATE release_metadata SET metadata_json = json_remove(metadata_json, '$.listedAssets')
        WHERE product = ?`,
      SLUG,
    );
    expect(
      (await storeRelease(w.db, SLUG, "v1.1.0"))!.assets.map((a) => a.id),
    ).toEqual([201, 202]);
  });

  it("never offers a tagless or GitHub-less row, or one that is missing", async () => {
    const w = await world([release("v1.1.0", [asset(201, "djdl-arm64")])]);
    const insert = (id: string, meta: unknown, seq: number) =>
      w.db.run(
        `INSERT INTO release_metadata
           (product, release_id, version, metadata_access, artifacts_access, published_at,
            metadata_json, created_at, modified_at, deliverable_id, seq)
         VALUES (?, ?, '2.0.0', 'public', 'public', ?, ?, ?, ?, 'app', ?)`,
        SLUG,
        id,
        NOW,
        JSON.stringify(meta),
        NOW,
        NOW,
        seq,
      );
    await insert("app@2.0.0", { descriptor: { status: "ingested" } }, 98);
    await insert("v2.0.0", { prerelease: false }, 99);
    expect(await storeRelease(w.db, SLUG, "app@2.0.0")).toBeNull();
    expect(await storeRelease(w.db, SLUG, "v2.0.0")).toBeNull();
    expect(await storeRelease(w.db, SLUG, "v9.9.9")).toBeNull();
    expect(await storeRelease(w.db, SLUG, "v1.1.0")).not.toBeNull();
  });
});

describe("resolveStoreSelector", () => {
  const releases = () => [
    release("v1.2.0", [asset(401, "djdl-arm64")], {
      published_at: "2026-03-01T00:00:00Z",
    }),
    release("v1.3.0-beta.1", [asset(501, "djdl-arm64")], {
      prerelease: true,
      published_at: "2026-04-01T00:00:00Z",
    }),
    release("v1.1.0", [asset(301, "djdl-arm64")], {
      published_at: "2026-02-01T00:00:00Z",
    }),
    release("nightly-20260401", [asset(601, "djdl-arm64")], {
      prerelease: true,
      published_at: "2026-04-02T00:00:00Z",
    }),
  ];
  const manual = JSON.stringify([{ name: "nightly", regex: "nightly-.+" }]);

  const store = async (w: World, selector: string | undefined) => {
    try {
      const r = await resolveStoreSelector(w.db, await config(w.db), selector);
      return r.release.tag_name;
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  };
  const legacy = async (w: World, selector: string | undefined) => {
    try {
      const r = await resolveSelector(
        w.env,
        w.db,
        (await config(w.db)) as ResolvedConfig,
        selector,
        NOW,
        w.fetchImpl,
      );
      return r.release.tag_name;
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  };

  it("agrees with the GitHub path on omitted, latest, stable, beta, a manual channel and a pinned version", async () => {
    const w = await world(releases(), { manual_channels_json: manual });
    const expected: [string | undefined, string | null][] = [
      [undefined, "v1.2.0"],
      ["latest", "v1.2.0"],
      ["stable", "v1.2.0"],
      ["beta", "v1.3.0-beta.1"],
      ["staging", "v1.3.0-beta.1"],
      ["nightly", "nightly-20260401"],
      ["1.1.0", "v1.1.0"],
      ["1.2.0", "v1.2.0"],
      ["1.3.0-beta.1", "v1.3.0-beta.1"],
      ["9.9.9", null],
      // `v1.2.0` is not a selector at all (classifyChannel), on either path.
      ["v1.2.0", null],
      ["nope", null],
    ];
    for (const [sel, want] of expected) {
      expect(await store(w, sel), `store ${sel}`).toBe(want);
      expect(await legacy(w, sel), `legacy ${sel}`).toBe(want);
    }
  });

  it("returns the GitHub-shaped release and the classified selector", async () => {
    const w = await world(releases());
    const r = await resolveStoreSelector(w.db, await config(w.db), "beta");
    expect(r.sel).toEqual({ kind: "beta", raw: "beta" });
    expect(r.release.tag_name).toBe("v1.3.0-beta.1");
    expect(r.release.prerelease).toBe(true);
    expect(r.release.assets.map((a) => a.id)).toEqual([501]);
    expect(r.release.body).toBe("Notes for v1.3.0-beta.1");
  });

  it("dev and pr-<n>: the store knows no workflow run, so pr-<n> resolves nothing; dev follows the dev channel", async () => {
    const w = await world(releases());
    expect(await store(w, "pr-12")).toBeNull();
    // `dev` includes beta and stable (dev ⊇ beta ⊇ stable): the newest prerelease wins.
    expect(await store(w, "dev")).toBe("v1.3.0-beta.1");
  });

  it("a pinned version names a yanked release; a moving selector skips it", async () => {
    const w = await world(releases());
    await yankRelease(w.db, SLUG, "v1.2.0", "test", "t", NOW);
    expect(await store(w, "1.2.0")).toBe("v1.2.0");
    expect(await store(w, "stable")).toBe("v1.1.0");
  });

  it("a release gone upstream is not offered, even pinned, and its floor 404s the channel (legacy view)", async () => {
    const w = await world(releases());
    await w.db.run(
      `INSERT INTO release_health (product, subject_kind, subject_id, status, checked_at, details_json)
       VALUES (?, 'release', 'v1.2.0', 'degraded', ?, '{"absentUpstream":true}')
       ON CONFLICT(product, subject_kind, subject_id) DO UPDATE SET
         status = 'degraded', details_json = '{"absentUpstream":true}'`,
      SLUG,
      NOW,
    );
    expect(await store(w, "1.2.0")).toBeNull();
    // The sync raised the stable floor to 1.2.0 and its release is gone: a 404, never a
    // silent fall back to 1.1.0 (R6-10). A pinned older version still names itself.
    expect(await store(w, "stable")).toBeNull();
    expect(await store(w, "1.1.0")).toBe("v1.1.0");
  });

  it("a store with no app releases is not found", async () => {
    const w = await world([]);
    expect(await store(w, "stable")).toBeNull();
  });
});
