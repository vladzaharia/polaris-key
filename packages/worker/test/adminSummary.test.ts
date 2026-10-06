/**
 * `GET /manage/api/summary` (console product card, step 2; ADMIN.md A-8 sliced): one fact per
 * service for every visible product, four grouped queries however many products there are, and
 * never a product the session cannot list.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db, DbParam } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import { ADMIN_COOKIE, issueSession } from "../src/admin/session.js";
import { setServices } from "../src/repo.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const DAY = 86_400;

let db: ReturnType<typeof makeTestDb>;

const ALL = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
];
const services = (...on: string[]) =>
  JSON.stringify(
    Object.fromEntries(ALL.map((s) => [s, { enabled: on.includes(s) }])),
  );

function adminEnv(): Env {
  const e = makeEnv(new KvMock(), []);
  e.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  e.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return e;
}

async function summary(
  groups: string[] = [PLATFORM_GROUP],
  database: Db = db,
  method = "GET",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const env = adminEnv();
  const { token } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const res = await handleAdmin(
    new Request("https://key.plrs.im/manage/api/summary", {
      method,
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }),
    env,
    database,
    "/api/summary",
    { now: NOW },
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function license(
  product: string,
  id: string,
  opts: { status?: string; expiresAt?: number | null; account?: string } = {},
) {
  await db.run(
    `INSERT INTO licenses (product, id, status, activated_at, expires_at, modified_at, account_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    product,
    id,
    opts.status ?? "active",
    NOW - DAY,
    opts.expiresAt ?? null,
    NOW,
    opts.account ?? null,
  );
}

async function release(
  product: string,
  id: string,
  version: string,
  publishedAt: number,
  channels: string[],
) {
  await db.run(
    `INSERT INTO release_metadata (product, release_id, version, published_at, created_at,
            modified_at, deliverable_id)
          VALUES (?, ?, ?, ?, ?, ?, 'app')`,
    product,
    id,
    version,
    publishedAt,
    publishedAt,
    publishedAt,
  );
  for (const channel of channels)
    await db.run(
      `INSERT INTO release_channels (product, channel, release_id, created_at, modified_at)
            VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (product, channel) DO UPDATE SET release_id = excluded.release_id`,
      product,
      channel,
      id,
      NOW,
      NOW,
    );
}

async function outlet(
  product: string,
  id: string,
  kind: string,
  removed = false,
) {
  await db.run(
    `INSERT INTO dist_outlets (product, outlet_id, kind, removed_at, created_at, modified_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    product,
    id,
    kind,
    removed ? NOW : null,
    NOW,
    NOW,
  );
}

async function subject(product: string, account: string, subjectId: string) {
  await db.run(
    `INSERT OR IGNORE INTO accounts (id, created_at, modified_at) VALUES (?, ?, ?)`,
    account,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO account_product_subjects (account_id, product, subject, created_at)
          VALUES (?, ?, ?, ?)`,
    account,
    product,
    subjectId,
    NOW,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  await seedProduct(db, "djdl");
  await seedProduct(db, "acme");
  await setServices(db, "djdl", services(...ALL), "admin", NOW);
  await setServices(db, "acme", services("license", "config"), "admin", NOW);
});

describe("GET /manage/api/summary", () => {
  it("counts each fact per product, for the services it runs", async () => {
    // Licences: active and unexpired only.
    await license("djdl", "l1");
    await license("djdl", "l2", { expiresAt: NOW + DAY });
    await license("djdl", "l3", { expiresAt: NOW - 1 });
    await license("djdl", "l4", { status: "disabled" });
    await license("acme", "a1");
    // Releases: the newest a channel serves, stable first on a tie; a yanked one never counts.
    await release("djdl", "r1", "2.3.0", NOW - 3 * DAY, ["stable"]);
    await release("djdl", "r2", "2.4.0", NOW - 2 * DAY, ["beta"]);
    await release("djdl", "r3", "2.5.0", NOW - DAY, []);
    await release("djdl", "r4", "2.6.0", NOW, ["nightly"]);
    await db.run(
      `INSERT INTO release_yanks (product, release_id, reason, at, by) VALUES ('djdl', 'r4', 'bad', ?, 'u1')`,
      NOW,
    );
    // Storefronts: the App Store's two outlet kinds are one storefront, Steam another, and the
    // direct outlet one more (Homebrew, Scoop and Polaris Key's page all ride it, so it counts
    // once); a removed outlet counts for nothing.
    await outlet("djdl", "o1", "app-store");
    await outlet("djdl", "o2", "testflight");
    await outlet("djdl", "o3", "steam");
    await outlet("djdl", "o4", "winget", true);
    await outlet("djdl", "o5", "direct");
    // Users: a subject the Users page lists (it holds a licence), and one it does not.
    await subject("djdl", "acc1", "sub_1");
    await license("djdl", "l5", { account: "acc1" });
    await subject("djdl", "acc2", "sub_2");

    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      products: {
        acme: { license: { active: 1 } },
        djdl: {
          license: { active: 3 },
          release: { version: "2.4.0", channel: "beta" },
          distribution: { storefronts: 3 },
          identity: { users: 1 },
        },
      },
    });
  });

  it("names stable when two channels serve the same newest release", async () => {
    await release("djdl", "r1", "3.0.0", NOW, ["beta", "stable"]);
    const res = await summary();
    expect(
      (res.json.products as Record<string, { release: unknown }>).djdl!.release,
    ).toEqual({ version: "3.0.0", channel: "stable" });
  });

  it("zero is a fact, and a product with no release on a channel says null", async () => {
    const res = await summary();
    expect((res.json.products as Record<string, unknown>).djdl).toEqual({
      license: { active: 0 },
      release: null,
      distribution: { storefronts: 0 },
      identity: { users: 0 },
    });
  });

  it("answers only a platform admin, and only for the products the registry lists", async () => {
    await license("djdl", "l1");
    const denied = await summary(["someone-else"]);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.json)).not.toContain("djdl");
    // A deleted product's rows are still in the tables; they never surface.
    await db.run("UPDATE products SET status = 'deleted' WHERE slug = 'djdl'");
    const res = await summary();
    expect(Object.keys(res.json.products as object)).toEqual(["acme"]);
  });

  it("is read-only", async () => {
    // A write without the CSRF header is refused before routing; with no session it is a 401.
    const res = await summary([PLATFORM_GROUP], db, "POST");
    expect([403, 405]).toContain(res.status);
  });

  it("costs four grouped queries however many products there are", async () => {
    const measure = async (): Promise<{ total: number; facts: string[] }> => {
      let total = 0;
      const facts: string[] = [];
      const counting = new Proxy(db, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (prop === "all" || prop === "first" || prop === "run")
            return (sql: string, ...params: DbParam[]) => {
              total++;
              const m =
                /FROM (licenses|release_channels|dist_outlets|account_product_subjects)\b/.exec(
                  sql,
                );
              if (m) facts.push(m[1]!);
              return (v as (s: string, ...p: DbParam[]) => unknown).call(
                target,
                sql,
                ...params,
              );
            };
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as Db;
      const res = await summary([PLATFORM_GROUP], counting);
      expect(res.status).toBe(200);
      return { total, facts: facts.sort() };
    };
    const two = await measure();
    for (let i = 0; i < 10; i++) {
      await seedProduct(db, `p${i}`);
      await setServices(db, `p${i}`, services(...ALL), "admin", NOW);
      await license(`p${i}`, "l1");
    }
    const twelve = await measure();
    expect(twelve.total).toBe(two.total);
    expect(two.facts).toEqual([
      "account_product_subjects",
      "dist_outlets",
      "licenses",
      "release_channels",
    ]);
  });
});
