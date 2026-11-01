/// <reference types="@cloudflare/workers-types" />
// Launch-control operability: the platform pause, default quota and minimum SDK builds and the
// product relay ceiling are settable and listed through the console routes.
import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/platform/env.js";
import { makeTestDb } from "../../helpers.js";
import "../../../src/mount.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, seedProduct } from "../../seed.js";
import { adminCall } from "../../consoleAdminCall.js";

const GROUP = "platform-admins";
function adminEnv(): Env {
  return Object.assign(makeEnv(new KvMock(), []), {
    ADMIN_SESSION_SECRET: "launch-ops-secret",
    PLATFORM_ADMIN_GROUP: GROUP,
  }) as Env;
}
const call = adminCall;
const why = (r: { body: Record<string, any> }) =>
  r.body.reason ?? r.body.details?.reason ?? r.body.error;

const P = (k: string) => `/api/platform/settings/${k}`;
const GiB = 1024 ** 3;

describe("platform settings page: Cloud Sync and Cloud Connect scalars", () => {
  it("lists the relay pause, the default quotas and the six minimum builds", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    const list = await call(env, db, "/api/platform/settings", {
      method: "GET",
    });
    const keys = (list.body.settings as { key: string }[]).map((s) => s.key);
    for (const k of [
      "cloudConnect.relayPaused",
      "cloudConnect.quota.defaultRelayBytes",
      "cloudSync.writesPaused",
      "cloudSync.quota.defaultBytes",
      ...["swift", "kotlin", "godot", "react", "node", "python"].map(
        (s) => `cloudSync.minSdk.${s}`,
      ),
    ])
      expect(keys, k).toContain(k);
    const m = (list.body.settings as any[]).find(
      (s) => s.key === "cloudSync.minSdk.swift",
    );
    expect(m.kind).toBe("string");
  });

  it("relayPaused: on needs a reason and the typed key; off needs a reason only", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    const k = "cloudConnect.relayPaused";
    const a = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "on", expectedVersion: 0 },
    });
    expect([a.status, why(a)]).toEqual([400, "reason_required"]);
    const b = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "on", expectedVersion: 0, reason: "incident" },
    });
    expect([b.status, why(b)]).toEqual([400, "confirm_required"]);
    const ok = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "on", expectedVersion: 0, reason: "incident", confirm: k },
    });
    expect(ok.status).toBe(200);
    const offNoReason = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "off", expectedVersion: 1 },
    });
    expect([offNoReason.status, why(offNoReason)]).toEqual([
      400,
      "reason_required",
    ]);
    const off = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "off", expectedVersion: 1, reason: "over" },
    });
    expect(off.status).toBe(200);
  });

  it("minimum SDK build: platform admins only, a plain version, version-guarded", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    const k = "cloudSync.minSdk.swift";
    const notPlatform = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "0.10.0", expectedVersion: 0 },
      groups: ["x"],
    });
    expect(notPlatform.status).toBe(403);
    const bad = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "v0.10", expectedVersion: 0 },
    });
    expect(bad.status).toBe(422);
    const ok = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "0.10.0", expectedVersion: 0 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.value).toBe("0.10.0");
    const stale = await call(env, db, P(k), {
      method: "PATCH",
      body: { value: "0.10.1", expectedVersion: 0 },
    });
    expect(stale.status).toBe(409);
    const reset = await call(env, db, P(k), {
      method: "DELETE",
      body: { expectedVersion: 1 },
    });
    expect(reset.status).toBe(200);
    expect(reset.body.value).toBeNull();
  });
});

async function ceilingWorld() {
  const db = makeTestDb();
  const env = adminEnv();
  await seedProduct(db, "djdl");
  const { enable } = await import("../../services/connect/connectFixture.js");
  await enable(db, ["license", "identity", "connect"]);
  return { db, env };
}

describe("product relay ceiling", () => {
  it("is served; raising needs the typed key, lowering a reason only", async () => {
    const { db, env } = await ceilingWorld();
    const k = "cloudConnect.ceiling.relayBytes";
    const path = `/api/products/djdl/settings/${k}`;
    const get = await call(env, db, path, { method: "GET" });
    expect(get.status).toBe(200);
    const eff = await call(env, db, "/api/products/djdl/settings/effective", {
      method: "GET",
    });
    expect(JSON.stringify(eff.body)).toContain(k);
    const lowNoReason = await call(env, db, path, {
      method: "PATCH",
      body: { value: GiB, expectedVersion: 0 },
    });
    expect([lowNoReason.status, why(lowNoReason)]).toEqual([
      422,
      "reason_required",
    ]);
    const low = await call(env, db, path, {
      method: "PATCH",
      body: { value: GiB, expectedVersion: 0, reason: "cost" },
    });
    expect(low.status).toBe(200);
    const raiseNoKey = await call(env, db, path, {
      method: "PATCH",
      body: { value: 600 * GiB, expectedVersion: 1, reason: "more" },
    });
    expect([raiseNoKey.status, why(raiseNoKey)]).toEqual([
      400,
      "confirm_required",
    ]);
    const raise = await call(env, db, path, {
      method: "PATCH",
      body: {
        value: 600 * GiB,
        expectedVersion: 1,
        reason: "more",
        confirm: k,
      },
    });
    expect(raise.status).toBe(200);
  });

  it("a reset that raises needs the typed key, one that lowers needs a reason", async () => {
    const { db, env } = await ceilingWorld();
    const k = "cloudConnect.ceiling.relayBytes";
    const path = `/api/products/djdl/settings/${k}`;
    await call(env, db, path, {
      method: "PATCH",
      body: { value: GiB, expectedVersion: 0, reason: "cost" },
    });
    // The default is higher than the lowered value: a reset raises it.
    const noKey = await call(env, db, path, {
      method: "DELETE",
      body: { expectedVersion: 1, reason: "back" },
    });
    expect([noKey.status, why(noKey)]).toEqual([400, "confirm_required"]);
    const ok = await call(env, db, path, {
      method: "DELETE",
      body: { expectedVersion: 1, reason: "back", confirm: k },
    });
    expect(ok.status).toBe(200);
    const rowVersion = async () =>
      (
        await db.first<{ version: number }>(
          "SELECT version FROM product_settings WHERE product = ? AND key = ?",
          "djdl",
          k,
        )
      )?.version ?? 0;
    const v1 = await rowVersion();
    // Raised above the default, then reset: that lowers, so a reason, no key.
    const up = await call(env, db, path, {
      method: "PATCH",
      body: {
        value: 600 * GiB,
        expectedVersion: v1,
        reason: "more",
        confirm: k,
      },
    });
    expect(up.status).toBe(200);
    const v2 = await rowVersion();
    const noReason = await call(env, db, path, {
      method: "DELETE",
      body: { expectedVersion: v2 },
    });
    expect([noReason.status, why(noReason)]).toEqual([422, "reason_required"]);
    const low = await call(env, db, path, {
      method: "DELETE",
      body: { expectedVersion: v2, reason: "trim" },
    });
    expect(low.status).toBe(200);
  });
});
