/**
 * `pkeya_` admin API tokens: the admin surface's machine credential.
 *
 * What this suite owns is the CREDENTIAL, not the routes it reaches: that a token authenticates at
 * all, that it is confined to its scopes with default deny, that the lifecycle refusals (revoked,
 * expired, unknown) are indistinguishable from outside, that the plaintext exists in exactly one
 * response, and, the pair that matters most, that adding a second credential type did not open a
 * path around a gate the session path enforces.
 *
 * The CSRF pair near the bottom is the sharpest of those. "A token is exempt from CSRF" is only a
 * safe thing to say if the session is still NOT exempt, so both halves are asserted together, in
 * one block, against the same route. Asserting the exemption alone would pass just as happily on
 * the day somebody deleted the check.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedLicenseWithKey } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import { handleDocs } from "../src/docs.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import {
  ADMIN_API_SCOPES,
  MAX_ADMIN_API_TOKENS,
  MAX_TOKEN_DAYS,
  auditTokenUse,
  parseScopes,
  presentedToken,
  tokenSession,
  validateAdminApiToken,
  type AdminApiTokenRow,
} from "../src/console/apiTokens.js";
import { ADMIN_ROUTES } from "../src/console/routes.js";
import { routeKey } from "../src/console/routeMatch.js";
import { rateLimitOk } from "../src/core/rateLimit.js";
import {
  hashKey,
  isAdminApiToken,
  mintAdminApiToken,
} from "../src/platform/crypto.js";
import { listAudit } from "../src/core/audit.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const PEPPER = "p".repeat(32);
const SLUG = "djdl";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DAY = 86_400;

/** A token as the roster answers it. */
interface TokenJson {
  id: string;
  label: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: string;
}

/** The fields of an admin API answer these tests read. */
interface ApiBody {
  ok?: boolean;
  token?: TokenJson;
  tokens?: TokenJson[];
  secret?: string;
  code?: string;
  message?: string;
  fields?: string[];
  maxAgeSeconds?: number;
  bundleId?: string;
  bundle?: string;
  error?: { code?: string; reason?: string };
}

const answer = async (res: Response): Promise<ApiBody> =>
  (await res.json()) as ApiBody;

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  env.KEY_HASH_PEPPER = PEPPER;
  return env;
}

interface Auth {
  cookie: string;
  csrf: string;
}

/** An operator's console session. `stepUp` is a proven sign-in just now, which minting needs. */
async function session(
  env: Env,
  opts: { groups?: string[]; stepUp?: boolean } = {},
): Promise<Auth> {
  const { token, session: s } = await issueSession(
    env,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: opts.groups ?? [PLATFORM_GROUP],
      ...(opts.stepUp ? { authTime: NOW, stepUp: true } : {}),
    },
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
    authorization?: string;
    body?: unknown;
    rawBody?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.authorization !== undefined)
    headers.authorization = opts.authorization;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  if (opts.rawBody !== undefined) {
    init.body = opts.rawBody;
    headers["content-type"] = "application/json";
  }
  return new Request(
    `https://key.plrs.im/manage${path}`,
    init,
  ) as unknown as Request;
}

const dispatch = (req: Request, env: Env, db: Db, path: string) =>
  handleAdmin(req, env, db, path, { now: NOW });

interface Minted {
  status: number;
  secret: string;
  id: string;
  body: ApiBody;
}

/** Mint a token through the real endpoint, as an operator would. */
async function mint(
  env: Env,
  db: Db,
  auth: Auth,
  body: Record<string, unknown> = { label: "CI", expiresInDays: 90 },
): Promise<Minted> {
  const res = await dispatch(
    mkReq("POST", "/api/tokens", { ...auth, body }),
    env,
    db,
    "/api/tokens",
  );
  const parsed = await answer(res);
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
    JSON.stringify(opts.scopes ?? ["bundles:mint"]),
    NOW - DAY,
    opts.expiresAt ?? NOW + 30 * DAY,
    opts.revokedAt ?? null,
  );
  return secret;
}

async function world(): Promise<{
  db: Db;
  env: Env;
  auth: Auth;
  licenseId: string;
}> {
  const db = makeTestDb();
  const env = adminEnv();
  await seedProduct(db, SLUG);
  const { licenseId } = await seedLicenseWithKey(db, SLUG);
  return { db, env, auth: await session(env, { stepUp: true }), licenseId };
}

const bundlePath = `/api/products/${SLUG}/bundles`;
const bundleBody = { deviceId: DEVICE, graceDays: 7 };

/** The one thing a token is for: a bundle mint, as `pkey bundle` sends it. */
function mintBundle(
  env: Env,
  db: Db,
  licenseId: string,
  creds: { bearer?: string; cookie?: string; csrf?: string },
): Promise<Response> {
  return dispatch(
    mkReq("POST", bundlePath, {
      ...creds,
      body: { ...bundleBody, licenseId },
    }),
    env,
    db,
    bundlePath,
  );
}

async function platformAuditRows(db: Db) {
  return db.all<{
    action: string;
    actor_sub: string | null;
    actor_name: string | null;
    target_kind: string | null;
    target_id: string | null;
    summary: string | null;
    before_json: string | null;
    after_json: string | null;
  }>("SELECT * FROM platform_audit ORDER BY at, id");
}

// ── shape gate ───────────────────────────────────────────────────────────────

describe("pkeya_ token shape", () => {
  it("mints a 256-bit prefixed token that its own gate accepts", () => {
    const token = mintAdminApiToken();
    expect(token.startsWith("pkeya_")).toBe(true);
    expect(token.slice("pkeya_".length)).toHaveLength(43);
    expect(isAdminApiToken(token)).toBe(true);
  });

  it("refuses every neighbouring credential prefix", () => {
    // The whole point of the shape gate: these are all real credentials in this system, and none
    // of them may be presentable here even before a lookup happens.
    expect(isAdminApiToken("pkeyt_" + "a".repeat(43))).toBe(false);
    expect(isAdminApiToken("pkeyci_" + "a".repeat(43))).toBe(false);
    expect(isAdminApiToken("pkeyr_" + "a".repeat(43))).toBe(false);
    expect(isAdminApiToken("pkey_djdl_" + "a".repeat(22))).toBe(false);
    expect(isAdminApiToken("a".repeat(43))).toBe(false);
    expect(isAdminApiToken("pkeya_short")).toBe(false);
    expect(isAdminApiToken("pkeya_" + "!".repeat(43))).toBe(false);
  });

  it("never returns anything for an unparseable scope list", () => {
    expect(parseScopes("{not json")).toEqual([]);
    expect(parseScopes('"bundles:mint"')).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes('["bundles:mint","invented:scope"]')).toEqual([
      "bundles:mint",
    ]);
  });
});

// ── the table ────────────────────────────────────────────────────────────────

describe("the admin_api_tokens table", () => {
  it("holds a hash that is unique, and an expiry that is after the mint", async () => {
    const db = makeTestDb();
    const insert = (
      id: string,
      hash: string,
      created: number,
      expires: number,
    ) =>
      db.run(
        `INSERT INTO admin_api_tokens (id, token_hash, label, scopes_json, created_at, expires_at)
         VALUES (?, ?, 'x', '["bundles:mint"]', ?, ?)`,
        id,
        hash,
        created,
        expires,
      );
    await insert("apitok_1", "h", NOW, NOW + DAY);
    await expect(insert("apitok_2", "h", NOW, NOW + DAY)).rejects.toThrow(
      /UNIQUE/,
    );
    await expect(insert("apitok_3", "h3", NOW, NOW)).rejects.toThrow(/CHECK/);
  });

  it("is looked up through the registered unique index", async () => {
    const db = makeTestDb();
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM admin_api_tokens WHERE token_hash = ?",
      "x",
    );
    expect(plan.map((p) => p.detail).join(" ")).toMatch(
      /SEARCH.*idx_admin_api_tokens_hash/,
    );
    const asserted = await db.first<{ expected: number; found: number }>(
      "SELECT expected, found FROM schema_index_assertion",
    );
    expect(asserted?.found).toBe(asserted?.expected);
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
    const listed = JSON.parse(text) as ApiBody;
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens?.[0]).toMatchObject({
      id: minted.id,
      label: "CI",
      scopes: ["bundles:mint"],
      status: "active",
      lastUsedAt: null,
    });
  });

  it("stores only the peppered hash: not the plaintext, not the unkeyed digest", async () => {
    const { db, env, auth } = await world();
    const minted = await mint(env, db, auth);
    const row = await db.first<{ token_hash: string }>(
      "SELECT token_hash FROM admin_api_tokens WHERE id = ?",
      minted.id,
    );
    expect(row?.token_hash).toBe(await hashKey(minted.secret, PEPPER));
    expect(row?.token_hash).not.toBe(await hashKey(minted.secret));
    expect(row?.token_hash).not.toContain(minted.secret);
    // …so the same string under another pepper is a different, unknown credential.
    const other = { ...env, KEY_HASH_PEPPER: "q".repeat(32) } as Env;
    const checked = await validateAdminApiToken(other, db, minted.secret, NOW);
    expect(checked).toEqual({ ok: false, reason: "unknown" });
  });

  it("serves the mint with no-store, since it carries the plaintext", async () => {
    const { db, env, auth } = await world();
    const res = await dispatch(
      mkReq("POST", "/api/tokens", {
        ...auth,
        body: { label: "CI", expiresInDays: 30 },
      }),
      env,
      db,
      "/api/tokens",
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
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
    expect(ok.body.token?.expiresAt).toBe(NOW + DAY);
    const longest = await mint(env, db, auth, {
      label: "x",
      expiresInDays: MAX_TOKEN_DAYS,
    });
    expect(longest.status).toBe(201);
  });

  it("refuses a label or a scope it does not recognise", async () => {
    const { db, env, auth } = await world();
    const noLabel = await mint(env, db, auth, {
      label: "  ",
      expiresInDays: 30,
    });
    expect(noLabel.status).toBe(422);
    expect(noLabel.body.fields).toContain("label");

    const longLabel = await mint(env, db, auth, {
      label: "x".repeat(201),
      expiresInDays: 30,
    });
    expect(longLabel.status).toBe(422);

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
    // None of the refusals wrote a row.
    expect(await db.all("SELECT id FROM admin_api_tokens")).toEqual([]);
  });

  it("refuses a malformed body as a request error, not a 500", async () => {
    const { db, env, auth } = await world();
    const res = await dispatch(
      mkReq("POST", "/api/tokens", { ...auth, rawBody: "{not json" }),
      env,
      db,
      "/api/tokens",
    );
    expect(res.status).toBe(400);
  });

  it("holds at most MAX_ADMIN_API_TOKENS live tokens, counting neither revoked nor expired ones", async () => {
    const { db, env, auth } = await world();
    for (let i = 0; i < MAX_ADMIN_API_TOKENS; i++)
      await plant(env, db, { id: `apitok_live${i}` });
    // Dead rows do not count against the ceiling.
    await plant(env, db, { id: "apitok_dead1", revokedAt: NOW - 1 });
    await plant(env, db, { id: "apitok_dead2", expiresAt: NOW - 1 });
    const refused = await mint(env, db, auth);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain(String(MAX_ADMIN_API_TOKENS));
    // Revoking one frees a slot.
    const path = "/api/tokens/apitok_live0";
    expect(
      (await dispatch(mkReq("DELETE", path, auth), env, db, path)).status,
    ).toBe(200);
    expect((await mint(env, db, auth)).status).toBe(201);
  });

  it("revokes by id, keeps the row, and refuses a second revoke", async () => {
    const { db, env, auth } = await world();
    const minted = await mint(env, db, auth);
    const path = `/api/tokens/${minted.id}`;
    const first = await dispatch(mkReq("DELETE", path, auth), env, db, path);
    expect(first.status).toBe(200);
    expect((await answer(first)).token?.status).toBe("revoked");

    const second = await dispatch(mkReq("DELETE", path, auth), env, db, path);
    expect(second.status).toBe(409);

    // The row survives revocation: that history IS the lifecycle record.
    const listRes = await dispatch(
      mkReq("GET", "/api/tokens", auth),
      env,
      db,
      "/api/tokens",
    );
    const listed = await answer(listRes);
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens?.[0]?.revokedAt).toBe(NOW);
    expect(listed.tokens?.[0]?.status).toBe("revoked");
  });

  it("404s an unknown id", async () => {
    const { db, env, auth } = await world();
    const path = "/api/tokens/apitok_nope";
    const res = await dispatch(mkReq("DELETE", path, auth), env, db, path);
    expect(res.status).toBe(404);
  });

  it("answers the route table's 405 and 404 for the wrong verb and an extra segment", async () => {
    const { db, env, auth } = await world();
    const wrongVerb = await dispatch(
      mkReq("DELETE", "/api/tokens", auth),
      env,
      db,
      "/api/tokens",
    );
    expect(wrongVerb.status).toBe(405);
    expect(wrongVerb.headers.get("allow")).toBe("GET, POST");
    const onId = await dispatch(
      mkReq("GET", "/api/tokens/apitok_x", auth),
      env,
      db,
      "/api/tokens/apitok_x",
    );
    expect(onId.status).toBe(405);
    const deeper = await dispatch(
      mkReq("DELETE", "/api/tokens/apitok_x/extra", auth),
      env,
      db,
      "/api/tokens/apitok_x/extra",
    );
    expect(deeper.status).toBe(404);
  });

  it("keeps the session gates: 401 unauthenticated, 403 off-group, 403 without CSRF", async () => {
    const { db, env, auth } = await world();
    expect(
      (await dispatch(mkReq("GET", "/api/tokens"), env, db, "/api/tokens"))
        .status,
    ).toBe(401);

    const outsider = await session(env, {
      groups: ["some-other-group"],
      stepUp: true,
    });
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
    expect(await db.all("SELECT id FROM admin_api_tokens")).toEqual([]);
  });

  it("needs a proven sign-in to mint, and nothing but a session to list or revoke", async () => {
    const { db, env } = await world();
    const ordinary = await session(env);
    const refused = await mint(env, db, ordinary);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("step_up_required");
    expect(refused.body.maxAgeSeconds).toBe(300);
    // The step-up answers before the body is read: a bad body is still its 403, not a 422.
    const early = await mint(env, db, ordinary, { label: "" });
    expect(early.body.code).toBe("step_up_required");
    expect(await db.all("SELECT id FROM admin_api_tokens")).toEqual([]);

    // A step-up from six minutes ago is past the window.
    const { token, session: stale } = await issueSession(
      env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: [PLATFORM_GROUP],
        authTime: NOW - 6 * 60,
        stepUp: true,
      },
      NOW - 6 * 60,
    );
    const lapsed = await mint(env, db, {
      cookie: `${ADMIN_COOKIE}=${token}`,
      csrf: stale.csrf,
    });
    expect(lapsed.body.code).toBe("step_up_required");

    const fresh = await mint(env, db, await session(env, { stepUp: true }));
    expect(fresh.status).toBe(201);

    // Listing and revoking narrow nothing and widen nothing: an ordinary sign-in is enough.
    const list = await dispatch(
      mkReq("GET", "/api/tokens", ordinary),
      env,
      db,
      "/api/tokens",
    );
    expect(list.status).toBe(200);
    const path = `/api/tokens/${fresh.id}`;
    expect(
      (await dispatch(mkReq("DELETE", path, ordinary), env, db, path)).status,
    ).toBe(200);
  });

  it("records the mint and the revoke in the platform audit log, attributed to the operator and never carrying the secret", async () => {
    const { db, env, auth } = await world();
    const minted = await mint(env, db, auth);
    const path = `/api/tokens/${minted.id}`;
    await dispatch(mkReq("DELETE", path, auth), env, db, path);

    const rows = await platformAuditRows(db);
    // Both rows share one second, so their order is the random id's: look each up by action.
    expect(rows.map((r) => r.action).sort()).toEqual([
      "api_token.create",
      "api_token.revoke",
    ]);
    const create = rows.find((r) => r.action === "api_token.create")!;
    const revoke = rows.find((r) => r.action === "api_token.revoke")!;
    for (const row of rows) {
      expect(row.actor_sub).toBe("u1");
      expect(row.target_kind).toBe("api_token");
      expect(row.target_id).toBe(minted.id);
    }
    expect(create.summary).toContain("CI");
    expect(create.summary).toContain("bundles:mint");
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(minted.secret);
    expect(everything).not.toContain(minted.secret.slice("pkeya_".length));
    expect(everything).not.toContain(
      await hashKey(minted.secret, env.KEY_HASH_PEPPER),
    );
    expect(JSON.parse(create.after_json!)).toMatchObject({
      id: minted.id,
      status: "active",
    });
    expect(JSON.parse(revoke.before_json!).status).toBe("active");
    expect(JSON.parse(revoke.after_json!).status).toBe("revoked");
  });
});

// ── authentication ───────────────────────────────────────────────────────────

describe("token authentication", () => {
  it("authenticates a bundle mint with no cookie and no CSRF header", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    const res = await mintBundle(env, db, licenseId, { bearer: minted.secret });
    expect(res.status).toBe(200);
    const bundle = await answer(res);
    expect(bundle.bundleId).toBeTruthy();
    expect(bundle.bundle?.split(".")).toHaveLength(3);
  });

  it("stamps last_used_at", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    await mintBundle(env, db, licenseId, { bearer: minted.secret });
    const row = await db.first<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM admin_api_tokens WHERE id = ?",
      minted.id,
    );
    expect(row?.last_used_at).toBe(NOW);
  });

  it("audits every use, attributed to the TOKEN and not to the operator who minted it", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    await mintBundle(env, db, licenseId, { bearer: minted.secret });
    const rows = await listAudit(db, SLUG, { limit: 20 });
    const use = rows.find((r) => r.action === "api_token.used");
    expect(use, "no api_token.used row").toBeTruthy();
    expect(use!.actor_sub).toBe(`token:${minted.id}`);
    expect(use!.actor_sub).not.toBe("u1");
    expect(use!.actor_name).toBe("CI");
    expect(use!.target_kind).toBe("api_token");
    expect(use!.target_id).toBe(minted.id);
    expect(use!.summary).toContain("bundles:mint");
    expect(use!.summary).toContain(`POST ${bundlePath.slice("/api".length)}`);
    // …and the mint the token performed is still audited under the same actor, so the two rows
    // read as one story rather than as an anonymous mint next to a credential use.
    const bundle = rows.find((r) => r.action === "bundle.minted");
    expect(bundle?.actor_sub).toBe(`token:${minted.id}`);
  });

  it("audits a use before the handler runs, so a use the handler refuses is still on record", async () => {
    const { db, env, auth } = await world();
    const minted = await mint(env, db, auth);
    // A bundle request the handler answers 4xx (no such licence): the credential was exercised.
    const res = await dispatch(
      mkReq("POST", bundlePath, {
        bearer: minted.secret,
        body: { ...bundleBody, licenseId: "lic_nope" },
      }),
      env,
      db,
      bundlePath,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const rows = await listAudit(db, SLUG, { limit: 20 });
    expect(rows.filter((r) => r.action === "api_token.used")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "bundle.minted")).toHaveLength(0);
  });

  it("refuses a revoked token", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    const revokePath = `/api/tokens/${minted.id}`;
    await dispatch(mkReq("DELETE", revokePath, auth), env, db, revokePath);
    const res = await mintBundle(env, db, licenseId, { bearer: minted.secret });
    expect(res.status).toBe(401);
  });

  it("refuses an expired token", async () => {
    const { db, env, licenseId } = await world();
    const secret = await plant(env, db, { expiresAt: NOW - 1 });
    const res = await mintBundle(env, db, licenseId, { bearer: secret });
    expect(res.status).toBe(401);
  });

  it("answers every refusal with the same single 401", async () => {
    const { db, env, auth, licenseId } = await world();
    const revoked = await plant(env, db, {
      id: "apitok_revoked",
      revokedAt: NOW - 1,
    });
    const expired = await plant(env, db, {
      id: "apitok_expired",
      expiresAt: NOW - 1,
    });
    const broken = mintAdminApiToken();
    await db.run(
      `INSERT INTO admin_api_tokens (id, token_hash, label, scopes_json, created_at, expires_at)
       VALUES ('apitok_broken', ?, 'broken', '{not json', ?, ?)`,
      await hashKey(broken, env.KEY_HASH_PEPPER),
      NOW - DAY,
      NOW + DAY,
    );
    const bodies = new Set<string>();
    for (const bearer of [
      revoked,
      expired,
      broken,
      mintAdminApiToken(),
      "pkeya_short",
      "not-a-token",
      auth.cookie.split("=").slice(1).join("="),
    ]) {
      const res = await mintBundle(env, db, licenseId, { bearer });
      expect(res.status, bearer.slice(0, 12)).toBe(401);
      bodies.add(await res.text());
    }
    expect([...bodies]).toHaveLength(1);
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

  it("treats any Bearer header as a presentation, even an empty one, and no other scheme as one", async () => {
    const { db, env, auth } = await world();
    for (const authorization of [
      "Bearer",
      "Bearer ",
      "bearer  ",
      "Bearer a b",
    ]) {
      const res = await dispatch(
        mkReq("GET", "/api/me", { ...auth, authorization }),
        env,
        db,
        "/api/me",
      );
      expect(res.status, authorization).toBe(401);
    }
    // A different scheme is not a token presentation: the cookie authenticates as it always did.
    const basic = await dispatch(
      mkReq("GET", "/api/me", { ...auth, authorization: "Basic dTpw" }),
      env,
      db,
      "/api/me",
    );
    expect(basic.status).toBe(200);
    expect(presentedToken(mkReq("GET", "/api/me"))).toBeNull();
    expect(
      presentedToken(mkReq("GET", "/api/me", { authorization: "Bearerx" })),
    ).toBeNull();
    expect(
      presentedToken(mkReq("GET", "/api/me", { authorization: "BEARER  t" })),
    ).toBe("t");
  });

  it("a token wins over a live cookie: the request runs as the token, scoped and audited", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    // With a good session cookie AND a good token, the token decides: `/me` is out of its scope.
    const asToken = await dispatch(
      mkReq("GET", "/api/me", { ...auth, bearer: minted.secret }),
      env,
      db,
      "/api/me",
    );
    expect(asToken.status).toBe(403);
    // …and on its own route the audit names the token, not the session's operator.
    await mintBundle(env, db, licenseId, { ...auth, bearer: minted.secret });
    const use = (await listAudit(db, SLUG, { limit: 20 })).find(
      (r) => r.action === "api_token.used",
    );
    expect(use?.actor_sub).toBe(`token:${minted.id}`);
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
    expect(auth).toEqual({ ok: false, reason: "unusable" });
    // A refused credential is not a use: nothing is stamped.
    const row = await db.first<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM admin_api_tokens WHERE id = 'apitok_broken'",
    );
    expect(row?.last_used_at).toBeNull();
  });

  it("names each refusal reason, for the suite and not for the caller", async () => {
    const { db, env } = await world();
    const revoked = await plant(env, db, { id: "apitok_r", revokedAt: NOW });
    const expired = await plant(env, db, { id: "apitok_e", expiresAt: NOW });
    const live = await plant(env, db, { id: "apitok_l" });
    expect(await validateAdminApiToken(env, db, "nope", NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      await validateAdminApiToken(env, db, mintAdminApiToken(), NOW),
    ).toEqual({ ok: false, reason: "unknown" });
    expect(await validateAdminApiToken(env, db, revoked, NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(await validateAdminApiToken(env, db, expired, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
    const ok = await validateAdminApiToken(env, db, live, NOW);
    expect(ok.ok && ok.scopes).toEqual(["bundles:mint"]);
  });

  it("authorises nothing when the deployment has configured no platform-admin group", async () => {
    // The session path fails closed on a missing PLATFORM_ADMIN_GROUP (`core/rbac/principal.ts`);
    // the token path must not be the exception that quietly grants authority instead.
    const { db, env, licenseId } = await world();
    const secret = await plant(env, db);
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

    // Through the dispatcher: the token is live and in scope, and still reaches nothing.
    const res = await mintBundle(env, db, licenseId, { bearer: secret });
    expect(res.status).toBe(403);
    expect((await answer(res)).error?.reason).toBe("no_access");
    expect(await listAudit(db, SLUG, { limit: 20 })).toMatchObject([
      { action: "access.denied", actor_sub: "token:apitok_planted" },
    ]);
  });

  it("carries the platform-admin group when one is configured, so the principal is the root rule's", () => {
    const env = adminEnv();
    const s = tokenSession(env, {
      id: "apitok_x",
      token_hash: "h",
      label: "CI",
      scopes_json: "[]",
      created_at: NOW,
      expires_at: NOW + DAY,
      last_used_at: null,
      revoked_at: null,
    });
    expect(s).toMatchObject({
      sub: "token:apitok_x",
      name: "CI",
      email: "",
      groups: [PLATFORM_GROUP],
      csrf: "",
      exp: NOW + DAY,
    });
    expect(s.stepUpAt).toBeUndefined();
  });

  it("is rate limited per token, and that budget is neither a session's nor another token's", async () => {
    const { db, env, auth, licenseId } = await world();
    const a = await plant(env, db, { id: "apitok_a" });
    const b = await plant(env, db, { id: "apitok_b" });
    for (let i = 0; i < 600; i++)
      await rateLimitOk(
        env,
        "_admin",
        {
          bucket: "adminApi",
          id: "token:apitok_a",
          limit: 600,
          windowSec: 60,
        },
        NOW,
      );
    const limited = await mintBundle(env, db, licenseId, { bearer: a });
    expect(limited.status).toBe(429);
    expect((await mintBundle(env, db, licenseId, { bearer: b })).status).toBe(
      200,
    );
    expect(
      (await dispatch(mkReq("GET", "/api/me", auth), env, db, "/api/me"))
        .status,
    ).toBe(200);
  });
});

// ── scopes: default deny ─────────────────────────────────────────────────────

describe("scope confinement", () => {
  const tokenRows = ADMIN_ROUTES.filter((r) => r.tokenScope);

  it("names a scope on the bundle mint row and the three read-side migration rows, and on no other", () => {
    expect(tokenRows.map((r) => `${routeKey(r)} → ${r.tokenScope}`)).toEqual([
      "GET /platform/migrations → migrations:report",
      "GET /platform/migrations/runs/:id → migrations:report",
      "POST /platform/migrations/dry-run → migrations:report",
      "POST /products/:slug/bundles → bundles:mint",
    ]);
  });

  it("names only scopes the vocabulary knows, and none on a row that needs a step-up", () => {
    for (const r of tokenRows) {
      expect(ADMIN_API_SCOPES, routeKey(r)).toContain(r.tokenScope);
      expect(r.stepUp, routeKey(r)).toBeUndefined();
    }
  });

  it("a migrations:report token reaches the migration read side and dry run, never apply, down or a bundle", async () => {
    const { db, env } = await world();
    const secret = await plant(env, db, { scopes: ["migrations:report"] });
    const call = async (method: string, path: string, body?: unknown) =>
      (
        await dispatch(
          mkReq(method, path, { bearer: secret, ...(body ? { body } : {}) }),
          env,
          db,
          path,
        )
      ).status;
    expect(await call("GET", "/api/platform/migrations")).toBe(200);
    expect(await call("GET", "/api/platform/migrations/runs/none")).toBe(404);
    expect(
      await call("POST", "/api/platform/migrations/dry-run", { job: "nope" }),
    ).toBe(404);
    for (const verb of ["apply", "down"])
      expect(
        await call("POST", `/api/platform/migrations/${verb}`, { job: "x" }),
        verb,
      ).toBe(403);
    expect(await call("POST", bundlePath, bundleBody)).toBe(403);
    // A bundles:mint token does not reach the migrations.
    const mintOnly = await plant(env, db, {
      id: "apitok_mint",
      scopes: ["bundles:mint"],
    });
    const res = await dispatch(
      mkReq("GET", "/api/platform/migrations", { bearer: mintOnly }),
      env,
      db,
      "/api/platform/migrations",
    );
    expect(res.status).toBe(403);
    // The reads were audited as token use.
    const used = (await platformAuditRows(db)).filter(
      (r) => r.action === "api_token.used",
    );
    expect(used.length).toBeGreaterThanOrEqual(3);
  });

  it("names no scope on the token roster, so no token can reach it", () => {
    const roster = ADMIN_ROUTES.filter((r) => r.path.startsWith("/tokens"));
    expect(roster.map(routeKey).sort()).toEqual([
      "DELETE /tokens/:id",
      "GET /tokens",
      "POST /tokens",
    ]);
    for (const r of roster) expect(r.tokenScope, routeKey(r)).toBeUndefined();
  });

  it("refuses a token on a route outside its scopes, a path no row matches, and a verb no row serves", async () => {
    const { db, env } = await world();
    // A live, well-formed token whose scope list simply does not cover the route.
    const secret = await plant(env, db, { scopes: ["bundles:mint"] });
    const bodies = new Set<string>();
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["POST", "/api/logout"],
      ["GET", "/api/products"],
      ["POST", "/api/products"],
      ["DELETE", `/api/products/${SLUG}`],
      ["GET", `/api/products/${SLUG}/activity`],
      ["GET", `/api/products/${SLUG}/keys`],
      ["POST", `/api/products/${SLUG}/license/licenses`],
      ["GET", "/api/platform/version"],
      // The bundle path with another verb, and with another depth.
      ["GET", bundlePath],
      ["PUT", bundlePath],
      ["POST", `${bundlePath}/extra`],
      // A path no row matches at all, and the admin API root.
      ["GET", "/api/no-such-thing"],
      ["GET", "/api"],
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
      const text = await res.text();
      expect(JSON.parse(text).message).toContain("scoped");
      bodies.add(text);
    }
    // One body for all of them: the refusal reveals nothing about what exists.
    expect([...bodies]).toHaveLength(1);
  });

  it("refuses a token on the token surface itself: no token mints a token", async () => {
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
          ...(method === "GET"
            ? {}
            : { body: { label: "x", expiresInDays: 30 } }),
        }),
        env,
        db,
        path,
      );
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // …and the row it could not revoke is still live, and nothing was minted.
    const row = await db.first<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM admin_api_tokens WHERE id = 'apitok_planted'",
    );
    expect(row?.revoked_at).toBeNull();
    expect(await db.all("SELECT id FROM admin_api_tokens")).toHaveLength(1);
  });

  it("refuses a token a step-up row even if a scope were ever named on one", async () => {
    // The dispatcher's step-up gate reads the session, and a token session has no step-up.
    const { db, env } = await world();
    const secret = await plant(env, db);
    const path = `/api/products/${SLUG}`;
    const res = await dispatch(
      mkReq("DELETE", path, { bearer: secret }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(403);
    expect(
      await db.first("SELECT slug FROM products WHERE slug = ?", SLUG),
    ).toBeTruthy();
  });

  it("writes no audit row for a use it refused", async () => {
    const { db, env } = await world();
    const secret = await plant(env, db);
    const path = `/api/products/${SLUG}/activity`;
    await dispatch(mkReq("GET", path, { bearer: secret }), env, db, path);
    const rows = await listAudit(db, SLUG, { limit: 20 });
    expect(rows.filter((r) => r.action === "api_token.used")).toEqual([]);
  });

  it("answers a scoped call on a product that does not exist as a 404, and audits nothing", async () => {
    // The audit table is keyed by product, so a use is written only once the product is known to
    // exist: an unknown slug is a clean 404, not a foreign-key failure.
    const { db, env } = await world();
    const secret = await plant(env, db);
    const path = "/api/products/no-such-product/bundles";
    const res = await dispatch(
      mkReq("POST", path, { bearer: secret, body: bundleBody }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(404);
    expect(await db.all("SELECT id FROM audit")).toEqual([]);
  });

  it("audits a use of a platform-scoped row in the platform log", async () => {
    // No row names a scope that is platform-scoped today; the audit writer still has to answer
    // for one, so a `tokenScope` added to such a row is audited with no second decision.
    const { db, env } = await world();
    await plant(env, db);
    const row = (await db.first<AdminApiTokenRow>(
      "SELECT * FROM admin_api_tokens",
    ))!;
    await auditTokenUse(
      db,
      row,
      tokenSession(env, row),
      {
        scope: "bundles:mint",
        method: "POST",
        path: "/platform/example",
        product: null,
      },
      NOW,
    );
    const rows = await platformAuditRows(db);
    expect(rows).toMatchObject([
      {
        action: "api_token.used",
        actor_sub: "token:apitok_planted",
        target_kind: "api_token",
        target_id: "apitok_planted",
      },
    ]);
  });
});

// ── no other door ────────────────────────────────────────────────────────────

describe("a token opens nothing but the admin API", () => {
  it("is not a credential at the docs gate", async () => {
    const { db, env, auth } = await world();
    const minted = await mint(env, db, auth);
    const path = "https://key.plrs.im/docs/operate/platform/runbook/";
    const anonymous = await handleDocs(new Request(path), env, NOW);
    const withToken = await handleDocs(
      new Request(path, {
        headers: { authorization: `Bearer ${minted.secret}` },
      }),
      env,
      NOW,
    );
    expect(anonymous.status).toBe(302);
    expect(withToken.status).toBe(anonymous.status);
    expect(withToken.headers.get("location")).toBe(
      anonymous.headers.get("location"),
    );
  });

  it("is validated by the admin dispatcher alone", () => {
    // A second caller of `validateAdminApiToken` would be a route that authenticates on its own,
    // beside the route table (and its scope gate) instead of through it.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, "..", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory()
          ? walk(full)
          : name.endsWith(".ts")
            ? [full]
            : [];
      });
    const callers: Record<string, number> = {};
    for (const file of walk(src)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const n = (code.match(/\bvalidateAdminApiToken\s*\(/g) ?? []).length;
      if (n) callers[relative(src, file)] = n;
    }
    expect(callers).toEqual({
      "console/api.ts": 1,
      // The definition.
      "console/apiTokens.ts": 1,
    });
  });
});

// ── the CSRF pair ────────────────────────────────────────────────────────────

describe("CSRF: exempt for tokens, still enforced for sessions", () => {
  it("a token-authenticated mutation needs no CSRF header", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    const res = await mintBundle(env, db, licenseId, { bearer: minted.secret });
    expect(res.status).toBe(200);
  });

  it("a SESSION-authenticated mutation on the same route still does", async () => {
    const { db, env, auth, licenseId } = await world();
    const without = await mintBundle(env, db, licenseId, {
      cookie: auth.cookie,
    });
    expect(without.status).toBe(403);
    expect((await answer(without)).message).toBe("csrf");

    const withHeader = await mintBundle(env, db, licenseId, { ...auth });
    expect(withHeader.status).toBe(200);
  });

  it("a token never carries a CSRF value, so removing the exemption would fail closed", async () => {
    const { db, env, auth } = await world();
    const minted = await mint(env, db, auth);
    const row = (await db.first<AdminApiTokenRow>(
      "SELECT * FROM admin_api_tokens WHERE id = ?",
      minted.id,
    ))!;
    // The dispatcher refuses a missing or blank header outright and compares anything else with
    // the session's `csrf`: an empty string, which no non-empty header can equal.
    expect(tokenSession(env, row).csrf).toBe("");
  });

  it("a session's own CSRF token cannot be replayed as a bearer credential", async () => {
    const { db, env, auth, licenseId } = await world();
    const res = await mintBundle(env, db, licenseId, { bearer: auth.csrf });
    expect(res.status).toBe(401);
  });

  it("a token's header, were it sent, buys a session nothing: the cookie alone is still refused", async () => {
    const { db, env, auth, licenseId } = await world();
    const minted = await mint(env, db, auth);
    const res = await dispatch(
      mkReq("POST", bundlePath, {
        cookie: auth.cookie,
        csrf: minted.secret,
        body: { ...bundleBody, licenseId },
      }),
      env,
      db,
      bundlePath,
    );
    expect(res.status).toBe(403);
  });
});
