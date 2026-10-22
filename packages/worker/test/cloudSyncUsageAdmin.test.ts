/**
 * U-05.19: `GET /manage/api/products/<slug>/sync/usage`. One read of the aggregate row, today's
 * UTC counters and the tier labels and limits; no person, subject, device id or email; RBAC
 * area `sync`; the service's off answer. Admin routes are narrative-only (rule 10).
 */

import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedTier } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import type { Principal } from "../src/core/rbac/can.js";
import { handleAdmin } from "../src/console/index.js";
import { ADMIN_COOKIE, issueSession } from "../src/core/console/session.js";
import { setServices } from "../src/core/products/store.js";
import { serializeServices } from "../src/core/services.js";
import { PRINCIPALS } from "./rbacFixtures.js";

const SYNTHETIC = new Map<string, Principal>();
vi.mock("../src/core/rbac/principal.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/core/rbac/principal.js")>();
  return {
    ...real,
    resolvePrincipal: async (
      ...args: Parameters<typeof real.resolvePrincipal>
    ) => SYNTHETIC.get(args[2].sub) ?? real.resolvePrincipal(...args),
  };
});
const shipOnly = PRINCIPALS.alphaShip;
if (shipOnly) SYNTHETIC.set(shipOnly.memberId, shipOnly);

const GROUP = "platform-admins";
const PATH = "/api/products/djdl/sync/usage";
// 2026-10-22 23:59:59 UTC, and one second later.
const LAST_SECOND = Date.UTC(2026, 9, 22, 23, 59, 59) / 1000;

async function world(syncOn = true) {
  const db: Db = makeTestDb();
  const env: Env = makeEnv(new KvMock(), ["djdl"]);
  env.ADMIN_SESSION_SECRET = "usage-admin-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  await seedProduct(db, "djdl");
  const on = { enabled: true };
  const off = { enabled: false };
  await setServices(
    db,
    "djdl",
    serializeServices({
      services: {
        license: on,
        config: on,
        release: off,
        distribution: off,
        update: off,
        identity: on,
        sync: syncOn ? on : off,
        commerce: off,
      },
    }),
    "manifest",
    NOW,
  );
  await seedTier(db, "djdl", "pro");
  await db.run(
    "UPDATE tiers SET label = ? WHERE product = ? AND id = ?",
    "Pro",
    "djdl",
    "pro",
  );
  const breakdown = {
    byTier: [
      { tierId: "pro", people: 2, bytes: 3000, medianBytes: 1500, over80: 1 },
    ],
    byKind: { settings: 3000, records: 0, files: 0, revisions: 10 },
    byPlatform: [{ platform: "macos", peopleThisWeek: 2, lastSyncAt: NOW }],
  };
  await db.run(
    `INSERT INTO sync_product_usage (product, bytes, users, settings_bytes, revision_bytes, breakdown_json, computed_at)
     VALUES ('djdl', 3000, 2, 3000, 10, ?, ?)`,
    JSON.stringify(breakdown),
    NOW,
  );
  // A subject that must never surface.
  await db.run(
    "INSERT INTO sync_directory (product, subject, bytes, tier_id, updated_at) VALUES ('djdl', 'subj-secret-1', 3000, 'pro', ?)",
    NOW,
  );
  const sessionFor = async (
    claims: { sub: string; groups: string[] },
    at: number,
  ) => {
    const { token } = await issueSession(
      env,
      { ...claims, name: "A", email: "a@example.test" },
      at,
    );
    return token;
  };
  const get = async (token: string, now: number): Promise<Response> =>
    handleAdmin(
      new Request(`https://key.plrs.im/manage${PATH}`, {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }),
      env,
      db,
      PATH,
      { now },
    );
  return { db, env, sessionFor, get };
}

describe("GET sync/usage", () => {
  it("serves the aggregate, today's counters and the tiers, with no identifiers", async () => {
    const w = await world();
    const day = new Date(LAST_SECOND * 1000).toISOString().slice(0, 10);
    await w.db.run(
      "INSERT INTO sync_product_daily (product, day, syncs, conflicts) VALUES ('djdl', ?, 7, 2), ('djdl', '2026-10-21', 99, 99)",
      day,
    );
    const token = await w.sessionFor(
      { sub: "u1", groups: [GROUP] },
      LAST_SECOND,
    );
    const res = await w.get(token, LAST_SECOND);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.enabled).toBe(true);
    expect(body.usage).toMatchObject({
      bytes: 3000,
      people: 2,
      settingsBytes: 3000,
      revisionBytes: 10,
      computedAt: NOW,
    });
    expect(body.usage.breakdown.byTier[0]).toMatchObject({
      tierId: "pro",
      people: 2,
    });
    expect(body.today).toEqual({ day: "2026-10-22", syncs: 7, conflicts: 2 });
    expect(body.tiers).toEqual([{ id: "pro", label: "Pro", bytes: null }]);
    expect(typeof body.defaultBytes).toBe("number");
    for (const banned of [
      "subj-secret-1",
      "a@example.test",
      "subject",
      "deviceId",
      "email",
    ])
      expect(text).not.toContain(banned);
  });

  it("rolls to the next UTC day at midnight", async () => {
    const w = await world();
    await w.db.run(
      "INSERT INTO sync_product_daily (product, day, syncs, conflicts) VALUES ('djdl', '2026-10-22', 7, 2)",
    );
    const token = await w.sessionFor(
      { sub: "u1", groups: [GROUP] },
      LAST_SECOND,
    );
    const body = (await (await w.get(token, LAST_SECOND + 1)).json()) as {
      today: unknown;
    };
    expect(body.today).toEqual({ day: "2026-10-23", syncs: 0, conflicts: 0 });
  });

  it("answers zeros before the first aggregate", async () => {
    const w = await world();
    await w.db.run("DELETE FROM sync_product_usage");
    const token = await w.sessionFor({ sub: "u1", groups: [GROUP] }, NOW);
    const body = (await (await w.get(token, NOW)).json()) as { usage: unknown };
    expect(body.usage).toMatchObject({ bytes: 0, people: 0, computedAt: 0 });
  });

  it("refuses a member who lacks the sync area", async () => {
    const w = await world();
    const p = PRINCIPALS.alphaShip!;
    const token = await w.sessionFor({ sub: p.memberId, groups: [] }, NOW);
    const res = await w.get(token, NOW);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("subj-secret-1");
  });

  it("answers { enabled: false } while Cloud Sync is off", async () => {
    const w = await world(false);
    const token = await w.sessionFor({ sub: "u1", groups: [GROUP] }, NOW);
    const res = await w.get(token, NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});
