// P0-49: the data-migration runner. A job dry-runs, reports, applies, resumes after a kill and
// re-applies as a no-op; every call is audited; nothing but the admin route starts a run.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { seededWorld } from "./identityCardHarness.js";
import { SYSTEM_ACTORS } from "../src/core/audit.js";
import {
  PLATFORM_UNIT,
  type MigrationContext,
  type MigrationJob,
} from "../src/core/migrate/job.js";
import {
  MIGRATION_LEASE_SECONDS,
  MIGRATION_REPORT_MAX_AGE_SECONDS,
  apply,
  down,
  dryRun,
  getRun,
} from "../src/core/migrate/runner.js";
import {
  PLATFORM_ENV_CONNECTION_ID,
  downPlatformConnectionSeed,
  platformConnectionSeedJob,
} from "../src/services/identity/connections/seed.js";
import { resolveConnection } from "../src/core/oidc/connections.js";
import { migrationJobs } from "../src/core/contributions.js";
import "../src/mount.js";

const ACTOR = { sub: "op", name: "Op", email: null };

/** A job over three units whose state is a map, with a switch to kill one unit once. */
function fakeJob() {
  const state = new Map<string, number>([
    ["alpha", 0],
    ["beta", 0],
    ["gamma", 0],
  ]);
  const calls: string[] = [];
  const kill = { unit: null as string | null };
  const job: MigrationJob = {
    id: "test.fake",
    summary: "fake",
    units: async () => [...state.keys()],
    plan: async (_c, u) => ({ changes: state.get(u) === 0 ? 1 : 0 }),
    apply: async (_c, u) => {
      calls.push(u);
      if (kill.unit === u) {
        kill.unit = null;
        throw new Error("killed");
      }
      const changed = state.get(u) === 0 ? 1 : 0;
      state.set(u, 1);
      return changed;
    },
    down: async (_c, u) => {
      const changed = state.get(u) === 1 ? 1 : 0;
      state.set(u, 0);
      return changed;
    },
  };
  return { job, state, calls, kill };
}

async function setup(now = NOW) {
  const db = await makeTestDb();
  const ctx = (at = now): MigrationContext => ({
    env: makeEnv(new KvMock(), []),
    db,
    now: at,
  });
  return { db, ctx };
}

async function auditActions(db: Awaited<ReturnType<typeof makeTestDb>>) {
  return (
    await db.all<{ action: string }>(
      "SELECT action FROM platform_audit WHERE action LIKE 'migration.%' ORDER BY at, rowid",
    )
  ).map((r) => r.action);
}

describe("migration runner", () => {
  it("dry-runs writing nothing to the data, then applies, resumes and re-applies as a no-op", async () => {
    const { db, ctx } = await setup();
    const { job, state, calls, kill } = fakeJob();

    const report = await dryRun(ctx(), job, ACTOR);
    expect(report).toMatchObject({
      mode: "dry-run",
      status: "reported",
      changes: 3,
    });
    expect([...state.values()]).toEqual([0, 0, 0]);
    expect(calls).toEqual([]);

    // The first call applies one unit (its limit), the second is killed mid-unit.
    const first = await apply(ctx(), job, ACTOR, report.id, { limit: 1 });
    expect(first.ok && first.run.remaining).toBe(2);
    kill.unit = "gamma";
    const killed = await apply(ctx(NOW + 1), job, ACTOR, report.id);
    expect(killed.ok && killed.run.status).toBe("failed");
    expect(killed.ok && killed.run.remaining).toBe(1);

    // Resume: only the unfinished unit runs; the finished ones are skipped.
    calls.length = 0;
    const resumed = await apply(ctx(NOW + 2), job, ACTOR, report.id);
    expect(calls).toEqual(["gamma"]);
    expect(resumed.ok && resumed.run.status).toBe("applied");
    expect([...state.values()]).toEqual([1, 1, 1]);
    expect(resumed.ok && resumed.run.changes).toBe(3);

    // Applying the same report again is a no-op: nothing is called, nothing is audited anew.
    calls.length = 0;
    const before = (await auditActions(db)).length;
    const again = await apply(ctx(NOW + 3), job, ACTOR, report.id);
    expect(again.ok && again.noop).toBe(true);
    expect(calls).toEqual([]);
    expect((await auditActions(db)).length).toBe(before);

    // A fresh dry run now reports zero diffs: the switch to release N+1 may go.
    expect((await dryRun(ctx(NOW + 4), job, ACTOR)).changes).toBe(0);
  });

  it("refuses an apply with no report, another job's report or a report with a failed unit", async () => {
    const { ctx } = await setup();
    const { job } = fakeJob();
    const none = await apply(ctx(), job, ACTOR, "mig_nope");
    expect(none).toEqual({ ok: false, reason: "unknown_report" });

    const broken: MigrationJob = {
      ...job,
      plan: async () => {
        throw new Error("boom");
      },
    };
    const report = await dryRun(ctx(), broken, ACTOR);
    expect(report.units.every((u) => u.status === "failed")).toBe(true);
    expect(await apply(ctx(), broken, ACTOR, report.id)).toEqual({
      ok: false,
      reason: "report_incomplete",
    });
    expect(
      await apply(ctx(), { ...job, id: "test.other" }, ACTOR, report.id),
    ).toEqual({ ok: false, reason: "unknown_report" });
  });

  it("holds a lease while a call runs and takes a lapsed one over", async () => {
    const { db, ctx } = await setup();
    const { job } = fakeJob();
    const report = await dryRun(ctx(), job, ACTOR);
    const first = await apply(ctx(), job, ACTOR, report.id, { limit: 1 });
    expect(first.ok).toBe(true);
    // Simulate a killed call: the run still holds its lease.
    const run = (first.ok && first.run.id) as string;
    await db.run(
      "UPDATE data_migration_runs SET status = 'running', lease_until = ? WHERE id = ?",
      NOW + MIGRATION_LEASE_SECONDS,
      run,
    );
    expect(await apply(ctx(NOW + 10), job, ACTOR, report.id)).toEqual({
      ok: false,
      reason: "busy",
    });
    const taken = await apply(
      ctx(NOW + MIGRATION_LEASE_SECONDS + 1),
      job,
      ACTOR,
      report.id,
    );
    expect(taken.ok && taken.run.status).toBe("applied");
  });

  it("has a down path: it undoes the finished units, resumes, and ends the apply", async () => {
    const { db, ctx } = await setup();
    const { job, state } = fakeJob();
    const report = await dryRun(ctx(), job, ACTOR);
    const applied = await apply(ctx(), job, ACTOR, report.id);
    const applyId = (applied.ok && applied.run.id) as string;
    expect([...state.values()]).toEqual([1, 1, 1]);

    const part = await down(ctx(NOW + 1), job, ACTOR, applyId, { limit: 2 });
    expect(part.ok && part.run.remaining).toBe(1);
    const done = await down(ctx(NOW + 2), job, ACTOR, applyId);
    expect(done.ok && done.run.status).toBe("reverted");
    expect([...state.values()]).toEqual([0, 0, 0]);
    expect((await getRun(db, applyId))?.status).toBe("reverted");

    const noop = await down(ctx(NOW + 3), job, ACTOR, applyId);
    expect(noop.ok && noop.noop).toBe(true);
    // The reverted apply cannot be replayed from the old report.
    expect(await apply(ctx(NOW + 4), job, ACTOR, report.id)).toEqual({
      ok: false,
      reason: "reverted",
    });
    expect(await down(ctx(), job, ACTOR, "mig_nope")).toEqual({
      ok: false,
      reason: "unknown_apply",
    });
  });

  it("audits every dry run, apply call and down call through the platform audit writer", async () => {
    const { db, ctx } = await setup();
    const { job } = fakeJob();
    const report = await dryRun(ctx(), job, SYSTEM_ACTORS.platform);
    const a = await apply(ctx(NOW + 1), job, ACTOR, report.id);
    await down(ctx(NOW + 2), job, ACTOR, (a.ok && a.run.id) as string);
    expect(await auditActions(db)).toEqual([
      "migration.dry-run",
      "migration.apply",
      "migration.down",
    ]);
    const row = await db.first<{ actor_sub: string; target_id: string }>(
      "SELECT actor_sub, target_id FROM platform_audit WHERE action = 'migration.apply'",
    );
    expect(row).toEqual({ actor_sub: "op", target_id: "test.fake" });
  });
});

describe("migration runner: races, leases and exclusion", () => {
  it("two parallel first applies make one run; the other is busy", async () => {
    const { db, ctx } = await setup();
    const { job } = fakeJob();
    const report = await dryRun(ctx(), job, ACTOR);
    const [a, b] = await Promise.all([
      apply(ctx(NOW + 1), job, ACTOR, report.id),
      apply(ctx(NOW + 1), job, ACTOR, report.id),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser).toEqual({ ok: false, reason: "busy" });
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM data_migration_runs WHERE mode = 'apply'",
    );
    expect(n?.n).toBe(1);
  });

  it("parallel first downs make one run", async () => {
    const { db, ctx } = await setup();
    const { job } = fakeJob();
    const report = await dryRun(ctx(), job, ACTOR);
    const applied = await apply(ctx(), job, ACTOR, report.id);
    const id = (applied.ok && applied.run.id) as string;
    const rs = await Promise.all([
      down(ctx(NOW + 1), job, ACTOR, id),
      down(ctx(NOW + 1), job, ACTOR, id),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM data_migration_runs WHERE mode = 'down'",
    );
    expect(n?.n).toBe(1);
  });

  it("a down after a no-op apply undoes nothing", async () => {
    const { ctx } = await setup();
    const { job, state } = fakeJob();
    for (const k of state.keys()) state.set(k, 1); // already migrated before the apply
    const report = await dryRun(ctx(), job, ACTOR);
    expect(report.changes).toBe(0);
    const applied = await apply(ctx(), job, ACTOR, report.id);
    expect(applied.ok && applied.run.status).toBe("applied");
    const undone = await down(
      ctx(NOW + 1),
      job,
      ACTOR,
      (applied.ok && applied.run.id) as string,
    );
    expect(undone).toEqual({ ok: false, reason: "nothing_applied" });
    expect([...state.values()]).toEqual([1, 1, 1]);
  });

  it("a call whose lease lapsed and was taken over writes nothing more", async () => {
    const { db, ctx } = await setup();
    const { job, state } = fakeJob();
    const report = await dryRun(ctx(), job, ACTOR);
    let inner: unknown = null;
    const wrapped: MigrationJob = {
      ...job,
      apply: async (c, u) => {
        if (u === "beta" && inner === null) {
          // The first call stalls; its lease lapses and a second call takes the run over.
          inner = await apply(
            ctx(NOW + MIGRATION_LEASE_SECONDS + 5),
            wrapped,
            ACTOR,
            report.id,
          );
        }
        return job.apply(c, u);
      },
    };
    const outer = await apply(ctx(), wrapped, ACTOR, report.id);
    expect(outer).toEqual({ ok: false, reason: "lease_lost" });
    const takeover = inner as Awaited<ReturnType<typeof apply>>;
    expect(takeover.ok && takeover.run.status).toBe("applied");
    const run = await db.first<{ status: string; changes: number }>(
      "SELECT status, changes FROM data_migration_runs WHERE mode = 'apply'",
    );
    expect(run).toEqual({ status: "applied", changes: 3 });
    expect([...state.values()]).toEqual([1, 1, 1]);
    const audits = (await auditActions(db)).filter(
      (a) => a === "migration.apply",
    );
    expect(audits).toHaveLength(1);
  });

  it("apply and down exclude each other, in both orders", async () => {
    const { ctx } = await setup();
    const { job } = fakeJob();
    const report = await dryRun(ctx(), job, ACTOR);

    // A down while an apply holds its lease is busy.
    let during: unknown = null;
    const probe: MigrationJob = {
      ...job,
      apply: async (c, u) => {
        if (u === "alpha") {
          const row = await c.db.first<{ id: string }>(
            "SELECT id FROM data_migration_runs WHERE mode = 'apply'",
          );
          during = await down(c, probe, ACTOR, row!.id);
        }
        return job.apply(c, u);
      },
    };
    const first = await apply(ctx(NOW + 1), probe, ACTOR, report.id, {
      limit: 1,
    });
    expect(during).toEqual({ ok: false, reason: "busy" });
    expect(first.ok && first.run.remaining).toBe(2);

    // Once a down exists for a part-applied run, the apply is refused.
    const applyId = (first.ok && first.run.id) as string;
    const started = await down(ctx(NOW + 2), job, ACTOR, applyId, { limit: 0 });
    expect(started.ok && started.run.remaining).toBe(1);
    expect(await apply(ctx(NOW + 3), job, ACTOR, report.id)).toEqual({
      ok: false,
      reason: "reverting",
    });
  });

  it("refuses to start an apply from a report older than 24 hours, but resumes one", async () => {
    const { ctx } = await setup();
    const { job } = fakeJob();
    const report = await dryRun(ctx(), job, ACTOR);
    const late = NOW + MIGRATION_REPORT_MAX_AGE_SECONDS + 1;
    expect(await apply(ctx(late), job, ACTOR, report.id)).toEqual({
      ok: false,
      reason: "report_stale",
    });
    await apply(ctx(NOW + 1), job, ACTOR, report.id, { limit: 1 });
    const resumed = await apply(ctx(late), job, ACTOR, report.id);
    expect(resumed.ok && resumed.run.status).toBe("applied");
  });
});

describe("identity.seed-platform-connection as a runner job", () => {
  it("is contributed by Identity and runs dry run, apply, no-op re-apply and down", async () => {
    expect(migrationJobs().map((j) => j.id)).toContain(
      platformConnectionSeedJob.id,
    );
    const w = await seededWorld();
    w.env.PLATFORM_OIDC_ISSUER = "https://id.plrs.example";
    w.env.PLATFORM_OIDC_CLIENT_ID = "platform-client";
    w.env.PLATFORM_OIDC_CLIENT_SECRET = "platform-SENTINEL";
    const ctx = { env: w.env, db: w.db, now: NOW };

    const report = await dryRun(ctx, platformConnectionSeedJob, ACTOR);
    expect(report.changes).toBe(1);
    expect(report.units.map((u) => u.unit)).toEqual([PLATFORM_UNIT]);
    expect(JSON.stringify(report)).not.toContain("SENTINEL");
    expect(
      await resolveConnection(w.db, PLATFORM_ENV_CONNECTION_ID),
    ).toBeNull();

    const applied = await apply(
      ctx,
      platformConnectionSeedJob,
      ACTOR,
      report.id,
    );
    expect(applied.ok && applied.run.status).toBe("applied");
    expect(
      await resolveConnection(w.db, PLATFORM_ENV_CONNECTION_ID),
    ).not.toBeNull();
    const again = await apply(ctx, platformConnectionSeedJob, ACTOR, report.id);
    expect(again.ok && again.noop).toBe(true);
    expect((await dryRun(ctx, platformConnectionSeedJob, ACTOR)).changes).toBe(
      0,
    );

    const undone = await down(
      ctx,
      platformConnectionSeedJob,
      ACTOR,
      (applied.ok && applied.run.id) as string,
    );
    expect(undone.ok && undone.run.status).toBe("reverted");
    expect(
      await resolveConnection(w.db, PLATFORM_ENV_CONNECTION_ID),
    ).toBeNull();
  });
});

describe("the seed's down path", () => {
  it("leaves an operator-owned connection and its domains in place", async () => {
    const w = await seededWorld();
    await w.db.run(
      `INSERT INTO identity_connections (id, scope, label, issuer, client_id, audience, status,
         source, created_at, modified_at)
       VALUES (?, 'platform', 'Mine', 'https://mine.idp.example', 'c', 'both', 'active', 'console', ?, ?)`,
      PLATFORM_ENV_CONNECTION_ID,
      NOW,
      NOW,
    );
    await w.db.run(
      "INSERT INTO identity_connection_domains (connection_id, scope, domain, token, verified_at) VALUES (?, 'platform', 'example.com', 't', ?)",
      PLATFORM_ENV_CONNECTION_ID,
      NOW,
    );
    expect(await downPlatformConnectionSeed(w.db)).toBe(0);
    expect(
      await resolveConnection(w.db, PLATFORM_ENV_CONNECTION_ID),
    ).not.toBeNull();
    const d = await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM identity_connection_domains WHERE connection_id = ?",
      PLATFORM_ENV_CONNECTION_ID,
    );
    expect(d?.n).toBe(1);
  });

  it("a down after a no-op apply keeps the row the apply did not create", async () => {
    const w = await seededWorld();
    w.env.PLATFORM_OIDC_ISSUER = "https://id.plrs.example";
    w.env.PLATFORM_OIDC_CLIENT_ID = "platform-client";
    const ctx = { env: w.env, db: w.db, now: NOW };
    const first = await apply(
      ctx,
      platformConnectionSeedJob,
      ACTOR,
      (await dryRun(ctx, platformConnectionSeedJob, ACTOR)).id,
    );
    expect(first.ok).toBe(true); // the row now exists
    const report = await dryRun(ctx, platformConnectionSeedJob, ACTOR);
    expect(report.changes).toBe(0);
    const noop = await apply(ctx, platformConnectionSeedJob, ACTOR, report.id);
    const r = await down(
      ctx,
      platformConnectionSeedJob,
      ACTOR,
      (noop.ok && noop.run.id) as string,
    );
    expect(r).toEqual({ ok: false, reason: "nothing_applied" });
    expect(
      await resolveConnection(w.db, PLATFORM_ENV_CONNECTION_ID),
    ).not.toBeNull();
  });
});

describe("nothing starts a run but the admin route", () => {
  it("keeps the runner out of the scheduled tick, the deploy path and every other module", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory()
          ? walk(p)
          : p.endsWith(".ts")
            ? [p]
            : [];
      });
    const importers = walk(src)
      .filter((f) => /migrate\/runner\.js"/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(src.length + 1));
    expect(importers).toEqual(["console/handlers/migrations.ts"]);
  });
});

describe("the admin route", () => {
  async function route(
    env: Env,
    db: Db,
    method: string,
    path: string,
    body?: unknown,
    stepUp = true,
  ) {
    const { token, session } = await issueSession(
      env,
      {
        sub: "admin-1",
        name: "Ada",
        email: "ada@example.com",
        groups: ["platform-admins"],
        ...(stepUp ? { stepUp: true, authTime: NOW } : {}),
      },
      NOW,
    );
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      "content-type": "application/json",
    };
    if (method !== "GET") headers[CSRF_HEADER] = session.csrf;
    const res = await handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      db,
      path,
      { now: NOW },
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  }

  it("lists the jobs, dry-runs, then applies only with a step-up and a report, and undoes", async () => {
    const w = await seededWorld();
    const env = Object.assign(w.env, {
      ADMIN_SESSION_SECRET: "test-admin-session-secret",
      PLATFORM_ADMIN_GROUP: "platform-admins",
      PLATFORM_OIDC_ISSUER: "https://id.plrs.example",
      PLATFORM_OIDC_CLIENT_ID: "platform-client",
    }) as Env;
    const job = platformConnectionSeedJob.id;

    const list = await route(env, w.db, "GET", "/api/platform/migrations");
    expect(list.body.jobs.map((j: { id: string }) => j.id)).toContain(job);

    const dry = await route(
      env,
      w.db,
      "POST",
      "/api/platform/migrations/dry-run",
      { job },
    );
    expect(dry.status).toBe(200);
    const report = dry.body.run.id as string;

    const body = { job, report };
    const noStepUp = await route(
      env,
      w.db,
      "POST",
      "/api/platform/migrations/apply",
      body,
      false,
    );
    expect(noStepUp.status).toBe(403);
    expect(
      (
        await route(env, w.db, "POST", "/api/platform/migrations/apply", {
          job,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await route(env, w.db, "POST", "/api/platform/migrations/apply", {
          job,
          report: "mig_x",
        })
      ).status,
    ).toBe(404);

    const applied = await route(
      env,
      w.db,
      "POST",
      "/api/platform/migrations/apply",
      body,
    );
    expect(applied.body.run.status).toBe("applied");
    expect(
      (await route(env, w.db, "POST", "/api/platform/migrations/apply", body))
        .body.noop,
    ).toBe(true);
    const got = await route(
      env,
      w.db,
      "GET",
      `/api/platform/migrations/runs/${report}`,
    );
    expect(got.body.run.mode).toBe("dry-run");

    const undone = await route(
      env,
      w.db,
      "POST",
      "/api/platform/migrations/down",
      {
        job,
        run: applied.body.run.id,
      },
    );
    expect(undone.body.run.status).toBe("reverted");
  });

  it("reports Core's delegated override migration but never applies or undoes it", async () => {
    const w = await seededWorld();
    const env = Object.assign(w.env, {
      ADMIN_SESSION_SECRET: "test-admin-session-secret",
      PLATFORM_ADMIN_GROUP: "platform-admins",
      PLATFORM_OIDC_ISSUER: "https://id.plrs.example",
      PLATFORM_OIDC_CLIENT_ID: "platform-client",
    }) as Env;
    const job = "core.licence-override-migration";
    const dry = await route(
      env,
      w.db,
      "POST",
      "/api/platform/migrations/dry-run",
      { job },
    );
    expect(dry.status).toBe(200);
    expect(dry.body.run.status).toBe("reported");
    for (const verb of ["apply", "down"]) {
      const r = await route(
        env,
        w.db,
        "POST",
        `/api/platform/migrations/${verb}`,
        { job, report: dry.body.run.id, run: dry.body.run.id },
      );
      expect(r.status, verb).toBe(409);
      expect(r.body.code ?? r.body.error?.code, verb).toBe("delegated");
    }
    // Nothing ran: no apply row exists for the report.
    expect(
      await w.db.first(
        "SELECT id FROM data_migration_runs WHERE source_id = ?",
        dry.body.run.id,
      ),
    ).toBeNull();
  });
});
