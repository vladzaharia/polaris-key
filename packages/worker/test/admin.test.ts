import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import { ADMIN_COOKIE, CSRF_HEADER, issueSession, type SessionIdentity } from "../src/admin/session.js";
import { listAudit } from "../src/repo.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const DJDL_ADMIN_GROUP = "djdl-admins";

/** An Env with the admin session secret + platform admin group set. */
function adminEnv(kv: KvMock, slugs: string[]): Env {
  const env = makeEnv(kv, slugs);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

/** Forge a signed session cookie for the given identity (same scheme the worker verifies). */
async function sessionCookie(
  env: Env,
  identity: SessionIdentity,
): Promise<{ cookie: string; csrf: string }> {
  const { token, session } = await issueSession(env, identity, NOW);
  return { cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

function mkReq(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`https://key.plrs.im/admin${path}`, init) as unknown as Request;
}

const dispatch = (req: Request, env: Env, db: Db, path: string) =>
  handleAdmin(req, env, db, path, { now: NOW });

describe("admin api", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const res = await dispatch(mkReq("GET", "/api/me"), env, db, "/api/me");
    expect(res.status).toBe(401);
  });

  it("returns the signed-in identity at /api/me", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie } = await sessionCookie(env, {
      sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP],
    });
    const res = await dispatch(mkReq("GET", "/api/me", { cookie }), env, db, "/api/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sub: string; platformAdmin: boolean; csrf: string };
    expect(body.sub).toBe("u1");
    expect(body.platformAdmin).toBe(true);
    expect(typeof body.csrf).toBe("string");
  });

  it("product create requires a platform admin", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    // A non-platform admin (no groups) cannot create a product.
    const weak = await sessionCookie(env, { sub: "u2", name: "Bob", email: "b@x.io", groups: [] });
    const denied = await dispatch(
      mkReq("POST", "/api/products", { cookie: weak.cookie, csrf: weak.csrf, body: { slug: "acme", name: "Acme" } }),
      env, db, "/api/products",
    );
    expect(denied.status).toBe(403);

    // A platform admin can.
    const strong = await sessionCookie(env, { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] });
    const created = await dispatch(
      mkReq("POST", "/api/products", { cookie: strong.cookie, csrf: strong.csrf, body: { slug: "acme", name: "Acme" } }),
      env, db, "/api/products",
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { ok: boolean; product: { slug: string } };
    expect(body.product.slug).toBe("acme");

    // It now shows up in the list.
    const list = await dispatch(mkReq("GET", "/api/products", { cookie: strong.cookie }), env, db, "/api/products");
    const listed = (await list.json()) as { products: { slug: string }[] };
    expect(listed.products.map((p) => p.slug)).toContain("acme");
  });

  it("creates a license and mints a key returned exactly once", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP],
    });

    const created = await dispatch(
      mkReq("POST", "/api/products/djdl/licenses", { cookie, csrf, body: { name: "Grace", email: "g@x.io" } }),
      env, db, "/api/products/djdl/licenses",
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { licenseId: string; key: string };
    expect(body.key.startsWith("pkey_djdl_")).toBe(true);

    // GET the license detail — the raw key is NOT echoed back.
    const detailRes = await dispatch(
      mkReq("GET", `/api/products/djdl/licenses/${body.licenseId}`, { cookie }),
      env, db, `/api/products/djdl/licenses/${body.licenseId}`,
    );
    const detail = (await detailRes.json()) as { keys: { hash: string }[] };
    expect(detail.keys.length).toBe(1);
    expect(JSON.stringify(detail)).not.toContain(body.key);
  });

  it("rejects a mutation with a missing/incorrect CSRF token", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie } = await sessionCookie(env, {
      sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP],
    });
    const res = await dispatch(
      mkReq("POST", "/api/products/djdl/licenses", { cookie, body: { name: "X" } }),
      env, db, "/api/products/djdl/licenses",
    );
    expect(res.status).toBe(403);
  });

  it("validates a published schema catalog", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP],
    });

    // A malformed catalog (bad schema fragment) is rejected.
    const bad = await dispatch(
      mkReq("PUT", "/api/products/djdl/schema", {
        cookie, csrf,
        body: { catalog: { schemaVersion: 2, entries: [{ key: "x", kind: "config", category: "c", label: "X", description: "", schema: { type: "not-a-type" } }] } },
      }),
      env, db, "/api/products/djdl/schema",
    );
    expect(bad.status).toBe(422);

    // A well-formed catalog publishes.
    const good = await dispatch(
      mkReq("PUT", "/api/products/djdl/schema", {
        cookie, csrf,
        body: { catalog: { schemaVersion: 2, entries: [{ key: "run.concurrency", kind: "config", category: "run", label: "Concurrency", description: "", schema: { type: "integer", minimum: 1 } }] } },
      }),
      env, db, "/api/products/djdl/schema",
    );
    expect(good.status).toBe(200);

    // And an override against it is catalog-validated (bad value ⇒ 422).
    const lic = await dispatch(
      mkReq("POST", "/api/products/djdl/licenses", { cookie, csrf, body: { name: "Z", email: "z@x.io" } }),
      env, db, "/api/products/djdl/licenses",
    );
    const { licenseId } = (await lic.json()) as { licenseId: string };
    const badOverride = await dispatch(
      mkReq("PUT", `/api/products/djdl/licenses/${licenseId}/overrides`, {
        cookie, csrf, body: { updates: [{ key: "run.concurrency", value: 0 }] },
      }),
      env, db, `/api/products/djdl/licenses/${licenseId}/overrides`,
    );
    expect(badOverride.status).toBe(422);
  });

  it("cannot touch another product the session does not administer", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl", "acme"]);
    // acme is admin-gated to a group the session lacks.
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    await db.run("UPDATE products SET admin_group = ? WHERE slug = ?", DJDL_ADMIN_GROUP, "djdl");
    await db.run("UPDATE products SET admin_group = ? WHERE slug = ?", "acme-admins", "acme");

    // A djdl-only admin (NOT platform) can read djdl but not acme.
    const { cookie } = await sessionCookie(env, {
      sub: "u3", name: "Cy", email: "c@x.io", groups: [DJDL_ADMIN_GROUP],
    });
    const okHere = await dispatch(
      mkReq("GET", "/api/products/djdl/licenses", { cookie }),
      env, db, "/api/products/djdl/licenses",
    );
    expect(okHere.status).toBe(200);

    const deniedThere = await dispatch(
      mkReq("GET", "/api/products/acme/licenses", { cookie }),
      env, db, "/api/products/acme/licenses",
    );
    expect(deniedThere.status).toBe(403);
  });

  it("writes an audit row on every mutation", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP],
    });
    await dispatch(
      mkReq("POST", "/api/products/djdl/licenses", { cookie, csrf, body: { name: "Grace", email: "g@x.io" } }),
      env, db, "/api/products/djdl/licenses",
    );
    const rows = await listAudit(db, "djdl", {});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.action).toBe("license.create");
    // Actor is the verified session subject, never a request field.
    expect(rows[0]?.actor_sub).toBe("u1");
  });
});
