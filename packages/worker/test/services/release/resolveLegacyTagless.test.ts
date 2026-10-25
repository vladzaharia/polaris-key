/**
 * P2-12.2 (SR-P1 B1): a GitHub release tagged in the tagless shape (`app@0.0.1`) is listed by the
 * sync but has no tag, so the legacy view must never offer it: otherwise it slips past the floor
 * and the stable tag pattern and answers `/version` with "app@0.0.1" (plan D5).
 */
import { describe, expect, it } from "vitest";
import {
  loadDeliverableState,
  resolveInState,
} from "../../../src/services/release/resolve.js";
import {
  stmtEnsureAppDeliverable,
  stmtUpsertBuild,
} from "../../../src/services/release/model.js";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import type { Db } from "../../../src/db/types.js";

const SLUG = "djdl";

/** A release row as the sync writes a GitHub release: version = tag minus `v`, tag in metadata. */
async function githubRelease(db: Db, tag: string): Promise<void> {
  await db.run(
    `INSERT INTO release_metadata (product, release_id, version, source_url, metadata_access,
       artifacts_access, published_at, metadata_json, created_at, modified_at, deliverable_id, seq,
       channel)
     VALUES (?, ?, ?, ?, 'public', 'public', ?, ?, ?, ?, 'app',
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM release_metadata
         WHERE product = ? AND deliverable_id = 'app'), NULL)`,
    SLUG,
    tag,
    tag.replace(/^v/, ""),
    `https://github.com/a/b/releases/tag/${tag}`,
    NOW,
    JSON.stringify({ tag, prerelease: false, assetCount: 1, listedAssets: {} }),
    NOW,
    NOW,
    SLUG,
  );
  const s = stmtUpsertBuild(
    {
      product: SLUG,
      releaseId: tag,
      buildId: "mac",
      platform: "macos",
      arch: "universal",
    },
    NOW,
  );
  await db.run(s.sql, ...s.params);
}

async function world(): Promise<Db> {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  const s = stmtEnsureAppDeliverable(SLUG, NOW);
  await db.run(s.sql, ...s.params);
  await githubRelease(db, "v1.0.0");
  await githubRelease(db, "v2.0.0");
  await githubRelease(db, "app@0.0.1");
  await db.run(
    `INSERT INTO release_channel_floors (product, channel, version, release_id, raised_at)
     VALUES (?, 'stable', '2.0.0', 'v2.0.0', ?)`,
    SLUG,
    NOW,
  );
  return db;
}

const legacy = async (db: Db, selector: string) => {
  const state = (await loadDeliverableState(db, SLUG, "app", null, {
    narrow: true,
    view: "legacy",
  }))!;
  return (
    resolveInState(state, { selector, view: "legacy" })?.release.release_id ??
    null
  );
};

describe("the legacy view never offers a tagless-shaped GitHub release", () => {
  it("answers the floor release, not app@0.0.1", async () => {
    const db = await world();
    expect(await legacy(db, "stable")).toBe("v2.0.0");
  });

  it("answers nothing once the floor release is gone upstream", async () => {
    const db = await world();
    await db.run(
      `INSERT INTO release_health (product, subject_kind, subject_id, status, checked_at,
         details_json)
       VALUES (?, 'release', 'v2.0.0', 'degraded', ?, '{"absentUpstream":true}')`,
      SLUG,
      NOW,
    );
    expect(await legacy(db, "stable")).toBeNull();
  });

  it("never matches it by version either", async () => {
    const db = await world();
    expect(await legacy(db, "app@0.0.1")).toBeNull();
  });
});
