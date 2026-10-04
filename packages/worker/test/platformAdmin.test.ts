// A-11 / A-12: the Platform section's admin API (`src/admin/handlers/platform.ts`), deploy
// identity (`src/core/deployIdentity.ts`) and the product-less audit trail (`platform_audit`).

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@polaris-key/protocol";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
  type AdminSession,
} from "../src/admin/session.js";
import { platformAudit } from "../src/admin/audit.js";
import {
  appliedMigrations,
  deployIdentity,
  LATEST_MIGRATION,
} from "../src/core/deployIdentity.js";
import { DISCOVERY_VERSION } from "../src/core/discovery.js";
import {
  runScheduledMaintenance,
  AUDIT_RETENTION_SECONDS,
} from "../src/scheduled.js";
import { listPlatformAudit } from "../src/repo.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const SHA = "0123456789abcdef0123456789abcdef01234567";

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

describe("LATEST_MIGRATION", () => {
  it("is the newest file in migrations/", () => {
    const files = readdirSync(join(HERE, "..", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(LATEST_MIGRATION).toBe(files[files.length - 1]);
  });
});

describe("deployIdentity", () => {
  it("reports validated vars and the version metadata binding", () => {
    const id = deployIdentity(
      adminEnv({
        PKEY_RELEASE_TAG: "v0.9.0",
        PKEY_GIT_SHA: SHA,
        CF_VERSION_METADATA: {
          id: "a1b2c3d4-0000-4000-8000-000000000000",
          tag: "v0.9.0",
          timestamp: "2026-10-03T12:00:00.000Z",
        },
      }),
    );
    expect(id).toEqual({
      releaseTag: "v0.9.0",
      gitSha: SHA,
      cloudflare: {
        id: "a1b2c3d4-0000-4000-8000-000000000000",
        tag: "v0.9.0",
        uploadedAt: "2026-10-03T12:00:00.000Z",
      },
      protocolVersion: PROTOCOL_VERSION,
      discoveryVersion: DISCOVERY_VERSION,
      latestMigration: LATEST_MIGRATION,
    });
  });

  it("never echoes a malformed var, and is null without configuration", () => {
    const id = deployIdentity(
      adminEnv({ PKEY_RELEASE_TAG: "<script>", PKEY_GIT_SHA: "nope" }),
    );
    expect(id.releaseTag).toBeNull();
    expect(id.gitSha).toBeNull();
    expect(id.cloudflare).toBeNull();
  });
});

describe("appliedMigrations", () => {
  it("is null (unknown) when d1_migrations does not exist", async () => {
    expect(await appliedMigrations(makeTestDb())).toBeNull();
  });

  it("reads d1_migrations in id order", async () => {
    const db = makeTestDb();
    // The schema wrangler and @cloudflare/vitest-pool-workers create.
    await db.run(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
    await db.run(
      "INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?), (?, ?)",
      "0001_init.sql",
      "2026-08-01 00:00:00",
      LATEST_MIGRATION,
      "2026-10-03 00:00:00",
    );
    expect(await appliedMigrations(db)).toEqual([
      { name: "0001_init.sql", appliedAt: "2026-08-01 00:00:00" },
      { name: LATEST_MIGRATION, appliedAt: "2026-10-03 00:00:00" },
    ]);
  });
});

describe("/api/platform authorization", () => {
  for (const path of [
    "/api/platform/version",
    "/api/platform/deployment",
    "/api/platform/activity",
  ]) {
    it(`${path}: 403 without the platform admin group`, async () => {
      const r = await call(adminEnv(), makeTestDb(), path, {
        groups: ["someone-else"],
      });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("forbidden");
    });

    it(`${path}: 401 without a session`, async () => {
      const env = adminEnv();
      const req = new Request(
        `https://key.plrs.im/manage${path}`,
      ) as unknown as Request;
      const res = await handleAdmin(req, env, makeTestDb(), path, { now: NOW });
      expect(res.status).toBe(401);
    });

    it(`${path}: GET only (405 on POST)`, async () => {
      const r = await call(adminEnv(), makeTestDb(), path, { method: "POST" });
      expect(r.status).toBe(405);
    });
  }

  it("unknown platform resources are 404", async () => {
    expect(
      (await call(adminEnv(), makeTestDb(), "/api/platform/nope")).status,
    ).toBe(404);
    expect((await call(adminEnv(), makeTestDb(), "/api/platform")).status).toBe(
      404,
    );
    expect(
      (await call(adminEnv(), makeTestDb(), "/api/platform/version/x")).status,
    ).toBe(404);
  });

  it("a non-admin is refused before any resource is resolved", async () => {
    const r = await call(adminEnv(), makeTestDb(), "/api/platform/nope", {
      groups: [],
    });
    expect(r.status).toBe(403);
  });
});

describe("GET /api/platform/version", () => {
  it("answers the build identity and the environment", async () => {
    const r = await call(
      adminEnv({
        PKEY_RELEASE_TAG: "v0.9.0",
        PKEY_GIT_SHA: SHA,
        PKEY_ENVIRONMENT: "prod",
      }),
      makeTestDb(),
      "/api/platform/version",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      releaseTag: "v0.9.0",
      gitSha: SHA,
      cloudflare: null,
      protocolVersion: PROTOCOL_VERSION,
      discoveryVersion: DISCOVERY_VERSION,
      latestMigration: LATEST_MIGRATION,
      environment: "prod",
    });
  });
});

async function seedDeploy(db: Db, id: string, at: number, tag: string) {
  await db.run(
    `INSERT INTO platform_deploys (id, at, environment, tag, git_sha, run_url, scripts,
       latest_migration, cf_version_id, deltas_version_id, smoke)
     VALUES (?, ?, 'prod', ?, ?, ?, ?, ?, ?, NULL, 'success')`,
    id,
    at,
    tag,
    SHA,
    `https://github.com/vladzaharia/polaris-key/actions/runs/${id.split("-")[0]}`,
    JSON.stringify(["polaris-key-deltas-prod", "polaris-key-prod"]),
    LATEST_MIGRATION,
    "cf-version-1",
  );
}

describe("GET /api/platform/deployment", () => {
  it("lists deploys newest first with keyset pagination", async () => {
    const db = makeTestDb();
    await seedDeploy(db, "100-1", NOW - 300, "v0.8.0");
    await seedDeploy(db, "101-1", NOW - 200, "v0.8.1");
    await seedDeploy(db, "102-1", NOW - 100, "v0.9.0");
    const env = adminEnv();

    const first = await call(env, db, "/api/platform/deployment?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.deploys.items.map((d: { tag: string }) => d.tag)).toEqual(
      ["v0.9.0", "v0.8.1"],
    );
    expect(first.body.deploys.items[0]).toEqual({
      id: "102-1",
      at: NOW - 100,
      environment: "prod",
      tag: "v0.9.0",
      gitSha: SHA,
      runUrl: "https://github.com/vladzaharia/polaris-key/actions/runs/102",
      scripts: ["polaris-key-deltas-prod", "polaris-key-prod"],
      latestMigration: LATEST_MIGRATION,
      cloudflareVersionId: "cf-version-1",
      deltasVersionId: null,
      smoke: "success",
    });
    const cursor = first.body.deploys.nextCursor;
    expect(cursor).toEqual({ beforeAt: NOW - 200, beforeId: "101-1" });

    const second = await call(
      env,
      db,
      `/api/platform/deployment?limit=2&beforeAt=${cursor.beforeAt}&beforeId=${cursor.beforeId}`,
    );
    expect(
      second.body.deploys.items.map((d: { tag: string }) => d.tag),
    ).toEqual(["v0.8.0"]);
    expect(second.body.deploys.nextCursor).toBeNull();
  });

  it("reports migrations, indexes and binding presence (never binding ids)", async () => {
    const db = makeTestDb();
    const r = await call(adminEnv(), db, "/api/platform/deployment");
    expect(r.status).toBe(200);
    expect(r.body.current.latestMigration).toBe(LATEST_MIGRATION);
    // No d1_migrations in the Node harness: unknown, not "none applied".
    expect(r.body.migrations).toEqual({
      latest: LATEST_MIGRATION,
      applied: null,
      upToDate: null,
    });
    expect(r.body.indexes).toEqual({ missing: [] });
    expect(r.body.bindings.HOT).toBe(true);
    expect(r.body.bindings.BLOBS).toBe(false);
    expect(r.body.bindings.CF_VERSION_METADATA).toBe(false);
    for (const v of Object.values(r.body.bindings))
      expect(typeof v).toBe("boolean");
    expect(r.body.deploys).toEqual({ items: [], nextCursor: null });
  });

  it("upToDate follows d1_migrations", async () => {
    const db = makeTestDb();
    await db.run(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
    await db.run("INSERT INTO d1_migrations (name) VALUES ('0001_init.sql')");
    const behind = await call(adminEnv(), db, "/api/platform/deployment");
    expect(behind.body.migrations.upToDate).toBe(false);
    await db.run(
      "INSERT INTO d1_migrations (name) VALUES (?)",
      LATEST_MIGRATION,
    );
    const current = await call(adminEnv(), db, "/api/platform/deployment");
    expect(current.body.migrations.upToDate).toBe(true);
    expect(current.body.migrations.applied).toHaveLength(2);
  });
});

describe("platform audit (A-12)", () => {
  const session: AdminSession = {
    sub: "admin-1",
    name: "Ada Admin",
    email: "admin@example.com",
    groups: [PLATFORM_GROUP],
    csrf: "x",
    exp: NOW + 3600,
  };

  it("platformAudit writes a product-less row with before/after JSON", async () => {
    const db = makeTestDb();
    await platformAudit(
      db,
      session,
      NOW,
      "setting.update",
      { kind: "setting", id: "BLOB_GC_GRACE_DAYS" },
      "Set BLOB_GC_GRACE_DAYS",
      { before: 30, after: 14 },
    );
    const [row] = await listPlatformAudit(db);
    expect(row).toMatchObject({
      at: NOW,
      actor_sub: "admin-1",
      actor_name: "Ada Admin",
      actor_email: "admin@example.com",
      action: "setting.update",
      target_kind: "setting",
      target_id: "BLOB_GC_GRACE_DAYS",
      before_json: "30",
      after_json: "14",
    });
    expect(row!.id).toMatch(/^paud_/);
  });

  it("GET /api/platform/activity pages newest first and parses before/after", async () => {
    const db = makeTestDb();
    for (let i = 0; i < 3; i++)
      await platformAudit(db, session, NOW + i, `a.${i}`, null, `s${i}`, {
        after: { n: i },
      });
    const env = adminEnv();
    const first = await call(env, db, "/api/platform/activity?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.items.map((x: { action: string }) => x.action)).toEqual([
      "a.2",
      "a.1",
    ]);
    expect(first.body.items[0]).toMatchObject({
      at: NOW + 2,
      actor: { sub: "admin-1", name: "Ada Admin", email: "admin@example.com" },
      action: "a.2",
      target: null,
      summary: "s2",
      before: null,
      after: { n: 2 },
    });
    const c = first.body.nextCursor;
    const second = await call(
      env,
      db,
      `/api/platform/activity?limit=2&beforeAt=${c.beforeAt}&beforeId=${c.beforeId}`,
    );
    expect(second.body.items.map((x: { action: string }) => x.action)).toEqual([
      "a.0",
    ]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("the nightly sweep prunes platform_audit past the audit retention", async () => {
    const db = makeTestDb();
    await platformAudit(
      db,
      session,
      NOW - AUDIT_RETENTION_SECONDS - 10,
      "old",
      null,
      "old",
    );
    await platformAudit(db, session, NOW - 10, "new", null, "new");
    const report = await runScheduledMaintenance(db, NOW);
    expect(report.counts.platformAudit).toBe(1);
    expect((await listPlatformAudit(db)).map((r) => r.action)).toEqual(["new"]);
    // Idempotent: a second tick removes nothing.
    expect((await runScheduledMaintenance(db, NOW)).counts.platformAudit).toBe(
      0,
    );
  });
});
