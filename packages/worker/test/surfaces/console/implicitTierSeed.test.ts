/**
 * LX-33.7: every License product has its implicit Default tier.
 *
 * It is seeded from the product's licence defaults when the product is created (ST-42), when a
 * repository is linked, and when License is turned on. A resync never touches it; a second seed
 * does nothing. In release N the tier admin API refuses limit edits and deletion on it.
 */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { TEST_RSA_PKCS8 } from "../../releaseFixtures.js";
import { withDefaultHead } from "../../githubHead.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import type { FetchImpl } from "../../../src/services/release/githubApp.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { linkRepo } from "../../../src/services/release/linkRepo.js";
import { resyncRepo } from "../../../src/services/release/resync.js";
import { ingestFor } from "../../../src/core/ingest/pipeline.js";
import { SERVICES } from "../../../src/mount.js";
import {
  freeImplicitTierId,
  seedImplicitTierStatement,
  stmtInsertImplicitTier,
} from "../../../src/core/licensing/store.js";

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
  return env;
}

async function call(
  env: Env,
  db: Db,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    { sub: "u1", name: "Ada", email: "a@x.io", groups: ["admins"] },
    NOW,
  );
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
    [CSRF_HEADER]: session.csrf,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const req = new Request(`https://key.plrs.im/manage${path}`, init);
  return handleAdmin(req, env, db, path, { now: NOW + 60 });
}

const implicitRows = (db: Db, product: string) =>
  db.all<Record<string, unknown>>(
    `SELECT id, label, policy_device_limit, policy_offline_grace_days, profile_id, source, implicit
       FROM tiers WHERE product = ? AND implicit = 1`,
    product,
  );

function contents(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  );
}

const PRODUCT = (limit: number) =>
  JSON.stringify({
    slug: "acme",
    name: "Acme",
    compatMin: "1.0.0",
    compatMax: "9.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: limit,
    tiers: [],
    provisioning: [],
  });

function github(limit: number): FetchImpl {
  const files: Record<string, string> = {
    ".pkey/schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    ".pkey/product.json": PRODUCT(limit),
  };
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files))
        if (url.includes(`/contents/${path}`)) return contents(body);
      return new Response("nf", { status: 404 });
    }
    if (url.includes("/releases?per_page"))
      return new Response("[]", { status: 200 });
    return new Response("nf", { status: 404 });
  });
}

describe("the Default tier is seeded", () => {
  it("at ST-42 create, with the Free starter beside it", async () => {
    const db = makeTestDb();
    const res = await call(envFor(), db, "POST", "/api/products", {
      slug: "tonebox",
    });
    expect(res.status).toBe(201);
    expect(await implicitRows(db, "tonebox")).toEqual([
      {
        id: "default",
        label: "Default",
        policy_device_limit: 5,
        policy_offline_grace_days: 30,
        profile_id: null,
        source: "console",
        implicit: 1,
      },
    ]);
    expect(
      await db.all(
        "SELECT id FROM tiers WHERE product = ? ORDER BY id",
        "tonebox",
      ),
    ).toEqual([{ id: "default" }, { id: "free" }]);
  });

  it('at create with starterTier "none": no explicit tier, the Default tier exists', async () => {
    const db = makeTestDb();
    const res = await call(envFor(), db, "POST", "/api/products", {
      slug: "tonebox",
      starterTier: "none",
    });
    expect(res.status).toBe(201);
    expect(
      await db.all("SELECT id FROM tiers WHERE product = ?", "tonebox"),
    ).toEqual([{ id: "default" }]);
  });

  it("not at create when License is off", async () => {
    const db = makeTestDb();
    const res = await call(envFor(), db, "POST", "/api/products", {
      slug: "tonebox",
      services: ["config"],
    });
    expect(res.status).toBe(201);
    expect(await implicitRows(db, "tonebox")).toEqual([]);
  });

  it("on turning License on, once, and a second enable does nothing", async () => {
    const env = envFor();
    const db = makeTestDb();
    await call(env, db, "POST", "/api/products", {
      slug: "tonebox",
      services: ["config"],
    });
    expect(await implicitRows(db, "tonebox")).toEqual([]);
    const on = await call(env, db, "PATCH", "/api/products/tonebox/services", {
      services: { license: { enabled: true } },
    });
    expect(on.status).toBe(200);
    const first = await implicitRows(db, "tonebox");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: "default",
      policy_device_limit: 5,
      policy_offline_grace_days: 30,
    });
    await call(env, db, "PATCH", "/api/products/tonebox/services", {
      services: { license: { enabled: false } },
    });
    await call(env, db, "PATCH", "/api/products/tonebox/services", {
      services: { license: { enabled: true } },
    });
    expect(await implicitRows(db, "tonebox")).toEqual(first);
  });

  it("at manifest link, from the manifest's defaults, and a resync keeps it", async () => {
    const env = envFor();
    const db = makeTestDb();
    const linked = await linkRepo(
      env,
      db,
      "acme-org/acme-app",
      NOW,
      github(3),
      ingestFor(SERVICES),
    );
    expect(linked.ok).toBe(true);
    const first = await implicitRows(db, "acme");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      policy_device_limit: 3,
      policy_offline_grace_days: 14,
    });
    // The manifest's defaults change; the resync leaves the Default tier as it was.
    await db.run(
      "UPDATE tiers SET modified_at = ? WHERE product = ?",
      7,
      "acme",
    );
    const res = await resyncRepo(
      env,
      db,
      "acme",
      NOW + 60,
      github(8),
      ingestFor(SERVICES),
    );
    expect(res.ok).toBe(true);
    const after = await db.all<Record<string, unknown>>(
      "SELECT id, policy_device_limit, modified_at FROM tiers WHERE product = ? AND implicit = 1",
      "acme",
    );
    expect(after).toEqual([
      { id: first[0]!.id, policy_device_limit: 3, modified_at: 7 },
    ]);
  });

  it("a second seed does nothing, and the id steps past a taken `default`", async () => {
    const db = makeTestDb();
    await call(envFor(), db, "POST", "/api/products", { slug: "tonebox" });
    expect(await seedImplicitTierStatement(db, "tonebox", NOW)).toBeNull();
    const dup = stmtInsertImplicitTier({
      product: "tonebox",
      id: "other",
      deviceLimit: 1,
      offlineDays: 1,
      now: NOW,
    });
    await db.run(dup.sql, ...dup.params);
    expect(await implicitRows(db, "tonebox")).toHaveLength(1);
    expect(freeImplicitTierId(["default"])).toBe("default-2");
    expect(freeImplicitTierId(["default", "default-2"])).toBe("default-3");
  });
});

describe("the tier admin API on the Default tier", () => {
  async function world() {
    const env = envFor();
    const db = makeTestDb();
    await call(env, db, "POST", "/api/products", { slug: "tonebox" });
    return { env, db };
  }

  it("lists it with implicit: true", async () => {
    const { env, db } = await world();
    const res = await call(
      env,
      db,
      "GET",
      "/api/products/tonebox/license/tiers",
    );
    const body = (await res.json()) as {
      tiers: { id: string; implicit: boolean }[];
    };
    expect(body.tiers.map((t) => [t.id, t.implicit])).toEqual([
      ["default", true],
      ["free", false],
    ]);
  });

  it("refuses a limit edit (422) and deletion (422), allows a label edit", async () => {
    const { env, db } = await world();
    for (const patch of [
      { policyDeviceLimit: 9 },
      { policyExpiryDays: null },
      { channels: ["beta"] },
      { minVersion: "1.0.0" },
    ]) {
      const res = await call(
        env,
        db,
        "PATCH",
        "/api/products/tonebox/license/tiers/default",
        patch,
      );
      expect(res.status, JSON.stringify(patch)).toBe(422);
    }
    const del = await call(
      env,
      db,
      "DELETE",
      "/api/products/tonebox/license/tiers/default",
    );
    expect(del.status).toBe(422);
    expect(await implicitRows(db, "tonebox")).toHaveLength(1);
    const label = await call(
      env,
      db,
      "PATCH",
      "/api/products/tonebox/license/tiers/default",
      { label: "Standard" },
    );
    expect(label.status).toBe(200);
  });
});
