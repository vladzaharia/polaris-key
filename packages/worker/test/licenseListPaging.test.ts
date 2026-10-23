/**
 * P0-29: the licence list pages by keyset (`activated_at DESC, id DESC`) and reads each page in a
 * fixed number of queries, however many licences the page holds.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedTier } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../src/core/console/session.js";
import { consoleTestSession } from "./consoleSessionHelper.js";

const SLUG = "tonebox";
const GROUP = "admins";

let db: SqliteDb;
let env: Env;
let queries: number;
let call: (method: string, path: string, body?: unknown) => Promise<Response>;

/** The same database, counting every statement the handler sends it. */
function counting(inner: Db): Db {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (
        typeof v === "function" &&
        (prop === "all" ||
          prop === "first" ||
          prop === "run" ||
          prop === "batch")
      )
        return (...args: unknown[]) => {
          queries += prop === "batch" ? (args[0] as unknown[]).length : 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.KEY_HASH_PEPPER = "p029-pepper";
  await seedProduct(db, SLUG);
  await seedTier(db, SLUG, "pro", { deviceLimit: 3, expiryDays: 30 });
  const { token, session } = await consoleTestSession(
    env,
    db,
    { sub: "op-1", name: "Op", email: "op@x.io", groups: [GROUP] },
    NOW,
  );
  call = (method, path, body) => {
    const full = `/api/products/${SLUG}${path}`;
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      counting(db),
      full.split("?")[0]!,
      { now: NOW },
    );
  };
});

async function seed(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await call("POST", "/license/licenses", {
      tier: "pro",
      name: `L${i}`,
      ...(i % 2 ? { email: `u${i}@example.com` } : {}),
    });
    expect(res.status).toBe(201);
  }
}

interface Page {
  licenses: { id: string; activatedAt: number }[];
  nextCursor: string | null;
}

async function page(qs: string): Promise<{ status: number; body: Page }> {
  const res = await call("GET", `/license/licenses${qs}`);
  return { status: res.status, body: (await res.json()) as Page };
}

describe("licence list paging", () => {
  it("walks every licence once, newest first, by cursor", async () => {
    await seed(7);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { status: number; body: Page } = await page(
        `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.licenses.length).toBeLessThanOrEqual(3);
      seen.push(...r.body.licenses.map((l) => l.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    const all = (await page("")).body;
    expect(all.nextCursor).toBeNull();
    expect(seen).toEqual(all.licenses.map((l) => l.id));
  });

  it("refuses a bad limit and a bad cursor", async () => {
    expect((await page("?limit=0")).status).toBe(400);
    expect((await page("?limit=91")).status).toBe(400);
    expect((await page("?limit=x")).status).toBe(400);
    expect((await page("?cursor=nope!")).status).toBe(400);
  });

  it("reads a page in a constant number of queries", async () => {
    await seed(24);
    // Warm anything first-contact (subjects) so both reads are steady state.
    await page("?limit=24");
    queries = 0;
    await page("?limit=2");
    const small = queries;
    expect(small).toBeGreaterThan(5);
    queries = 0;
    const big = await page("?limit=24");
    expect(big.body.licenses).toHaveLength(24);
    expect(queries).toBe(small);
  });

  it("answers the filtered total and the four state counts with page 1 only", async () => {
    await seed(5);
    const first = (await (
      await call("GET", "/license/licenses?limit=2")
    ).json()) as {
      total: number;
      counts: Record<string, number>;
      nextCursor: string;
    };
    expect(first.total).toBe(5);
    expect(first.counts).toEqual({
      active: 5,
      expiring: 0,
      expired: 0,
      disabled: 0,
    });
    const next = (await (
      await call(
        "GET",
        `/license/licenses?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      )
    ).json()) as Record<string, unknown>;
    expect(next).not.toHaveProperty("total");
    const none = (await (
      await call("GET", "/license/licenses?tier=nope")
    ).json()) as { total: number; licenses: unknown[] };
    expect(none.total).toBe(0);
    expect(none.licenses).toHaveLength(0);
    const pro = (await (
      await call("GET", "/license/licenses?tier=pro&limit=1")
    ).json()) as { total: number };
    expect(pro.total).toBe(5);
  });

  it("filters by computed state before it pages, and counts stay whole", async () => {
    await seed(5);
    const ids = (
      (await (await call("GET", "/license/licenses")).json()) as Page
    ).licenses.map((l) => l.id);
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE id = ?",
      ids[0],
    );
    await db.run(
      "UPDATE licenses SET expires_at = ? WHERE id = ?",
      NOW - 10,
      ids[1],
    );
    await db.run(
      "UPDATE licenses SET expires_at = ? WHERE id = ?",
      NOW + 86_400,
      ids[2],
    );
    const get = async (state: string) =>
      (await (
        await call("GET", `/license/licenses?state=${state}&limit=1`)
      ).json()) as {
        total: number;
        counts: Record<string, number>;
        licenses: { id: string }[];
        nextCursor: string | null;
      };
    const expired = await get("expired");
    expect(expired.total).toBe(1);
    expect(expired.licenses.map((l) => l.id)).toEqual([ids[1]]);
    expect(expired.nextCursor).toBeNull();
    expect(expired.counts).toEqual({
      active: 2,
      expiring: 1,
      expired: 1,
      disabled: 1,
    });
    expect((await get("disabled")).licenses.map((l) => l.id)).toEqual([ids[0]]);
    expect((await get("expiring")).licenses.map((l) => l.id)).toEqual([ids[2]]);
    const active = await get("active");
    expect(active.total).toBe(2);
    expect(active.nextCursor).not.toBeNull();
    expect((await call("GET", "/license/licenses?state=nope")).status).toBe(
      400,
    );
  });
});
