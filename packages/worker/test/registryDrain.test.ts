/**
 * The package-feed render-queue drain (plans/F-01.md §6.5), wired by the feed-adapter contract:
 *
 *   - `watchRenderEnqueues` sees exactly the statements that enqueue a render;
 *   - Core's `drainRenderQueue` hands each owner's rows to the enabled service's
 *     `registryMaterialiser`, consumes a row only while its generation is the one read, drops
 *     rows with nothing to render, and keeps a failed product's rows;
 *   - Distribution's materialiser renders through the adapters' renderers into R2 (one package,
 *     and `*` for every package), and consumes without rendering when nothing can render;
 *   - `dispatch` drains in `waitUntil` after a request that enqueued, and only then;
 *   - a failing row counts its attempts and sits behind fresh rows;
 *   - the cron (`runRegistryRenders`) drains and self-checks, and a render failure is the
 *     `registry` step's, never the connector-poll tick's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_KEK, seedProduct } from "./seed.js";
import { CONSOLE, enableServices, envFor } from "./releaseRoutesFixture.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type {
  RegistryMaterialiser,
  ServiceRegistry,
} from "../src/core/registry.js";
import {
  ENQUEUE_SQL,
  RENDER_ALL,
  type RenderReason,
  drainRenderQueue,
  readRenderQueue,
  selfCheckRenders,
  stmtEnqueuePackageRender,
  watchRenderEnqueues,
} from "../src/core/registryQueue.js";
import { SERVICES } from "../src/mount.js";
import { dispatch } from "../src/dispatch.js";
import {
  CONNECTOR_POLL_CRON,
  MAINTENANCE_CRON,
  handleScheduled,
  runRegistryRenders,
  type MaintenanceReport,
} from "../src/scheduled.js";
import { renderRecordKey } from "../src/services/distribution/registry/materialise.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import { distributionService } from "../src/services/distribution/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";

installDigestStream();

const OWNER = "acme";
let db: Db;
let env: Env;
let r2: R2Mock;

beforeEach(async () => {
  forgetRegistrySettings();
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_KEK = TEST_KEK;
  env.PKG_ORIGIN = "https://pkg.example.test";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  await seedProduct(db, OWNER);
  await enableServices(db, true, OWNER);
});

/** One npm package with one live version on stable, as F-03's ingest leaves it. */
async function seedNpmPackage(deliverableId: string, name: string) {
  await db.run(
    `INSERT INTO release_deliverables
       (product, deliverable_id, kind, def_source, def_json, created_at, modified_at, ecosystem,
        package_name)
     VALUES (?, ?, 'package', 'manifest', ?, ?, ?, 'npm', ?)`,
    OWNER,
    deliverableId,
    JSON.stringify({
      kind: "package",
      ecosystem: "npm",
      name,
      artifacts: { tarball: { match: "*.tgz" } },
    }),
    NOW,
    NOW,
    name,
  );
  const releaseId = `${deliverableId}@1.0.0`;
  await db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, published_at, created_at, modified_at, deliverable_id,
        seq, channel)
     VALUES (?, ?, '1.0.0', ?, ?, ?, ?, 1, 'stable')`,
    OWNER,
    releaseId,
    NOW,
    NOW,
    NOW,
    deliverableId,
  );
  await db.run(
    `INSERT INTO release_packages
       (product, ecosystem, name_norm, version, deliverable_id, release_id, name, state,
        files_json, metadata_json, source_json, published_at)
     VALUES (?, 'npm', ?, '1.0.0', ?, ?, ?, 'live', ?, ?, '{"kind":"static"}', ?)`,
    OWNER,
    name.toLowerCase(),
    deliverableId,
    releaseId,
    name,
    JSON.stringify([
      {
        name: "pkg-1.0.0.tgz",
        type: "npm-tarball",
        sha256: "a".repeat(64),
        size: 1200,
        sha512: "b".repeat(128),
      },
    ]),
    JSON.stringify({ name, version: "1.0.0" }),
    NOW,
  );
}

async function enqueue(deliverableId: string, at = NOW): Promise<void> {
  const s = stmtEnqueuePackageRender(OWNER, deliverableId, "publish", at);
  await db.run(s.sql, ...s.params);
}

const queued = async () =>
  (await readRenderQueue(db, 100)).map((r) => r.deliverableId);
const rendered = () => r2.keys().filter((k) => k.startsWith("registry/"));

describe("watchRenderEnqueues", () => {
  it("watches the exact SQL stmtEnqueuePackageRender writes (ENQUEUE_SQL)", () => {
    const reasons: RenderReason[] = [
      "publish",
      "yank",
      "unyank",
      "deprecate",
      "undeprecate",
      "channel",
      "settings",
      "package-feeds",
      "rebuild",
    ];
    for (const reason of reasons)
      expect(
        ENQUEUE_SQL.test(
          stmtEnqueuePackageRender(OWNER, RENDER_ALL, reason, NOW).sql,
        ),
      ).toBe(true);
    expect(ENQUEUE_SQL.test("DELETE FROM registry_render_queue")).toBe(false);
  });

  it("flags a run or a batch that writes the render queue, and nothing else", async () => {
    const w = watchRenderEnqueues(db);
    await w.db.first("SELECT 1");
    await w.db.run("UPDATE products SET name = name WHERE slug = ?", OWNER);
    expect(w.enqueued()).toBe(false);
    await w.db.batch([stmtEnqueuePackageRender(OWNER, "x", "publish", NOW)]);
    expect(w.enqueued()).toBe(true);
    const w2 = watchRenderEnqueues(db);
    const s = stmtEnqueuePackageRender(OWNER, "y", "publish", NOW);
    await w2.db.run(s.sql, ...s.params);
    expect(w2.enqueued()).toBe(true);
    expect(await queued()).toEqual(["x", "y"]);
  });
});

describe("Core's drain (drainRenderQueue)", () => {
  function fake(impl: RegistryMaterialiser["drain"]): ServiceRegistry {
    const m: RegistryMaterialiser = { drain: impl, selfCheck: async () => 0 };
    return new Map([
      ["distribution", { ...distributionService, registryMaterialiser: m }],
    ]);
  }

  it("hands an owner's rows to the enabled materialiser and deletes what it consumed", async () => {
    await enqueue("a");
    await enqueue("b");
    const seen: string[] = [];
    const out = await drainRenderQueue(
      fake(async (ctx, rows, consume) => {
        expect(ctx.product.slug).toBe(OWNER);
        for (const r of rows) {
          seen.push(r.deliverableId);
          if (r.deliverableId === "a") await consume(r);
        }
        return { rendered: 1, failed: 1 };
      }),
      { env, db, now: NOW },
    );
    expect(seen).toEqual(["a", "b"]);
    expect(out).toEqual({ rendered: 1, failed: 1, dropped: 0 });
    expect(await queued()).toEqual(["b"]);
  });

  it("never deletes a row re-enqueued during the render (its generation moved)", async () => {
    await enqueue("a");
    await drainRenderQueue(
      fake(async (_ctx, rows, consume) => {
        await enqueue("a", NOW + 1); // a publish lands mid-render
        for (const r of rows) await consume(r);
        return { rendered: 1, failed: 0 };
      }),
      { env, db, now: NOW },
    );
    expect(await queued()).toEqual(["a"]);
  });

  it("drops rows with nothing to render: Distribution off, or no materialiser", async () => {
    await enqueue("a");
    await enableServices(db, false, OWNER);
    expect(await drainRenderQueue(SERVICES, { env, db, now: NOW })).toEqual({
      rendered: 0,
      failed: 0,
      dropped: 1,
    });
    expect(await queued()).toEqual([]);
  });

  it("keeps a failing product's rows for the next drain", async () => {
    await enqueue("a");
    const out = await drainRenderQueue(
      fake(async () => {
        throw new Error("R2 down");
      }),
      { env, db, now: NOW },
    );
    expect(out.failed).toBe(1);
    expect(await queued()).toEqual(["a"]);
  });

  it("counts a failed row's attempts and reads it behind fresh rows; an enqueue resets it", async () => {
    await enqueue("stuck", NOW - 100);
    const failing = fake(async (_ctx, rows, consume) => {
      for (const r of rows) if (r.deliverableId !== "stuck") await consume(r);
      return { rendered: rows.length - 1, failed: 1 };
    });
    await drainRenderQueue(failing, { env, db, now: NOW });
    await drainRenderQueue(failing, { env, db, now: NOW });
    await enqueue("fresh", NOW);
    const rows = await readRenderQueue(db, 100);
    expect(rows.map((r) => [r.deliverableId, r.attempts])).toEqual([
      ["fresh", 0],
      ["stuck", 2],
    ]);
    // A batch of one renders the fresh row, not the older failing one.
    const seen: string[] = [];
    await drainRenderQueue(
      fake(async (_ctx, list, consume) => {
        for (const r of list) {
          seen.push(r.deliverableId);
          await consume(r);
        }
        return { rendered: list.length, failed: 0 };
      }),
      { env, db, now: NOW },
      { limit: 1 },
    );
    expect(seen).toEqual(["fresh"]);
    await enqueue("stuck", NOW + 1);
    expect((await readRenderQueue(db, 100))[0]?.attempts).toBe(0);
  });

  it("counts every row of a product whose drain threw", async () => {
    await enqueue("a");
    await drainRenderQueue(
      fake(async () => {
        throw new Error("R2 down");
      }),
      { env, db, now: NOW },
    );
    expect((await readRenderQueue(db, 100))[0]?.attempts).toBe(1);
  });
});

describe("Distribution's materialiser, through the adapters", () => {
  it("renders a queued package into R2 and consumes its row", async () => {
    await seedNpmPackage("npm.sdk", "@acme/sdk");
    await enqueue("npm.sdk");
    const out = await drainRenderQueue(SERVICES, { env, db, now: NOW });
    expect(out).toEqual({ rendered: 1, failed: 0, dropped: 0 });
    expect(await queued()).toEqual([]);
    expect(rendered()).toContain(renderRecordKey("npm", OWNER, "npm.sdk"));
    expect(rendered()).toContain("registry/npm/acme/@acme/sdk/full.json");
  });

  it("renders every package of the owner for a full-render row", async () => {
    await seedNpmPackage("npm.sdk", "@acme/sdk");
    await seedNpmPackage("npm.cli", "@acme/cli");
    await enqueue(RENDER_ALL);
    await drainRenderQueue(SERVICES, { env, db, now: NOW });
    expect(await queued()).toEqual([]);
    for (const id of ["npm.sdk", "npm.cli"])
      expect(rendered()).toContain(renderRecordKey("npm", OWNER, id));
  });

  it("consumes without rendering when no registry host is configured", async () => {
    await seedNpmPackage("npm.sdk", "@acme/sdk");
    await enqueue("npm.sdk");
    delete env.PKG_ORIGIN;
    await drainRenderQueue(SERVICES, { env, db, now: NOW });
    expect(await queued()).toEqual([]);
    expect(rendered()).toEqual([]);
  });

  it("self-checks only owners with package feeds on, re-rendering what is stale", async () => {
    await seedNpmPackage("npm.sdk", "@acme/sdk");
    const ctx = { env, db, now: NOW };
    expect((await selfCheckRenders(SERVICES, ctx, [OWNER])).rerendered).toBe(0);
    await db.run(
      `INSERT INTO dist_registry_owners (product, enabled, version, updated_at, updated_by)
       VALUES (?, 1, 1, ?, 'test')`,
      OWNER,
      NOW,
    );
    expect(await selfCheckRenders(SERVICES, ctx, [OWNER])).toEqual({
      rerendered: 1,
      failures: {},
    });
    expect((await selfCheckRenders(SERVICES, ctx, [OWNER])).rerendered).toBe(0);
    expect((await selfCheckRenders(SERVICES, ctx, [OWNER], 0)).rerendered).toBe(
      0,
    );
  });
});

describe("the triggers", () => {
  async function adminPost(
    path: string,
    exec: { waitUntil(p: Promise<unknown>): void },
  ) {
    const { token, session } = await issueSession(
      env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      // `dispatch` reads the real clock, so the session must be current.
      Math.floor(Date.now() / 1000),
    );
    return dispatch(
      new Request(`${CONSOLE}/manage/api${path}`, {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
      }),
      env,
      db,
      exec,
    );
  }

  it("dispatch drains in waitUntil after a request that enqueued, and not otherwise", async () => {
    await seedNpmPackage("npm.sdk", "@acme/sdk");
    const pending: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    const quiet = await dispatch(
      new Request(`${CONSOLE}/${OWNER}/.well-known/polaris.json`),
      env,
      db,
      exec,
    );
    expect(quiet.status).toBe(200);
    expect(pending).toEqual([]);
    const res = await adminPost(
      `/products/${OWNER}/distribution/feeds/npm/rebuild`,
      exec,
    );
    expect(res.status).toBe(200);
    expect(pending.length).toBe(1);
    await Promise.all(pending);
    expect(await queued()).toEqual([]);
    expect(rendered()).toContain(renderRecordKey("npm", OWNER, "npm.sdk"));
  });

  it("every cron tick drains and self-checks (runRegistryRenders)", async () => {
    await seedNpmPackage("npm.sdk", "@acme/sdk");
    await enqueue("npm.sdk");
    const report: MaintenanceReport = { counts: {}, failures: {} };
    await runRegistryRenders(env, db, NOW, report);
    expect(report.failures).toEqual({});
    expect(report.counts).toMatchObject({
      "registry:rendered": 1,
      "registry:dropped": 0,
      "registry:selfCheck": 0,
    });
    expect(report.timings?.registry).toBeDefined();
    expect(await queued()).toEqual([]);
  });

  it("a render failure is the registry step's: it never fails a connector-poll tick", async () => {
    await seedNpmPackage("npm.sdk", "@acme/sdk");
    await enqueue("npm.sdk");
    vi.spyOn(r2, "put").mockRejectedValue(new Error("R2 down"));
    const report = await handleScheduled(env, db, CONNECTOR_POLL_CRON);
    expect(Object.keys(report.failures)).toEqual([]);
    expect(report.counts).toMatchObject({
      "registry:failed": 1,
      "registry:failures": 1,
    });
    expect(await queued()).toEqual(["npm.sdk"]);
    // The nightly maintenance tick reports it, under the `registry` step.
    await expect(handleScheduled(env, db, MAINTENANCE_CRON)).rejects.toThrow(
      /registry: 1 render\(s\) failed and stay queued/,
    );
  });
});
