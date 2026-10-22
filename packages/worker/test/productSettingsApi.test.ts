// The generic product settings routes (ST-05b, S-18 §4.7): one family serves every product setting
// the registry lists, whether its value is a row, a column or a rich store. These cover what the
// bespoke routes it replaced did not share: the widened reads, the refusals, and the adapters.

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../src/core/console/session.js";
import { SETTINGS } from "../src/mount.js";
import { servedSettings } from "../src/console/handlers/productSettings.js";
import { consoleTestSession } from "./consoleSessionHelper.js";

const GROUP = "admins";

describe("the generic product settings routes", () => {
  let db: SqliteDb;
  let env: Env;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = GROUP;
    await seedProduct(db, "djdl");
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const { token, session } = await consoleTestSession(
      env,
      db,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [GROUP] },
      NOW,
    );
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleAdmin(mkReq(method, headers, body), env, db, path, {
      now: NOW,
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }
  const KEY = (key: string) => `/api/products/djdl/settings/${key}`;

  it("lists the column-backed and rich keys beside the row-backed ones, and never a secret", async () => {
    const { status, json } = await call(
      "GET",
      "/api/products/djdl/settings/effective",
    );
    expect(status).toBe(200);
    const keys = (json.settings as { key: string }[]).map((s) => s.key);
    for (const key of [
      "licensing.anchorPolicy",
      "license.fingerprint",
      "core.trustPolicy",
      "update.metadataAccess",
      "update.operatorPolicy",
      "release.compatWindow",
      "distribution.access",
    ])
      expect(keys, key).toContain(key);
    // Nothing the registry marks a secret is served, and nothing pending.
    for (const d of SETTINGS.entries)
      if (d.scope === "product" && (d.sensitivity === "secret" || d.pending))
        expect(keys, d.key).not.toContain(d.key);
    expect(keys.sort()).toEqual(
      servedSettings()
        .map((d) => d.key)
        .sort(),
    );
  });

  it("reads one key with its version, owner and what an unset policy reads as", async () => {
    const { status, json } = await call("GET", KEY("core.trustPolicy"));
    expect(status).toBe(200);
    expect(json.setting).toMatchObject({
      key: "core.trustPolicy",
      ownership: "operator",
      source: "default",
      version: 0,
      // The default policy, not null: the readers enforce it.
      value: { mint: "basic", enforce: false },
    });
  });

  it("answers 404 unknown_setting for a key it does not serve", async () => {
    for (const key of ["license.tiers", "no.such.key"]) {
      const get = await call("GET", KEY(key));
      expect(get.status, key).toBe(404);
      expect(get.json.reason).toBe("unknown_setting");
      const patch = await call("PATCH", KEY(key), {
        value: 1,
        expectedVersion: 0,
      });
      expect(patch.status, key).toBe(404);
    }
  });

  it("serves a manifest-only key read-only: the write is refused, not routed around", async () => {
    const get = await call("GET", KEY("release.github"));
    expect(get.status).toBe(200);
    expect(get.json.setting).toMatchObject({ ownership: "manifest" });
    // Readable, but a column key with no adapter is written where the console owns it: the
    // services map has coherence rules only its own route checks.
    for (const key of ["core.adminGroup", "core.services", "core.name"]) {
      const patch = await call("PATCH", KEY(key), {
        value: key === "core.services" ? {} : "x",
        expectedVersion: 0,
        reason: "a reason",
      });
      expect(patch.status, key).toBe(409);
      expect(patch.json.reason, key).toBe("no_writer");
      const del = await call("DELETE", KEY(key), { expectedVersion: 0 });
      expect(del.status, key).toBe(409);
    }
  });

  it("asks a critical key's adapter, not the caller, for its audit action", async () => {
    const res = await call("PATCH", KEY("update.metadataAccess"), {
      value: "licensed",
      expectedVersion: 0,
    });
    // No release configuration: the adapter refuses with a 422 naming the field, writing nothing.
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ fields: ["metadataAccess"] });
    const read = await call("GET", KEY("update.metadataAccess"));
    expect(read.json.setting).toMatchObject({
      blocked: "This product has no release configuration yet",
    });
  });

  it("writes a rich key's rows through the guard, and refuses a stale version", async () => {
    const ok = await call("PATCH", KEY("distribution.access"), {
      value: { app: { mode: "licensed" } },
      expectedVersion: 0,
    });
    expect(ok.status).toBe(200);
    const row = await db.first<{ mode: string; source: string }>(
      "SELECT mode, source FROM dist_access WHERE product = 'djdl' AND deliverable_id = 'app'",
    );
    expect(row).toEqual({ mode: "licensed", source: "admin" });
    // The audit row carries the adapter's action.
    const audit = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = 'djdl'",
    );
    expect(audit.map((a) => a.action)).toContain("distribution.access.update");
    // An unlinked product keeps no claim row, so its version stays 0; a wrong one is still named.
    const bad = await call("PATCH", KEY("distribution.access"), {
      value: { app: { mode: "public" } },
      expectedVersion: -1,
    });
    expect(bad.status).toBe(422);
  });
});
