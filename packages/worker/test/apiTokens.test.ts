/**
 * `pkeya_` admin API tokens — the admin surface's machine credential (A2-02 / A2-05).
 *
 * What this suite owns is the CREDENTIAL, not the routes it reaches: that a token authenticates
 * at all, that it is confined to its scopes with default deny, that the three lifecycle refusals
 * (revoked, expired, unknown) are indistinguishable from outside, that the plaintext exists in
 * exactly one response, and — the pair that matters most — that adding a second credential type
 * did not open a path around a gate the session path enforces.
 *
 * The CSRF pair at the bottom is the sharpest of those. "A token is exempt from CSRF" is only a
 * safe thing to say if the session is still NOT exempt, so both halves are asserted together, in
 * one describe block, against the same route. Asserting the exemption alone would pass just as
 * happily on the day somebody deleted the check.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedLicenseWithKey } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import {
  ADMIN_API_SCOPES,
  MAX_TOKEN_DAYS,
  parseScopes,
  scopeForRequest,
  tokenSession,
  validateAdminApiToken,
} from "../src/admin/apiTokens.js";
import { hashKey, isAdminApiToken, mintAdminApiToken } from "../src/crypto.js";
import { listAudit } from "../src/repo.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const SLUG = "djdl";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DAY = 86_400;

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

async function session(
  env: Env,
  groups: string[] = [PLATFORM_GROUP],
): Promise<{ cookie: string; csrf: string }> {
  const { token, session: s } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  return { cookie: `${ADMIN_COOKIE}=${token}`, csrf: s.csrf };
}

function mkReq(
  method: string,
  path: string,
  opts: {
    cookie?: string;
    csrf?: string;
    bearer?: string;
    body?: unknown;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(
    `https://key.plrs.im/manage${path}`,
    init,
  ) as unknown as Request;
}

const dispatch = (req: Request, env: Env, db: Db, path: string) =>
  handleAdmin(req, env, db, path, { now: NOW });

/** Mint a token through the real endpoint, as an operator would. */
async function mint(
  env: Env,
  db: Db,
  auth: { cookie: string; csrf: string },
  body: Record<string, unknown> = { label: "CI", expiresInDays: 90 },
): Promise<{ status: number; secret: string; id: string; body: any }> {
  const res = await dispatch(
    mkReq("POST", "/api/tokens", { ...auth, body }),
    env,
    db,
    "/api/tokens",
  );
  const parsed = (await res.json()) as any;
  return {
    status: res.status,
    secret: parsed.secret ?? "",
    id: parsed.token?.id ?? "",
    body: parsed,
  };
}

/** Insert a token row directly, so a lifecycle state can be constructed without waiting. */
async function plant(
  env: Env,
  db: Db,
  opts: {
    id?: string;
    scopes?: string[];
    expiresAt?: number;
    revokedAt?: number | null;
  } = {},
): Promise<string> {
  const secret = mintAdminApiToken();
  await db.run(
    `INSERT INTO admin_api_tokens
       (id, token_hash, label, scopes_json, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    opts.id ?? "apitok_planted",
    await hashKey(secret, env.KEY_HASH_PEPPER),
    "planted",
    JSON.stringify(opts.scopes ?? [...ADMIN_API_SCOPES]),
    NOW - DAY,
    opts.expiresAt ?? NOW + 30 * DAY,
    opts.revokedAt ?? null,
  );
  return secret;
}

async function world(): Promise<{
  db: Db;
  env: Env;
  auth: { cookie: string; csrf: string };
  licenseId: string;
}> {
  const db = makeTestDb();
  const env = adminEnv();
  await seedProduct(db, SLUG);
  const { licenseId } = await seedLicenseWithKey(db, SLUG);
  return { db, env, auth: await session(env), licenseId };
}

const bundlePath = `/api/products/${SLUG}/bundles`;
const bundleBody = { deviceId: DEVICE, graceDays: 7 };

// ── shape gate ───────────────────────────────────────────────────────────────

describe("pkeya_ token shape", () => {
  it("mints a 256-bit prefixed token that its own gate accepts", () => {
    const token = mintAdminApiToken();
    expect(token.startsWith("pkeya_")).toBe(true);
    expect(token.slice("pkeya_".length)).toHaveLength(43);
    expect(isAdminApiToken(token)).toBe(true);
  });

  it("refuses every neighbouring credential prefix", () => {
    // The whole point of the shape gate: these are all real credentials in this system, and
    // none of them may be presentable here even before a lookup happens.
    expect(isAdminApiToken("pkeyt_" + "a".repeat(43))).toBe(false);
    expect(isAdminApiToken("pkey_djdl_" + "a".repeat(22))).toBe(false);
    expect(isAdminApiToken("a".repeat(43))).toBe(false);
    expect(isAdminApiToken("pkeya_short")).toBe(false);
    expect(isAdminApiToken("pkeya_" + "!".repeat(43))).toBe(false);
  });

  it("never returns anything for an unparseable scope list", () => {
    expect(parseScopes("{not json")).toEqual([]);
    expect(parseScopes('"bundles:mint"')).toEqual([]);
    expect(parseScopes('["bundles:mint","invented:scope"]')).toEqual([
      "bundles:mint",
    ]);
  });
});

// ── mint / list / revoke ─────────────────────────────────────────────────────

describe("admin API token surface", () => {
  it("mints once, and the plaintext never appears again", async () => {
    const { db, env, auth } = await world();
    const minted = await mint(env, db, auth);
    expect(minted.status).toBe(201);
    expect(isAdminApiToken(minted.secret)).toBe(true);

    const listRes = await dispatch(
      mkReq("GET", "/api/tokens", auth),
      env,
      db,
      "/api/tokens",
    );
    const text = await listRes.text();
    expect(listRes.status).toBe(200);
    // The strongest form of the assertion: the secret is not anywhere in the body, not merely
    // absent from a field somebody remembered to check.
    expect(text).not.toContain(minted.secret);
    expect(text).not.toContain(minted.secret.slice("pkeya_".length));
    // …and neither is the stored hash, which is not a secret but IS the lookup key.
    const hash = await hashKey(minted.secret, env.KEY_HASH_PEPPER);
    expect(text).not.toContain(hash);
    const listed = JSON.parse(text) as any;
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0]).toMatchObject({
      id: minted.id,
      label: "CI",
      scopes: ["bundles:mint"],
      status: "active",
      lastUsedAt: null,
    });
  });

  it("requires a bounded, explicit expiry", async () => {
    const { db, env, auth } = await world();
    for (const expiresInDays of [undefined, 0, -1, 1.5, MAX_TOKEN_DAYS + 1]) {
      const res = await mint(env, db, auth, { label: "x", expiresInDays });
      expect(res.status, String(expiresInDays)).toBe(422);
      expect(res.body.fields).toContain("expiresInDays");
    }
    const ok = await mint(env, db, auth, { label: "x", expiresInDays: 1 });
    expect(ok.status).toBe(201);
    expect(ok.body.token.expiresAt).toBe(NOW + DAY);
  });

  it("refuses a label or a scope it does not recognise", async () => {
    const { db, env, auth } = await world();
    const noLabel = await mint(env, db, auth, {
      label: "  ",
      expiresInDays: 30,
    });
    expect(noLabel.status).toBe(422);
    expect(noLabel.body.fields).toContain("label");

    const badScope = await mint(env, db, auth, {
      label: "x",
      expiresInDays: 30,
      scopes: ["products:write"],
    });
    expect(badScope.status).toBe(422);
    expect(badScope.body.fields).toContain("scopes");

    const emptyScope = await mint(env, db, auth, {
      label: "x",
      expiresInDays: 30,
      scopes: [],
    });
    expect(emptyScope.status).toBe(422);
  });

  it("revokes by id, keeps the row, and refuses a second revoke", async () => {
    const { db, env, auth } = await world();
    const minted = await mint(env, db, auth);
    const path = `/api/tokens/${minted.id}`;
    const first = await dispatch(mkReq("DELETE", path, auth), env, db, path);
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).token.status).toBe("revoked");

    const second = await dispatch(mkReq("DELETE", path, auth), env, db, path);
    expect(second.status).toBe(409);

    // The row survives revocation — that history IS the lifecycle record.
    const listRes = await dispatch(
      mkReq("GET", "/api/tokens", auth),
      env,
      db,
      "/api/tokens",
    );
    const listed = (await listRes.json()) as any;
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0].revokedAt).toBe(NOW);
  });

  it("404s an unknown id", async () => {
    const { db, env, auth } = await world();
    const path = "/api/tokens/apitok_nope";
    const res = await dispatch(mkReq("DELETE", path, auth), env, db, path);
    expect(res.status).toBe(404);
  });

  it("keeps the session gates: 401 unauthenticated, 403 off-group, 403 without CSRF", async () => {
    const { db, env, auth } = await world();
    expect(
      (await dispatch(mkReq("GET", "/api/tokens"), env, db, "/api/tokens"))
        .status,
    ).toBe(401);

    const outsider = await session(env, ["some-other-group"]);
    expect(
      (
        await dispatch(
          mkReq("GET", "/api/tokens", outsider),
          env,
          db,
          "/api/tokens",
        )
      ).status,
    ).toBe(403);

    const noCsrf = await dispatch(
      mkReq("POST", "/api/tokens", {
        cookie: auth.cookie,
        body: { label: "x", expiresInDays: 30 },
      }),
      env,
      db,
      "/api/tokens",
    );
    expect(noCsrf.status).toBe(403);
  });
});

// ── authentication ───────────────────────────────────────────────────────────

describe("token authentication", () => {
  it("authenticates a bundle mint with no cookie and no CSRF header", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    const res = await dispatch(
      mkReq("POST", bundlePath, {
        bearer: minted.secret,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.bundleId).toBeTruthy();
    expect(body.bundle.split(".")).toHaveLength(3);
  });

  it("stamps last_used_at", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    await dispatch(
      mkReq("POST", bundlePath, {
        bearer: minted.secret,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    const row = await db.first<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM admin_api_tokens WHERE id = ?",
      minted.id,
    );
    expect(row?.last_used_at).toBe(NOW);
  });

  it("audits every use, attributed to the TOKEN and not to the operator who minted it", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    await dispatch(
      mkReq("POST", bundlePath, {
        bearer: minted.secret,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    const rows = await listAudit(db, SLUG, { limit: 20 });
    const use = rows.find((r) => r.action === "api_token.used");
    expect(use, "no api_token.used row").toBeTruthy();
    expect(use!.actor_sub).toBe(`token:${minted.id}`);
    expect(use!.actor_sub).not.toBe("u1");
    expect(use!.summary).toContain("bundles:mint");
    // …and the mint the token performed is still audited under the same actor, so the two rows
    // read as one story rather than as an anonymous mint next to a credential use.
    const bundle = rows.find((r) => r.action === "bundle.minted");
    expect(bundle?.actor_sub).toBe(`token:${minted.id}`);
  });

  it("refuses a revoked token", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    const revokePath = `/api/tokens/${minted.id}`;
    await dispatch(mkReq("DELETE", revokePath, auth), env, db, revokePath);
    const res = await dispatch(
      mkReq("POST", bundlePath, {
        bearer: minted.secret,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    expect(res.status).toBe(401);
  });

  it("refuses an expired token", async () => {
    const { db, env, licenseId } = await world();
    const secret = await plant(env, db, { expiresAt: NOW - 1 });
    const res = await dispatch(
      mkReq("POST", bundlePath, {
        bearer: secret,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    expect(res.status).toBe(401);
  });

  it("refuses an unknown, a malformed, and a session cookie pasted into the header", async () => {
    const { db, env, auth } = await world();
    for (const bearer of [
      mintAdminApiToken(),
      "pkeya_short",
      "not-a-token",
      auth.cookie.split("=").slice(1).join("="),
    ]) {
      const res = await dispatch(
        mkReq("GET", "/api/me", { bearer }),
        env,
        db,
        "/api/me",
      );
      expect(res.status, bearer.slice(0, 12)).toBe(401);
    }
  });

  it("does not fall back to the cookie when a bad token is presented alongside it", async () => {
    // One request, one credential. A "try everything" authenticator would run this as the human.
    const { db, env, auth } = await world();
    const res = await dispatch(
      mkReq("GET", "/api/me", { ...auth, bearer: mintAdminApiToken() }),
      env,
      db,
      "/api/me",
    );
    expect(res.status).toBe(401);
  });

  it("a row whose scope list will not parse authorises nothing", async () => {
    const { db, env } = await world();
    const secret = mintAdminApiToken();
    await db.run(
      `INSERT INTO admin_api_tokens
         (id, token_hash, label, scopes_json, created_at, expires_at, last_used_at, revoked_at)
       VALUES ('apitok_broken', ?, 'broken', '{not json', ?, ?, NULL, NULL)`,
      await hashKey(secret, env.KEY_HASH_PEPPER),
      NOW - DAY,
      NOW + DAY,
    );
    const auth = await validateAdminApiToken(env, db, secret, NOW);
    expect(auth.ok).toBe(false);
  });

  it("authorises nothing when the deployment has configured no platform-admin group", async () => {
    // The session path fails closed on a missing PLATFORM_ADMIN_GROUP (`admin/authz.ts`); the
    // token path must not be the exception that quietly grants authority instead.
    const env = adminEnv();
    delete (env as Record<string, unknown>).PLATFORM_ADMIN_GROUP;
    const synthetic = tokenSession(env, {
      id: "apitok_x",
      token_hash: "h",
      label: "l",
      scopes_json: "[]",
      created_at: NOW,
      expires_at: NOW + DAY,
      last_used_at: null,
      revoked_at: null,
    });
    expect(synthetic.groups).toEqual([]);
    expect(synthetic.csrf).toBe("");
  });
});

// ── scopes: default deny ─────────────────────────────────────────────────────

describe("scope confinement", () => {
  it("maps only the bundle mint, and nothing else", () => {
    expect(scopeForRequest("POST", ["products", "djdl", "bundles"])).toBe(
      "bundles:mint",
    );
    // Every neighbour of that one route, including the same path under a different verb.
    expect(scopeForRequest("GET", ["products", "djdl", "bundles"])).toBeNull();
    expect(
      scopeForRequest("POST", ["products", "djdl", "bundles", "x"]),
    ).toBeNull();
    expect(scopeForRequest("GET", ["products"])).toBeNull();
    expect(scopeForRequest("GET", ["me"])).toBeNull();
    expect(scopeForRequest("POST", ["tokens"])).toBeNull();
    expect(scopeForRequest("DELETE", ["products", "djdl"])).toBeNull();
  });

  it("refuses a token on a route outside its scopes", async () => {
    const { db, env } = await world();
    // A live, well-formed token whose scope list simply does not cover the route.
    const secret = await plant(env, db, { scopes: ["bundles:mint"] });
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["GET", "/api/products"],
      ["DELETE", `/api/products/${SLUG}`],
      ["GET", `/api/products/${SLUG}/activity`],
    ] as const) {
      const res = await dispatch(
        mkReq(method, path, { bearer: secret }),
        env,
        db,
        path,
      );
      expect(res.status, `${method} ${path}`).toBe(403);
      const body = (await res.json()) as any;
      expect(body.message).toContain("scoped");
    }
  });

  it("refuses a token on the token surface itself — no token mints a token", async () => {
    const { db, env } = await world();
    const secret = await plant(env, db);
    for (const [method, path] of [
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens"],
      ["DELETE", "/api/tokens/apitok_planted"],
    ] as const) {
      const res = await dispatch(
        mkReq(method, path, {
          bearer: secret,
          ...(method === "GET" ? {} : { body: {} }),
        }),
        env,
        db,
        path,
      );
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // …and the row it could not revoke is still live.
    const row = await db.first<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM admin_api_tokens WHERE id = 'apitok_planted'",
    );
    expect(row?.revoked_at).toBeNull();
  });

  it("writes no audit row for a use it refused", async () => {
    const { db, env } = await world();
    const secret = await plant(env, db);
    const path = `/api/products/${SLUG}/activity`;
    await dispatch(mkReq("GET", path, { bearer: secret }), env, db, path);
    const rows = await listAudit(db, SLUG, { limit: 20 });
    expect(rows.filter((r) => r.action === "api_token.used")).toEqual([]);
  });
});

// ── the CSRF pair ────────────────────────────────────────────────────────────

describe("CSRF: exempt for tokens, still enforced for sessions", () => {
  it("a token-authenticated mutation needs no CSRF header", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    const res = await dispatch(
      mkReq("POST", bundlePath, {
        bearer: minted.secret,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    expect(res.status).toBe(200);
  });

  it("a SESSION-authenticated mutation on the same route still does", async () => {
    const { db, env, auth, licenseId } = await world();
    const without = await dispatch(
      mkReq("POST", bundlePath, {
        cookie: auth.cookie,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    expect(without.status).toBe(403);
    expect(((await without.json()) as any).message).toBe("csrf");

    const withHeader = await dispatch(
      mkReq("POST", bundlePath, {
        ...auth,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    expect(withHeader.status).toBe(200);
  });

  it("a session's own CSRF token cannot be replayed as a bearer credential", async () => {
    const { db, env, auth, licenseId } = await world();
    const res = await dispatch(
      mkReq("POST", bundlePath, {
        bearer: auth.csrf,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    expect(res.status).toBe(401);
  });
});
