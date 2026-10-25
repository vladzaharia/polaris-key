/**
 * P2-12.8 (plans/P2-12.md §6.5): `release.backfill-store` and `release.materialise-workflow-beta`,
 * run through the P0-49 runner (dry run, apply, a re-apply that does nothing, down), and the
 * runner's detail hand-over they depend on (`reported` to apply, `applied` to down).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { NOW } from "../../seed.js";
import { KvMock } from "../../kvMock.js";
import { installDigestStream } from "../../r2Mock.js";
import {
  envFor,
  github,
  release,
  seedReleaseProduct,
  SLUG,
} from "../../releaseRoutesFixture.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { syncReleaseStore } from "../../../src/services/release/sync.js";
import type { Release } from "../../../src/services/release/github.js";
import type { FetchImpl } from "../../../src/services/release/githubApp.js";
import {
  backfillStoreJob,
  createBackfillStoreJob,
  createMaterialiseWorkflowBetaJob,
  materialiseWorkflowBetaJob,
} from "../../../src/services/release/resolverJobs.js";
import { getReleaseConfig } from "../../../src/services/release/config.js";
import {
  RECENT_PULL_REQUESTS,
  recentChannelPullRequests,
} from "../../../src/services/release/gateway.js";
import { apply, down, dryRun } from "../../../src/core/migrate/runner.js";
import type { MigrationContext } from "../../../src/core/migrate/job.js";
import { migrationJobs } from "../../../src/core/contributions.js";
import "../../../src/mount.js";

const ACTOR = { sub: "op", name: "Op", email: null };

const rel = (tag: string, n: number, over: Partial<Release> = {}): Release =>
  release(tag, [], {
    published_at: `2026-01-${String(n).padStart(2, "0")}T03:04:05Z`,
    ...over,
  });

interface World {
  db: Db;
  env: Env;
  state: { releases: Release[] };
  /** The head branches the workflow's successful beta runs name. */
  runs: { branches: string[] };
  api: string[];
  fetchImpl: FetchImpl;
  ctx: (at?: number) => MigrationContext;
}

async function world(
  releases: Release[],
  over: Record<string, unknown> = { channel_workflow: "ci.yml" },
  sync = true,
): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db, over);
  const env = envFor({ kv: new KvMock() });
  const state = { releases };
  const gh = github(state);
  const runs = { branches: ["1.3.0-beta.1"] };
  const api: string[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    if (/\/actions\/workflows\/[^/]+\/runs\?/.test(url)) {
      api.push(url);
      return new Response(
        JSON.stringify({
          workflow_runs: runs.branches.map((b, i) => ({
            head_branch: b,
            head_sha: `${i}`.repeat(40),
          })),
        }),
        { status: 200 },
      );
    }
    return gh.fetchImpl(input, init);
  };
  if (sync) await syncReleaseStore(env, db, SLUG, NOW, gh.fetchImpl);
  return {
    db,
    env,
    state,
    runs,
    api,
    fetchImpl,
    ctx: (at = NOW) => ({ env, db, now: at }),
  };
}

const RELEASES = () => [
  rel("v1.3.0-beta.1", 4, { prerelease: true }),
  rel("v1.2.0", 3),
  rel("v1.1.0", 2),
];

const channelOf = async (db: Db, id: string) =>
  (
    await db.first<{ channel: string | null }>(
      "SELECT channel FROM release_metadata WHERE product = ? AND release_id = ?",
      SLUG,
      id,
    )
  )?.channel;

const auditActions = async (db: Db) =>
  (
    await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE action LIKE 'migration.release.%' ORDER BY at, rowid",
    )
  ).map((r) => r.action);

beforeAll(() => installDigestStream());

describe("the release resolver jobs: shape", () => {
  it("are contributed by Release", () => {
    const ids = migrationJobs().map((j) => j.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "release.backfill-store",
        "release.materialise-workflow-beta",
      ]),
    );
    expect(migrationJobs()).toEqual(
      expect.arrayContaining([backfillStoreJob, materialiseWorkflowBetaJob]),
    );
  });

  it("have a unit per linked product, and beta's only for a channel workflow", async () => {
    const w = await world(RELEASES(), { channel_workflow: null });
    expect(await backfillStoreJob.units(w.ctx())).toEqual([SLUG]);
    expect(await materialiseWorkflowBetaJob.units(w.ctx())).toEqual([]);
  });
});

describe("release.backfill-store", () => {
  it("syncs a linked product with an empty store, then re-applies as a no-op", async () => {
    const w = await world(RELEASES(), { channel_workflow: null }, false);
    const job = createBackfillStoreJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(1);
    expect(report.units[0]!.detail).toEqual({ appRows: 0, unlisted: 0 });

    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    expect(applied.ok && applied.run.status).toBe("applied");
    expect(applied.ok && applied.run.changes).toBe(1);
    expect(
      (
        await w.db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM release_metadata WHERE product = ?",
          SLUG,
        )
      )?.n,
    ).toBe(3);
    expect(await auditActions(w.db)).toEqual([
      "migration.release.backfill-store",
    ]);

    // A fresh dry run reports nothing left; a unit applied again does nothing.
    expect((await dryRun(w.ctx(NOW + 2), job, ACTOR)).changes).toBe(0);
    const calls = w.api.length;
    const out = await job.apply(w.ctx(NOW + 3), SLUG);
    expect(out).toMatchObject({ changes: 0 });
    expect(w.api.length).toBe(calls);
    expect(await auditActions(w.db)).toHaveLength(1);
  });

  it("backfills listed releases that lack listedAssets, and only those", async () => {
    const w = await world(RELEASES(), { channel_workflow: null });
    await w.db.run(
      `UPDATE release_metadata SET metadata_json = json_remove(metadata_json, '$.listedAssets')
        WHERE product = ? AND release_id IN ('v1.2.0', 'v1.1.0')`,
      SLUG,
    );
    const job = createBackfillStoreJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(2);
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    expect(applied.ok && applied.run.changes).toBe(2);
    expect((await dryRun(w.ctx(NOW + 2), job, ACTOR)).changes).toBe(0);
  });

  it("answers 0 on down and says why", async () => {
    const w = await world(RELEASES(), { channel_workflow: null }, false);
    const job = createBackfillStoreJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    if (!applied.ok) throw new Error("apply refused");
    const undone = await down(w.ctx(NOW + 2), job, ACTOR, applied.run.id);
    expect(undone.ok && undone.run.changes).toBe(0);
    expect(await job.down(w.ctx(), SLUG)).toMatchObject({
      changes: 0,
      detail: { skipped: expect.stringMatching(/no earlier state/) },
    });
  });
});

describe("release.materialise-workflow-beta", () => {
  it("snapshots the workflow, branch and tag set in the dry run", async () => {
    const w = await world(RELEASES());
    const job = createMaterialiseWorkflowBetaJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(1);
    expect(report.units[0]!.detail).toEqual({
      channelWorkflow: "ci.yml",
      betaBranch: "main",
      tags: ["0000000", "v1.3.0-beta.1"],
      wouldSet: ["v1.3.0-beta.1"],
    });
    expect(await channelOf(w.db, "v1.3.0-beta.1")).toBeNull();
  });

  it("sets channel=beta on the undescribed rows in the set, and a re-apply does nothing", async () => {
    const w = await world(RELEASES());
    const job = createMaterialiseWorkflowBetaJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    expect(applied.ok && applied.run.changes).toBe(1);
    expect(await channelOf(w.db, "v1.3.0-beta.1")).toBe("beta");
    expect(await channelOf(w.db, "v1.2.0")).toBeNull();
    expect(applied.ok && applied.run.units[0]!.detail).toEqual({
      ids: ["v1.3.0-beta.1"],
    });
    expect(await auditActions(w.db)).toEqual([
      "migration.release.materialise-workflow-beta",
    ]);

    const again = await apply(w.ctx(NOW + 2), job, ACTOR, report.id);
    expect(again.ok && again.noop).toBe(true);
    // The unit itself, applied again, changes nothing and writes no audit row.
    expect(
      await job.apply(w.ctx(NOW + 3), SLUG, report.units[0]!.detail),
    ).toEqual({ changes: 0, detail: { ids: [] } });
    expect(await auditActions(w.db)).toHaveLength(1);
    expect((await dryRun(w.ctx(NOW + 4), job, ACTOR)).changes).toBe(0);
  });

  it("leaves described rows and rows with a channel alone", async () => {
    const w = await world(RELEASES());
    w.runs.branches = ["1.3.0-beta.1", "1.1.0"];
    await w.db.run(
      `UPDATE release_metadata SET metadata_json = json_set(metadata_json, '$.descriptor', json('{"status":"ingested"}'))
        WHERE product = ? AND release_id = 'v1.3.0-beta.1'`,
      SLUG,
    );
    await w.db.run(
      "UPDATE release_metadata SET channel = 'staging' WHERE product = ? AND release_id = 'v1.1.0'",
      SLUG,
    );
    const job = createMaterialiseWorkflowBetaJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(0);
    expect(await channelOf(w.db, "v1.3.0-beta.1")).toBeNull();
    expect(await channelOf(w.db, "v1.1.0")).toBe("staging");
  });

  it("refuses a report whose workflow or branch has since changed", async () => {
    const w = await world(RELEASES());
    const job = createMaterialiseWorkflowBetaJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    await w.db.run(
      "UPDATE release_config SET beta_branch = 'next' WHERE product = ?",
      SLUG,
    );
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    expect(applied.ok && applied.run.status).toBe("failed");
    expect(await channelOf(w.db, "v1.3.0-beta.1")).toBeNull();
  });

  it("down resets only rows still beta and still undescribed", async () => {
    // Every build in the beta set is a prerelease here; a stable one is never marked (below).
    const w = await world(RELEASES().map((r) => ({ ...r, prerelease: true })));
    w.runs.branches = ["1.3.0-beta.1", "1.2.0", "1.1.0"];
    const job = createMaterialiseWorkflowBetaJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(3);
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    if (!applied.ok) throw new Error("apply refused");
    // An operator re-channels one row and a descriptor claims another since the apply.
    await w.db.run(
      "UPDATE release_metadata SET channel = 'staging' WHERE product = ? AND release_id = 'v1.2.0'",
      SLUG,
    );
    await w.db.run(
      `UPDATE release_metadata SET metadata_json = json_set(metadata_json, '$.descriptor', json('{"status":"ingested"}'))
        WHERE product = ? AND release_id = 'v1.1.0'`,
      SLUG,
    );
    const undone = await down(w.ctx(NOW + 2), job, ACTOR, applied.run.id);
    expect(undone.ok && undone.run.changes).toBe(1);
    expect(undone.ok && undone.run.units[0]!.detail).toEqual({
      ids: ["v1.3.0-beta.1"],
      skipped: 2,
    });
    expect(await channelOf(w.db, "v1.3.0-beta.1")).toBeNull();
    expect(await channelOf(w.db, "v1.2.0")).toBe("staging");
    expect(await channelOf(w.db, "v1.1.0")).toBe("beta");
    expect(await auditActions(w.db)).toEqual([
      "migration.release.materialise-workflow-beta",
      "migration.release.materialise-workflow-beta.down",
    ]);
  });

  it("never marks a stable semver release the beta set happens to name", async () => {
    const w = await world(RELEASES());
    w.runs.branches = ["1.3.0-beta.1", "1.2.0", "1.1.0"];
    const job = createMaterialiseWorkflowBetaJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(1);
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    expect(applied.ok && applied.run.changes).toBe(1);
    expect(await channelOf(w.db, "v1.3.0-beta.1")).toBe("beta");
    expect(await channelOf(w.db, "v1.2.0")).toBeNull();
    expect(await channelOf(w.db, "v1.1.0")).toBeNull();
  });

  it("sets only the ids the dry run listed", async () => {
    const w = await world(RELEASES());
    const job = createMaterialiseWorkflowBetaJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(
      (report.units[0]!.detail as { wouldSet: string[] }).wouldSet,
    ).toEqual(["v1.3.0-beta.1"]);
    // A prerelease the workflow also built appears after the operator read the report.
    const reported = report.units[0]!.detail;
    w.state.releases.unshift(rel("v1.4.0-beta.1", 5, { prerelease: true }));
    await syncReleaseStore(w.env, w.db, SLUG, NOW + 1, w.fetchImpl);
    const out = await job.apply(w.ctx(NOW + 1), SLUG, {
      ...(reported as object),
      tags: ["v1.3.0-beta.1", "v1.4.0-beta.1"],
    });
    expect((out as { detail?: unknown }).detail).toEqual({
      ids: ["v1.3.0-beta.1"],
    });
    expect(await channelOf(w.db, "v1.4.0-beta.1")).toBeNull();
  });

  it("is all or nothing: a failing write leaves no row changed", async () => {
    const w = await world(RELEASES().map((r) => ({ ...r, prerelease: true })));
    w.runs.branches = ["1.3.0-beta.1", "1.2.0", "1.1.0"];
    const job = createMaterialiseWorkflowBetaJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(3);
    const updates: string[] = [];
    const failing = Object.assign(Object.create(w.db), {
      all: async (sql: string, ...p: never[]) => {
        if (/UPDATE release_metadata/.test(sql)) {
          updates.push(sql);
          throw new Error("d1 failed");
        }
        return w.db.all(sql, ...p);
      },
    }) as Db;
    await expect(
      job.apply(
        { env: w.env, db: failing, now: NOW + 1 },
        SLUG,
        report.units[0]!.detail,
      ),
    ).rejects.toThrow("d1 failed");
    expect(updates).toHaveLength(1);
    for (const id of ["v1.3.0-beta.1", "v1.2.0", "v1.1.0"])
      expect(await channelOf(w.db, id)).toBeNull();
    expect(await auditActions(w.db)).toEqual([]);
  });
});

describe("recentChannelPullRequests", () => {
  it("answers at most 10 pull requests, deduplicated, integers only", async () => {
    const w = await world(RELEASES());
    const cfg = (await getReleaseConfig(w.db, SLUG))!;
    const fetchImpl: FetchImpl = async (input) => {
      if (String(input).includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      return new Response(
        JSON.stringify({
          workflow_runs: [
            {
              pull_requests: Array.from({ length: 30 }, (_, i) => ({
                number: i + 1,
              })).concat([{ number: 3 }, { number: -1 }, { number: 1.5 }]),
            },
          ],
        }),
        { status: 200 },
      );
    };
    const prs = await recentChannelPullRequests(
      w.env,
      cfg as never,
      NOW,
      fetchImpl,
    );
    expect(prs).toHaveLength(RECENT_PULL_REQUESTS);
    expect(prs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
