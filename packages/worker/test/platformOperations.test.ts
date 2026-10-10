// A-14: self-reported operations (notes/S-13 §7.2 phase 1): the cron's `platform_job_runs`, the
// scripts' `platform_heartbeats`, their retention, the `DELTA_DLQ` metrics-only binding, and the
// platform-admin `GET /manage/api/platform/operations` (`core/ops/operations.ts`).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/platform/env.js";
import type { Db, DbStatement } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import {
  D1_MAX_BOUND_PARAMS,
  ERROR_SUMMARY_MAX,
  JOB_RUN_RETENTION_SECONDS,
  jobRunRows,
  recordJobRun,
  truncateSummary,
  writeHeartbeat,
} from "../src/core/ops/platformOps.js";
import { queueStatus } from "../src/core/ops/operations.js";
import {
  CONNECTOR_POLL_CRON,
  MAINTENANCE_CRON,
  handleScheduled,
  recordTick,
  runScheduledMaintenance,
} from "../src/scheduled.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

function adminEnv(extra: Record<string, unknown> = {}): Env {
  return Object.assign(makeEnv(new KvMock(), []), {
    ADMIN_SESSION_SECRET: ADMIN_SECRET,
    PLATFORM_ADMIN_GROUP: PLATFORM_GROUP,
    ...extra,
  }) as Env;
}

async function call(
  env: Env,
  db: Db,
  path: string,
  opts: { method?: string; groups?: string[] } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const { token, session } = await issueSession(
    env,
    {
      sub: "admin-1",
      name: "Ada Admin",
      email: "admin@example.com",
      groups: opts.groups ?? [PLATFORM_GROUP],
    },
    NOW,
  );
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
  };
  if (method !== "GET") headers[CSRF_HEADER] = session.csrf;
  const req = new Request(`https://key.plrs.im/manage${path}`, {
    method,
    headers,
  }) as unknown as Request;
  const res = await handleAdmin(req, env, db, path.split("?")[0]!, {
    now: NOW,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

async function count(db: Db, sql: string, ...params: unknown[]) {
  const row = await db.first<{ n: number }>(sql, ...(params as never[]));
  return row?.n ?? 0;
}

function fakeQueue(
  metrics: () => Promise<unknown>,
): Queue<unknown> & { sent: number } {
  const q = {
    sent: 0,
    metrics,
    async send() {
      q.sent++;
      throw new Error("must not send");
    },
    async sendBatch() {
      q.sent++;
      throw new Error("must not send");
    },
  };
  return q as unknown as Queue<unknown> & { sent: number };
}

describe("job-run rows", () => {
  it("folds successful per-product steps by family and keeps each failure whole", () => {
    const rows = jobRunRows("run1", 1_000, 1_900, {
      counts: { indexes: 0, "audit:a": 2, "audit:b": 3, "seats:a": 0 },
      failures: { "seats:b": "boom", products: "x".repeat(1000) },
      timings: {
        "audit:a": { startedAt: 1_100, durationMs: 10 },
        "audit:b": { startedAt: 1_050, durationMs: 15 },
        "seats:b": { startedAt: 1_500, durationMs: 7 },
      },
    });
    const summary = rows[0]!;
    expect(summary).toMatchObject({
      step: "*",
      started_at: 1_000,
      duration_ms: 900,
      outcome: "failed",
      items: 6,
      error_summary: "2 step(s) failed",
    });
    const audit = rows.find((r) => r.step === "audit:*")!;
    expect(audit).toMatchObject({
      outcome: "ok",
      items: 2,
      rows_affected: 5,
      duration_ms: 25,
      started_at: 1_050,
    });
    expect(rows.find((r) => r.step === "indexes")?.items).toBe(1);
    expect(rows.find((r) => r.step === "seats:b")).toMatchObject({
      outcome: "failed",
      error_summary: "boom",
      started_at: 1_500,
      duration_ms: 7,
    });
    const long = rows.find((r) => r.step === "products")!;
    expect(long.error_summary!.length).toBe(ERROR_SUMMARY_MAX);
    expect(long.error_summary!.endsWith("…")).toBe(true);
    // Ids sort in insertion order, so a run reads back summary first.
    expect([...rows.map((r) => r.id)].sort()).toEqual(rows.map((r) => r.id));
  });

  it("persists more rows than one statement may bind", async () => {
    const db = makeTestDb();
    const counts: Record<string, number> = {};
    const failures: Record<string, string> = {};
    for (let i = 0; i < 30; i++) failures[`audit:p${i}`] = `fail ${i}`;
    counts.indexes = 0;
    const n = await recordJobRun(db, {
      runId: "r",
      job: "maintenance",
      cron: MAINTENANCE_CRON,
      startedAtMs: 5_000,
      endedAtMs: 6_000,
      report: { counts, failures },
    });
    expect(n).toBe(32);
    expect(await count(db, "SELECT COUNT(*) AS n FROM platform_job_runs")).toBe(
      32,
    );
  });

  it("never binds more than D1's 100 parameters in one statement", async () => {
    const db = makeTestDb();
    const seen: DbStatement[] = [];
    const spy: Db = {
      ...db,
      all: db.all.bind(db),
      first: db.first.bind(db),
      run: db.run.bind(db),
      runChanges: db.runChanges.bind(db),
      batch: async (statements) => {
        seen.push(...statements);
        await db.batch(statements);
      },
    };
    const failures: Record<string, string> = {};
    for (let i = 0; i < 40; i++) failures[`seats:p${i}`] = `fail ${i}`;
    const n = await recordJobRun(spy, {
      runId: "big",
      job: "maintenance",
      cron: MAINTENANCE_CRON,
      startedAtMs: 5_000,
      endedAtMs: 6_000,
      report: { counts: { indexes: 0, products: 0 }, failures },
    });
    expect(n).toBeGreaterThan(30);
    expect(seen.length).toBeGreaterThan(1);
    for (const st of seen) {
      const params = st.params;
      expect(params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      expect((st.sql.match(/\?/g) ?? []).length).toBe(params.length);
    }
    expect(seen.reduce((a, st) => a + st.params.length, 0)).toBe(n * 11);
    expect(await count(db, "SELECT COUNT(*) AS n FROM platform_job_runs")).toBe(
      n,
    );
  });

  it("truncates with an ellipsis only when over the limit", () => {
    expect(truncateSummary("short")).toBe("short");
    expect(truncateSummary("abcdef", 4)).toBe("abc…");
  });
});

describe("the cron records itself", () => {
  it("handleScheduled persists the maintenance tick and the main heartbeat", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const env = { PKEY_RELEASE_TAG: "v1.2.3" } as Env;
    const report = await handleScheduled(env, db, MAINTENANCE_CRON);
    expect(report.failures).toEqual({});
    expect(report.timings?.["audit:acme"]?.durationMs).toBeGreaterThanOrEqual(
      0,
    );
    const summary = await db.first<Record<string, unknown>>(
      "SELECT * FROM platform_job_runs WHERE step = '*'",
    );
    expect(summary).toMatchObject({
      job: "maintenance",
      cron: MAINTENANCE_CRON,
      outcome: "ok",
    });
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM platform_job_runs WHERE step = 'audit:*'",
      ),
    ).toBe(1);
    const beat = await db.first<Record<string, unknown>>(
      "SELECT * FROM platform_heartbeats WHERE script = 'main'",
    );
    expect(beat).toMatchObject({
      version_tag: "v1.2.3",
      outcome: "maintenance:ok",
      backlog_count: null,
    });
  });

  it("records a failed step with its reason, and still throws the aggregate", async () => {
    const db = makeTestDb();
    await db.run("DROP INDEX idx_devices_seat");
    await expect(handleScheduled({} as Env, db)).rejects.toThrow(
      /idx_devices_seat/,
    );
    const failed = await db.first<{ step: string; error_summary: string }>(
      "SELECT step, error_summary FROM platform_job_runs WHERE outcome = 'failed' AND step <> '*'",
    );
    expect(failed?.step).toBe("indexes");
    expect(failed?.error_summary).toMatch(/idx_devices_seat/);
    expect(
      (
        await db.first<{ outcome: string }>(
          "SELECT outcome FROM platform_heartbeats WHERE script = 'main'",
        )
      )?.outcome,
    ).toBe("maintenance:failed");
  });

  it("records the connector poll as its own job", async () => {
    const db = makeTestDb();
    await handleScheduled({} as Env, db, CONNECTOR_POLL_CRON);
    expect(
      (
        await db.first<{ job: string }>(
          "SELECT job FROM platform_job_runs WHERE step = '*'",
        )
      )?.job,
    ).toBe("connectorPoll");
  });

  it("a failure to record is reported as the opsRecord step, never hiding the tick", async () => {
    const db = makeTestDb();
    const broken: Db = {
      ...db,
      all: db.all.bind(db),
      first: db.first.bind(db),
      run: db.run.bind(db),
      runChanges: db.runChanges.bind(db),
      batch: async () => {
        throw new Error("d1 unavailable");
      },
    };
    const report = { counts: { indexes: 0 }, failures: {} };
    await recordTick({} as Env, broken, {
      job: "maintenance",
      cron: null,
      startedAtMs: Date.now(),
      report,
    });
    expect(report.failures).toEqual({ opsRecord: "d1 unavailable" });
    expect(report.counts).toEqual({ indexes: 0 });
  });

  it("prunes job runs and stale heartbeats past 30 days, and nothing newer", async () => {
    const db = makeTestDb();
    const old = (NOW - JOB_RUN_RETENTION_SECONDS - 60) * 1000;
    const fresh = (NOW - 60) * 1000;
    for (const [id, at] of [
      ["old", old],
      ["fresh", fresh],
    ] as const)
      await recordJobRun(db, {
        runId: id,
        job: "maintenance",
        cron: null,
        startedAtMs: at,
        endedAtMs: at + 5,
        report: { counts: { indexes: 0 }, failures: {} },
      });
    await writeHeartbeat(
      db,
      {},
      {
        script: "deltas",
        at: NOW - JOB_RUN_RETENTION_SECONDS - 60,
        outcome: "ack:x",
      },
    );
    await writeHeartbeat(db, {}, { script: "main", at: NOW, outcome: "ok" });
    const report = await runScheduledMaintenance(db, NOW);
    expect(report.failures).toEqual({});
    expect(report.counts.jobRuns).toBe(2);
    expect(report.counts.heartbeats).toBe(1);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM platform_job_runs WHERE run_id = 'fresh'",
      ),
    ).toBe(2);
    expect(
      (
        await db.all<{ script: string }>(
          "SELECT script FROM platform_heartbeats",
        )
      ).map((r) => r.script),
    ).toEqual(["main"]);
    // Idempotent: a second pass on the same clock removes nothing.
    const again = await runScheduledMaintenance(db, NOW);
    expect(again.counts.jobRuns).toBe(0);
    expect(again.counts.heartbeats).toBe(0);
  });
});

describe("heartbeats", () => {
  it("upserts one row per script with validated build identity and the backlog", async () => {
    const db = makeTestDb();
    const env = {
      PKEY_RELEASE_TAG: "not a tag",
      CF_VERSION_METADATA: { id: "ver-1", tag: "", timestamp: "" },
    };
    await writeHeartbeat(db, env, {
      script: "deltas",
      at: 100,
      outcome: "ack:ready",
      backlog: {
        backlogCount: 4,
        backlogBytes: 400,
        oldestMessageTimestamp: new Date(50_000),
      },
    });
    await writeHeartbeat(
      db,
      { PKEY_RELEASE_TAG: "v2.0.0" },
      {
        script: "deltas",
        at: 200,
        outcome: "x".repeat(500),
      },
    );
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM platform_heartbeats",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      script: "deltas",
      at: 200,
      version_tag: "v2.0.0",
      cf_version_id: null,
      backlog_count: null,
    });
    expect((rows[0]!.outcome as string).length).toBe(120);

    await writeHeartbeat(db, env, {
      script: "deltas",
      at: 300,
      outcome: "ack:ready",
      backlog: {
        backlogCount: 4,
        backlogBytes: 400,
        oldestMessageTimestamp: new Date(50_000),
      },
    });
    expect(
      await db.first(
        "SELECT * FROM platform_heartbeats WHERE script = 'deltas'",
      ),
    ).toMatchObject({
      version_tag: null,
      cf_version_id: "ver-1",
      backlog_count: 4,
      backlog_bytes: 400,
      oldest_at: 50,
    });
  });
});

describe("queue metrics", () => {
  it("reads metrics(), and falls back when the binding cannot answer", async () => {
    expect(await queueStatus(undefined)).toMatchObject({
      bound: false,
      ok: null,
    });
    const good = await queueStatus(
      fakeQueue(async () => ({
        backlogCount: 3,
        backlogBytes: 30,
        oldestMessageTimestamp: new Date(9_000),
      })),
    );
    expect(good).toMatchObject({
      bound: true,
      ok: true,
      backlogCount: 3,
      backlogBytes: 30,
      oldestMessageAt: 9,
    });
    const refused = await queueStatus(
      fakeQueue(async () => {
        throw new Error("not supported on this binding");
      }),
    );
    expect(refused).toMatchObject({
      bound: true,
      ok: false,
      backlogCount: null,
      error: "not supported on this binding",
    });
    const old = await queueStatus({ send() {} } as unknown as Queue<unknown>);
    expect(old).toMatchObject({ bound: true, ok: false, backlogCount: null });
    expect(old.error).toMatch(/metrics\(\) is not available/);
  });
});

describe("GET /manage/api/platform/operations", () => {
  it("is platform-admin only and GET only", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    expect(
      (await call(env, db, "/api/platform/operations", { groups: ["other"] }))
        .status,
    ).toBe(403);
    expect(
      (await call(env, db, "/api/platform/operations", { method: "POST" }))
        .status,
    ).toBe(405);
  });

  it("reports probes, queues, jobs, heartbeats, storage, connectors and recent errors", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const dlq = fakeQueue(async () => ({ backlogCount: 2, backlogBytes: 20 }));
    const env = adminEnv({
      DELTA_QUEUE: fakeQueue(async () => ({
        backlogCount: 0,
        backlogBytes: 0,
      })),
      DELTA_DLQ: dlq,
    });
    // A failed connector poll tick and a heartbeat.
    await recordJobRun(db, {
      runId: "poll1",
      job: "connectorPoll",
      cron: CONNECTOR_POLL_CRON,
      startedAtMs: (NOW - 100) * 1000,
      endedAtMs: (NOW - 99) * 1000,
      report: {
        counts: { "poll:acme": 1 },
        failures: { "poll:acme:distribution": "asc: 401" },
      },
    });
    await recordJobRun(db, {
      runId: "maint1",
      job: "maintenance",
      cron: MAINTENANCE_CRON,
      startedAtMs: (NOW - 50) * 1000,
      endedAtMs: (NOW - 49) * 1000,
      report: { counts: { indexes: 0, "audit:acme": 1 }, failures: {} },
    });
    await writeHeartbeat(db, {}, { script: "main", at: NOW, outcome: "ok" });
    // Storage: two committed objects, one gated.
    for (const [key, size, kind, gated] of [
      ["blobs/a", 100, "blob", 0],
      ["gated/b", 250, "bundle", 1],
    ] as const)
      await db.run(
        `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        key,
        key.endsWith("a") ? "a".repeat(64) : "b".repeat(64),
        size,
        kind,
        gated,
        NOW,
        NOW,
      );
    // Connectors: ASC configured with one tracked object and one failed event today.
    await db.run(
      `INSERT INTO dist_connector_settings (product, connector, settings_json, updated_at, updated_by)
       VALUES ('acme', 'asc', '{}', ?, 'admin-1')`,
      NOW,
    );
    await db.run(
      `INSERT INTO dist_connector_objects (product, connector, object_type, object_id, first_seen_at, updated_at, polled_at)
       VALUES ('acme', 'asc', 'builds', 'b1', ?, ?, ?)`,
      NOW - 500,
      NOW - 500,
      NOW - 400,
    );
    await db.run(
      `INSERT INTO dist_connector_events (product, connector, event_id, event_type, outcome, payload_json, received_at)
       VALUES ('acme', 'asc', 'e1', 'x', 'failed', '{}', ?)`,
      NOW - 300,
    );
    // A recent lazy-delta refusal.
    await db.run(
      `INSERT INTO release_lazy_deltas (product, deliverable_id, build_id, from_sha256, to_sha256, method, state, reason, created_at, updated_at)
       VALUES ('acme', 'acme.core', '', ?, ?, 'zstd-patch-from', 'refused', 'over-worker-cap', ?, ?)`,
      "c".repeat(64),
      "d".repeat(64),
      NOW - 3600,
      NOW - 3600,
    );

    const { status, body } = await call(env, db, "/api/platform/operations");
    expect(status).toBe(200);
    expect(body.probes.d1).toMatchObject({ bound: true, ok: true });
    expect(body.probes.kv).toMatchObject({ bound: true, ok: true });
    expect(body.probes.r2).toMatchObject({ bound: false, ok: null });
    expect(body.queues.deltas).toMatchObject({ ok: true, backlogCount: 0 });
    expect(body.queues.deadLetter).toMatchObject({
      ok: true,
      backlogCount: 2,
      backlogBytes: 20,
    });
    expect(dlq.sent).toBe(0);
    expect(body.queues.consumer).toEqual({
      maxBatchSize: 1,
      maxBatchTimeoutSeconds: 5,
      maxRetries: 3,
      maxConcurrency: 1,
    });
    expect(body.jobs.latest.maintenance).toMatchObject({
      runId: "maint1",
      outcome: "ok",
    });
    expect(
      body.jobs.latest.maintenance.steps.map((s: { step: string }) => s.step),
    ).toEqual(["audit:*", "indexes"]);
    expect(body.jobs.latest.connectorPoll.outcome).toBe("failed");
    expect(body.jobs.recent.map((r: { runId: string }) => r.runId)).toEqual([
      "maint1",
      "poll1",
    ]);
    expect(body.recentErrors.jobFailures).toEqual([
      {
        runId: "poll1",
        job: "connectorPoll",
        step: "poll:acme:distribution",
        startedAt: (NOW - 100) * 1000,
        error: "asc: 401",
      },
    ]);
    expect(body.heartbeats).toEqual([
      expect.objectContaining({ script: "main", at: NOW, outcome: "ok" }),
    ]);
    expect(body.storage.d1.sizeBytes).toBeNull();
    expect(body.storage.r2).toMatchObject({ committedBytes: 350, objects: 2 });
    expect(body.storage.r2.byKind).toContainEqual({
      kind: "bundle",
      gated: true,
      bytes: 250,
      objects: 1,
    });
    expect(body.indexes.missing).toEqual([]);
    const asc = body.connectors.items.find(
      (c: { connector: string }) => c.connector === "asc",
    );
    expect(asc).toEqual({
      connector: "asc",
      productsConfigured: 1,
      objectsTracked: 1,
      lastPolledAt: NOW - 400,
      lastEventAt: NOW - 300,
      failedEvents24h: 1,
    });
    expect(
      body.connectors.items.map((c: { connector: string }) => c.connector),
    ).toEqual(expect.arrayContaining(["asc", "play", "ms-store"]));
    expect(body.connectors.lastPollFailure).toMatchObject({
      step: "poll:acme:distribution",
      error: "asc: 401",
    });
    expect(body.connectors.commerce).toEqual({ available: false });
    expect(body.recentErrors.lazyDeltaRefusals).toEqual([
      expect.objectContaining({ reason: "over-worker-cap", count: 1 }),
    ]);
  });

  it("degrades a section that cannot be read instead of failing the page", async () => {
    const db = makeTestDb();
    await db.run("DROP TABLE platform_job_runs");
    const { status, body } = await call(
      adminEnv(),
      db,
      "/api/platform/operations",
    );
    expect(status).toBe(200);
    expect(body.jobs).toBeNull();
    expect(body.connectors).toBeNull();
    expect(body.heartbeats).toEqual([]);
    expect(body.queues.deadLetter).toMatchObject({ bound: false });
  });
});

describe("the DELTA_DLQ binding is used for metrics() only", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory()
        ? sources(p)
        : p.endsWith(".ts")
          ? [p]
          : [];
    });
  }

  it("no source file sends to it, and only env.ts and core/ops/operations.ts name it", () => {
    const naming: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/DELTA_DLQ\s*!?\s*\??\.\s*send/);
      expect(text, file).not.toMatch(/DELTA_DLQ[\s\S]{0,80}sendBatch/);
      if (/DELTA_DLQ/.test(text)) naming.push(relative(SRC, file));
    }
    expect(naming.sort()).toEqual([
      "console/handlers/platform.ts", // the Deployment page's binding-presence list
      "core/ops/operations.ts",
      "platform/env.ts",
      "platformInventory.generated.ts", // ST-02: the generated inventory, data only
    ]);
    // The generated inventory names it once, as a string in a data row, and reads nothing.
    const inventory = readFileSync(
      join(SRC, "platformInventory.generated.ts"),
      "utf8",
    );
    expect(inventory.match(/DELTA_DLQ/g)).toEqual(["DELTA_DLQ"]);
    expect(inventory).toContain('name: "DELTA_DLQ"');
    // Where operations.ts reads it, it hands it straight to `queueStatus` (metrics only).
    const ops = readFileSync(join(SRC, "core", "ops", "operations.ts"), "utf8");
    expect(ops.match(/DELTA_DLQ/g)).toHaveLength(1);
    expect(ops).toMatch(/queueStatus\(env\.DELTA_DLQ\)/);
    const platform = readFileSync(
      join(SRC, "console", "handlers", "platform.ts"),
      "utf8",
    );
    expect(platform.match(/DELTA_DLQ/g)).toEqual(["DELTA_DLQ"]);
  });

  it("binds the dead-letter queue as a producer in every environment of the request Worker", () => {
    const main = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    for (const env of ["prod", "staging", "dev"])
      expect(main).toMatch(
        new RegExp(
          `\\[\\[env\\.${env}\\.queues\\.producers\\]\\]\\nbinding = "DELTA_DLQ"\\nqueue = "pkey-deltas-dlq-${env}"`,
        ),
      );
    // The consumer Worker does not bind it: the DLQ is filled by its `dead_letter_queue` setting.
    const consumer = readFileSync(
      join(HERE, "..", "wrangler.deltas.toml"),
      "utf8",
    );
    expect(consumer).not.toMatch(/DELTA_DLQ/);
  });
});
