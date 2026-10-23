/**
 * P0-22: a request reads its product once, and `/me` asks for the catalog versions in one query.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db, DbParam } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import { ADMIN_COOKIE } from "../src/core/console/session.js";
import { consoleTestSession } from "./consoleSessionHelper.js";

const PLATFORM_GROUP = "platform-admins";
let db: ReturnType<typeof makeTestDb>;

beforeEach(async () => {
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
  await seedProduct(db, "gamma");
});

/** A Db that records every statement. */
function spy(inner: Db): { db: Db; sql: string[] } {
  const sql: string[] = [];
  const wrap = <F extends (q: string, ...p: DbParam[]) => unknown>(f: F) =>
    ((q: string, ...p: DbParam[]) => {
      sql.push(q);
      return f.call(inner, q, ...p);
    }) as F;
  const proxy = new Proxy(inner, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      return typeof v === "function" &&
        ["first", "all", "run"].includes(String(k))
        ? wrap(v as never)
        : v;
    },
  });
  return { db: proxy, sql };
}

async function call(
  database: Db,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const env: Env = makeEnv(new KvMock(), []);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  const { token } = await consoleTestSession(
    env,
    db,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const res = await handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }),
    env,
    database,
    path,
    { now: NOW },
  );
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const productReads = (sql: string[]) =>
  sql.filter((q) => /FROM products\b/i.test(q) && /WHERE slug/i.test(q));

describe("request-scoped product context", () => {
  it("reads the product row once for a product-scoped request", async () => {
    for (const path of [
      "/api/products/alpha/settings/core.trustPolicy",
      "/api/products/alpha/users",
    ]) {
      const s = spy(db);
      const r = await call(s.db, path);
      expect(r.status, path).toBe(200);
      expect(productReads(s.sql), path).toHaveLength(1);
    }
  });

  it("/me asks for the catalog versions with one query, however many products", async () => {
    const s = spy(db);
    const r = await call(s.db, "/api/me");
    expect(r.status).toBe(200);
    expect((r.json.products as unknown[]).length).toBe(3);
    expect(s.sql.filter((q) => /product_schema/i.test(q))).toHaveLength(1);
  });
});
