// ST-16: the live product defaults on Platform → Settings: the rows the page lists, the reach
// (fan-out) count a confirm dialog shows, the L2 write, and the clamped display (set and effective).

import { describe, expect, it } from "vitest";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { resolveProductSetting } from "../src/core/settings/resolve.js";
import { coreSettingsRegistry } from "../src/core/settings/platformRead.js";
import { SETTINGS } from "../src/mount.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

const GROUP = "platform-admins";
const env = Object.assign(makeEnv(new KvMock(), []), {
  ADMIN_SESSION_SECRET: "test-admin-session-secret",
  PLATFORM_ADMIN_GROUP: GROUP,
}) as Env;

async function call(
  db: Db,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const { token, session } = await issueSession(
    env,
    { sub: "admin-1", name: "Ada", email: "a@example.com", groups: [GROUP] },
    NOW,
  );
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
  };
  if (method !== "GET") headers[CSRF_HEADER] = session.csrf;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    env,
    db,
    path.split("?")[0]!,
    { now: NOW },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

async function own(db: Db, product: string, key: string, value: unknown) {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES (?, ?, ?, 'console', 1, ?, 'seed')`,
    product,
    key,
    JSON.stringify(value),
    NOW,
  );
}

const KEY_LIMIT = "identity.keyEntry.limit";
const MEDIA = "assets.quota.mediaBytes";

async function fleet(): Promise<Db> {
  const db = makeTestDb();
  for (const slug of ["alpha", "beta", "gamma"]) await seedProduct(db, slug);
  return db;
}

describe("the product defaults rows", () => {
  it("lists the live defaults and bounds, and keeps the pending licence defaults out", async () => {
    const db = await fleet();
    const r = await call(db, "/api/platform/settings");
    expect(r.status).toBe(200);
    const byKey = new Map<string, any>(
      (r.body.settings as any[]).map((s) => [s.key, s]),
    );
    for (const key of [KEY_LIMIT, MEDIA, "assets.quota.releaseBytes"]) {
      expect(byKey.get(key)?.area, key).toBe("product-defaults");
      // A change reaches every product: both directions ask for the L2 confirmation.
      expect(byKey.get(key)?.confirm).toEqual({ raise: "L2", lower: "L2" });
    }
    expect(byKey.has("license.defaults.deviceLimit")).toBe(false);
  });
});

describe("GET /manage/api/platform/settings/:key/reach", () => {
  it("counts the products that inherit a default, from the value in force to the proposed one", async () => {
    const db = await fleet();
    await own(db, "alpha", MEDIA, 1_000_000);
    const r = await call(
      db,
      `/api/platform/settings/${MEDIA}/reach?value=1000`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      kind: "default",
      direction: "lower",
      total: 3,
      reaches: 2,
      to: 1000,
    });
    expect(r.body.products.map((p: any) => p.product)).toEqual([
      "beta",
      "gamma",
    ]);
    expect(r.body.products[0]).toMatchObject({ name: "beta", inherited: true });
    // No change, no reach.
    const same = await call(db, `/api/platform/settings/${MEDIA}/reach`);
    expect(same.body).toMatchObject({ direction: "none", reaches: 0 });
  });

  it("ignores an expired claim, a value of the wrong type and a pending key", async () => {
    const db = await fleet();
    await own(db, "alpha", MEDIA, "lots");
    await db.run(
      "UPDATE product_settings SET expires_at = ? WHERE product = 'alpha'",
      NOW - 1,
    );
    await own(db, "beta", MEDIA, "lots");
    const r = await call(db, `/api/platform/settings/${MEDIA}/reach?value=5`);
    expect(r.body.reaches).toBe(3);
    const pending = await call(
      db,
      "/api/platform/settings/license.defaults.deviceLimit/reach",
    );
    expect(pending.status).toBe(404);
  });

  it("lowering a ceiling reaches the products it clamps, with from and to", async () => {
    const db = await fleet();
    await own(db, "alpha", KEY_LIMIT, 50);
    await own(db, "beta", KEY_LIMIT, 8);
    // gamma sets none: it takes the default of 10.
    const r = await call(
      db,
      `/api/platform/settings/${KEY_LIMIT}/reach?value=9`,
    );
    expect(r.body).toMatchObject({
      kind: "bound",
      direction: "lower",
      total: 3,
      reaches: 2,
      from: 100,
      to: 9,
    });
    expect(r.body.products).toEqual([
      { product: "alpha", name: "alpha", from: 50, to: 9, inherited: false },
      { product: "gamma", name: "gamma", from: 10, to: 9, inherited: true },
    ]);
  });

  it("raising a ceiling reaches the products it releases, not nothing", async () => {
    const db = await fleet();
    await own(db, "alpha", KEY_LIMIT, 50);
    await own(db, "beta", KEY_LIMIT, 40);
    await own(db, "gamma", KEY_LIMIT, 5);
    const path = `/api/platform/settings/${KEY_LIMIT}`;
    await call(db, path, {
      method: "PATCH",
      body: { value: 20, expectedVersion: 0, confirm: KEY_LIMIT },
    });
    const r = await call(db, `${path}/reach?value=60`);
    expect(r.body).toMatchObject({
      direction: "raise",
      from: 20,
      to: 60,
      reaches: 2,
    });
    expect(r.body.products).toEqual([
      { product: "alpha", name: "alpha", from: 20, to: 50, inherited: false },
      { product: "beta", name: "beta", from: 20, to: 40, inherited: false },
    ]);
    // A smaller raise releases less: both are still held, now to 25.
    const mid = await call(db, `${path}/reach?value=25`);
    expect(mid.body.products.map((p: any) => [p.product, p.to])).toEqual([
      ["alpha", 25],
      ["beta", 25],
    ]);
  });

  it("is a GET", async () => {
    const db = await fleet();
    const post = await call(db, `/api/platform/settings/${MEDIA}/reach`, {
      method: "POST",
      body: {},
    });
    expect([404, 405]).toContain(post.status);
  });
});

describe("the list carries what each linked row reaches at rest", () => {
  it("lists clamped products with set and effective, fresh after a write", async () => {
    const db = await fleet();
    await own(db, "alpha", KEY_LIMIT, 50);
    const get = async () =>
      (await call(db, "/api/platform/settings")).body.settings.find(
        (s: any) => s.key === KEY_LIMIT,
      );
    expect(await get()).toMatchObject({ fleet: { kind: "bound", count: 0 } });
    const w = await call(db, `/api/platform/settings/${KEY_LIMIT}`, {
      method: "PATCH",
      body: { value: 20, expectedVersion: 0, confirm: KEY_LIMIT },
    });
    expect(w.body.fleet.count).toBe(1);
    expect((await get()).fleet).toMatchObject({
      count: 1,
      total: 3,
      products: [
        { product: "alpha", set: 50, effective: 20, inherited: false },
      ],
    });
    const media = (await call(db, "/api/platform/settings")).body.settings.find(
      (s: any) => s.key === MEDIA,
    );
    expect(media.fleet).toMatchObject({
      kind: "default",
      inheriting: 3,
      own: [],
    });
  });
});

describe("a platform bound clamps, never rewrites", () => {
  it("writes the ceiling at L2 and shows set and effective on the product", async () => {
    const db = await fleet();
    await own(db, "alpha", KEY_LIMIT, 50);
    const path = `/api/platform/settings/${KEY_LIMIT}`;
    const refused = await call(db, path, {
      method: "PATCH",
      body: { value: 20, expectedVersion: 0 },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const ok = await call(db, path, {
      method: "PATCH",
      body: { value: 20, expectedVersion: 0, confirm: KEY_LIMIT },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ key: KEY_LIMIT, value: 20 });

    const r = await resolveProductSetting(
      { env, db, registry: SETTINGS },
      "alpha",
      KEY_LIMIT,
    );
    expect(r?.value).toBe(20);
    expect(r?.clamped).toEqual({ requested: 50, bound: 20, by: "platform" });
    // The product row is untouched.
    expect(
      await db.first(
        "SELECT value_json FROM product_settings WHERE product = 'alpha' AND key = ?",
        KEY_LIMIT,
      ),
    ).toEqual({ value_json: "50" });
    expect(coreSettingsRegistry().get(KEY_LIMIT, "platform")?.pending).toBe(
      undefined,
    );
  });
});
