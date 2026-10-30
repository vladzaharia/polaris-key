/**
 * ST-34.4: the caller's own personal tokens (`/me/personal-tokens`, `current`), the listing-import
 * row, and the 34.3 review's fold-ins (use-row budget, per-member cap, `last_used_at` only on an
 * accepted request, `verifySession` dropping `tokenId`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bindAdminFlow } from "../../flowBinderHelper.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../../../src/console/auth.js";
import { resetConsoleSessionCache } from "../../../src/console/consoleSession.js";
import { forgeV1Cookie } from "../../consoleSessionHelper.js";
import { ADMIN_ROUTES } from "../../../src/console/routes.js";
import { routeKey } from "../../../src/console/routeMatch.js";
import { rateLimitOk } from "../../../src/core/rateLimit.js";
import {
  ADMIN_SCOPE,
  PACKAGES_READ_SCOPE,
  mintAccountToken,
} from "../../../src/core/accounts/personalTokens.js";
import {
  newBindingId,
  stmtInsertBinding,
} from "../../../src/core/rbac/bindings.js";
import type { AreaId } from "../../../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../../../src/core/rbac/can.js";
import { memberIdFor } from "../../../src/core/console/memberId.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const T = NOW + 10;

type Db = ReturnType<typeof makeTestDb>;

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.KEY_HASH_PEPPER = "test-pepper";
  return env;
}

/** Sign in through the real gate; drop the stored groups unless `keepRoot`. Returns the account id. */
async function person(
  env: Env,
  db: Db,
  who: string,
  opts: { keepRoot?: boolean } = {},
): Promise<string> {
  return (await signedIn(env, db, who, opts)).aid;
}

/** Sign in through the real gate; the account id and the v2 cookie (`name=value`). */
async function signedIn(
  env: Env,
  db: Db,
  who: string,
  opts: { keepRoot?: boolean } = {},
): Promise<{ aid: string; cookie: string }> {
  const start = await handleAdminLogin(
    new Request("https://key.plrs.im/manage/login?go=1") as unknown as Request,
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: `idp-${who}`,
      email: `${who}@example.com`,
      emailVerified: true,
      name: who,
      groups: [GROUP],
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie: await bindAdminFlow(env, state) },
    }) as unknown as Request,
    env,
    db,
    NOW,
    verifier,
  );
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const raw = cookie.slice(cookie.indexOf("=") + 1);
  const { aid } = JSON.parse(
    Buffer.from(raw.split(".")[0]!, "base64url").toString("utf8"),
  ) as { aid: string };
  if (!opts.keepRoot)
    await db.run(
      "UPDATE account_links SET groups_json = '[]' WHERE account_id = ?",
      aid,
    );
  return { aid, cookie };
}

async function bind(
  db: Db,
  accountId: string,
  role: Role,
  scope: GrantScope,
  areas: AreaId[] | null,
): Promise<string> {
  const id = newBindingId();
  const s = stmtInsertBinding({
    id,
    accountId,
    emailNorm: null,
    role,
    scope,
    areas,
    source: "grant",
    grantedBy: null,
    grantedAt: NOW - 10,
  });
  await db.run(s.sql, ...s.params);
  return id;
}

/** Mint a real token row of `scope` for the account; returns the plaintext. */
async function mint(
  env: Env,
  db: Db,
  accountId: string,
  scope: string = ADMIN_SCOPE,
  label = "my laptop",
): Promise<string> {
  const res = await mintAccountToken(
    env,
    db,
    { accountId, label, scope, createdBy: `admin:${accountId}` },
    NOW,
  );
  if (!res.ok) throw new Error("mint");
  return res.token;
}

function call(
  env: Env,
  db: Db,
  bearer: string | null,
  method: string,
  path: string,
  body?: unknown,
  now = T,
): Promise<Response> {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    env,
    db,
    path,
    { now },
  );
}

type Refusal = {
  error?: { code?: string; reason?: string; area?: string };
};
const refusal = async (res: Response) => ((await res.json()) as Refusal).error;

/** A cookie-session request; `csrf` is sent on mutations. */
function sess(
  env: Env,
  db: Db,
  cookie: string,
  csrf: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie,
        ...(csrf !== null ? { "x-pkey-csrf": csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    env,
    db,
    path,
    { now: T },
  );
}

async function csrfOf(env: Env, db: Db, cookie: string): Promise<string> {
  const res = await sess(env, db, cookie, null, "GET", "/api/me");
  return ((await res.json()) as { csrf: string }).csrf;
}

type Tok = { id: string; scope: string; status: string; label: string };
const MINE = "/api/me/personal-tokens";
const idOf = async (db: Db, aid: string, label: string) =>
  (await db.first<{ id: string }>(
    "SELECT id FROM account_tokens WHERE account_id = ? AND label = ?",
    aid,
    label,
  ))!.id;

let env: Env;
let db: Db;

beforeEach(async () => {
  resetConsoleSessionCache();
  env = adminEnv();
  db = makeTestDb();
  await seedProduct(db, "alpha");
});

describe("GET /me/personal-tokens", () => {
  it("lists only the caller's tokens, both scopes, with no account id, hash, plaintext or revoker", async () => {
    const ann = await signedIn(env, db, "ann");
    const bob = await signedIn(env, db, "bob");
    await bind(db, ann.aid, "platform_admin", "platform", null);
    await bind(db, bob.aid, "platform_admin", "platform", null);
    const a1 = await mint(env, db, ann.aid, ADMIN_SCOPE, "ann cli");
    const a2 = await mint(env, db, ann.aid, PACKAGES_READ_SCOPE, "ann pkgs");
    const b1 = await mint(env, db, bob.aid, ADMIN_SCOPE, "bob cli");
    const res = await sess(env, db, ann.cookie, null, "GET", MINE);
    expect(res.status).toBe(200);
    const text = await res.text();
    const { tokens } = JSON.parse(text) as { tokens: Tok[] };
    expect(tokens.map((t) => t.label).sort()).toEqual(["ann cli", "ann pkgs"]);
    expect(tokens.map((t) => t.scope).sort()).toEqual([
      ADMIN_SCOPE,
      PACKAGES_READ_SCOPE,
    ]);
    for (const secret of [
      ann.aid,
      bob.aid,
      a1,
      a2,
      b1,
      "revokedBy",
      "token_hash",
    ])
      expect(text).not.toContain(secret);
    expect(tokens[0]).toMatchObject({ status: "active" });
  });

  it("a v1 cookie is no session: 401 for the list and the revoke (ST-30c.8)", async () => {
    const v1 = await forgeV1Cookie(
      env,
      { sub: "idp-v1", groups: [GROUP] },
      NOW,
    );
    for (const [m, p] of [
      ["GET", MINE],
      ["DELETE", `${MINE}/ptok_x`],
    ] as const) {
      const res = await sess(env, db, v1.cookie, v1.csrf, m, p);
      expect(res.status, `${m} ${p}`).toBe(401);
    }
  });

  it("a token, personal or packages, cannot list its siblings", async () => {
    const aid = await person(env, db, "lst");
    await bind(db, aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, aid);
    expect((await call(env, db, tok, "GET", MINE)).status).toBe(403);
    const pk = await mint(env, db, aid, PACKAGES_READ_SCOPE, "pk");
    expect((await call(env, db, pk, "GET", MINE)).status).toBe(401);
  });
});

describe("DELETE /me/personal-tokens/:id", () => {
  it("revokes the caller's own, audited once with the member as actor; a repeat writes no second row", async () => {
    const ann = await signedIn(env, db, "ann");
    await bind(db, ann.aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, ann.aid, ADMIN_SCOPE, "ann cli");
    const id = await idOf(db, ann.aid, "ann cli");
    const csrf = await csrfOf(env, db, ann.cookie);
    const res = await sess(
      env,
      db,
      ann.cookie,
      csrf,
      "DELETE",
      `${MINE}/${id}`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).token).toMatchObject({
      id,
      status: "revoked",
      revokeReason: "manual",
    });
    expect(text).not.toContain(ann.aid);
    expect(text).not.toContain("revokedBy");
    expect((await call(env, db, tok, "GET", "/api/me")).status).toBe(401);
    await sess(env, db, ann.cookie, csrf, "DELETE", `${MINE}/${id}`);
    const rows = await db.all<Record<string, string>>(
      "SELECT * FROM platform_audit WHERE action = 'account_token.revoke'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_sub).toBe(await memberIdFor(env, ann.aid));
    expect(rows[0]!.target_id).toBe(id);
    const all = JSON.stringify(rows[0]);
    for (const secret of [tok, ann.aid]) expect(all).not.toContain(secret);
    expect(rows[0]!.summary).toContain(`…${tok.slice(-4)}`);
  });

  it("another account's id is 404 and the token is untouched (IDOR), also for a made-up id", async () => {
    const ann = await signedIn(env, db, "ann");
    const bob = await signedIn(env, db, "bob");
    await bind(db, ann.aid, "platform_admin", "platform", null);
    await bind(db, bob.aid, "platform_admin", "platform", null);
    const bobTok = await mint(env, db, bob.aid, ADMIN_SCOPE, "bob cli");
    const bobId = await idOf(db, bob.aid, "bob cli");
    const csrf = await csrfOf(env, db, ann.cookie);
    for (const id of [bobId, "ptok_nope", "current"]) {
      const res = await sess(
        env,
        db,
        ann.cookie,
        csrf,
        "DELETE",
        `${MINE}/${id}`,
      );
      // `current` is its own row: a session is refused there, never a revoke.
      expect(res.status, id).toBe(id === "current" ? 403 : 404);
    }
    expect((await call(env, db, bobTok, "GET", "/api/me")).status).toBe(200);
    expect(
      (await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'account_token.revoke'",
      ))!.n,
    ).toBe(0);
  });

  it("needs the CSRF header, and a token cannot call it", async () => {
    const ann = await signedIn(env, db, "ann");
    await bind(db, ann.aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, ann.aid, ADMIN_SCOPE, "ann cli");
    const id = await idOf(db, ann.aid, "ann cli");
    expect(
      (await sess(env, db, ann.cookie, null, "DELETE", `${MINE}/${id}`)).status,
    ).toBe(403);
    expect((await call(env, db, tok, "DELETE", `${MINE}/${id}`)).status).toBe(
      403,
    );
    expect((await call(env, db, tok, "GET", "/api/me")).status).toBe(200);
  });

  it("revokes a packages:read token and drops it from the registry cache path (reason manual)", async () => {
    const ann = await signedIn(env, db, "ann");
    await bind(db, ann.aid, "platform_admin", "platform", null);
    await mint(env, db, ann.aid, PACKAGES_READ_SCOPE, "pk");
    const id = await idOf(db, ann.aid, "pk");
    const csrf = await csrfOf(env, db, ann.cookie);
    expect(
      (await sess(env, db, ann.cookie, csrf, "DELETE", `${MINE}/${id}`)).status,
    ).toBe(200);
    const row = await db.first<{ revoked_at: number; revoke_reason: string }>(
      "SELECT revoked_at, revoke_reason FROM account_tokens WHERE id = ?",
      id,
    );
    expect(row!.revoke_reason).toBe("manual");
  });
});

describe("a session whose holder has no grant (34.4 review)", () => {
  it("finds and revokes its own tokens, and still nothing else", async () => {
    const nog = await signedIn(env, db, "nog");
    const other = await signedIn(env, db, "oth");
    await mint(env, db, nog.aid, ADMIN_SCOPE, "mine");
    await mint(env, db, other.aid, ADMIN_SCOPE, "theirs");
    const csrf = await csrfOf(env, db, nog.cookie);
    const list = await sess(env, db, nog.cookie, null, "GET", MINE);
    expect(list.status).toBe(200);
    const { tokens } = (await list.json()) as { tokens: Tok[] };
    expect(tokens.map((t) => t.label)).toEqual(["mine"]);
    // Another account's token is still a 404, and a product route is still a 403.
    const theirs = await idOf(db, other.aid, "theirs");
    expect(
      (await sess(env, db, nog.cookie, csrf, "DELETE", `${MINE}/${theirs}`))
        .status,
    ).toBe(404);
    expect(
      (await sess(env, db, nog.cookie, null, "GET", "/api/products")).status,
    ).toBe(403);
    const id = await idOf(db, nog.aid, "mine");
    const res = await sess(
      env,
      db,
      nog.cookie,
      csrf,
      "DELETE",
      `${MINE}/${id}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: { status: "revoked" } });
  });

  it("two concurrent revokes of one token write one audit row", async () => {
    const ann = await signedIn(env, db, "ann");
    await bind(db, ann.aid, "platform_admin", "platform", null);
    await mint(env, db, ann.aid, ADMIN_SCOPE, "race");
    const id = await idOf(db, ann.aid, "race");
    const csrf = await csrfOf(env, db, ann.cookie);
    const both = await Promise.all([
      sess(env, db, ann.cookie, csrf, "DELETE", `${MINE}/${id}`),
      sess(env, db, ann.cookie, csrf, "DELETE", `${MINE}/${id}`),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const rows = await db.all(
      "SELECT 1 FROM platform_audit WHERE action = 'account_token.revoke'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("DELETE /me/personal-tokens/current", () => {
  it("revokes exactly the presenter; its next use is 401 and a sibling still works", async () => {
    const aid = await person(env, db, "cur");
    await bind(db, aid, "platform_admin", "platform", null);
    const a = await mint(env, db, aid, ADMIN_SCOPE, "a");
    const b = await mint(env, db, aid, ADMIN_SCOPE, "b");
    const pk = await mint(env, db, aid, PACKAGES_READ_SCOPE, "pk");
    const res = await call(env, db, a, "DELETE", `${MINE}/current`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).token).toMatchObject({
      label: "a",
      status: "revoked",
      revokeReason: "manual",
    });
    expect(text).not.toContain(aid);
    expect((await call(env, db, a, "GET", "/api/me")).status).toBe(401);
    expect((await call(env, db, a, "DELETE", `${MINE}/current`)).status).toBe(
      401,
    );
    expect((await call(env, db, b, "GET", "/api/me")).status).toBe(200);
    const live = await db.all<{ label: string }>(
      "SELECT label FROM account_tokens WHERE account_id = ? AND revoked_at IS NULL ORDER BY label",
      aid,
    );
    expect(live.map((r) => r.label)).toEqual(["b", "pk"]);
    void pk;
    const rows = await db.all<Record<string, string>>(
      "SELECT * FROM platform_audit WHERE action = 'account_token.revoke'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_sub).toBe(await memberIdFor(env, aid));
  });

  it("a session cannot call it, and revokes nothing", async () => {
    const ann = await signedIn(env, db, "ann");
    await bind(db, ann.aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, ann.aid, ADMIN_SCOPE, "ann cli");
    const csrf = await csrfOf(env, db, ann.cookie);
    const res = await sess(
      env,
      db,
      ann.cookie,
      csrf,
      "DELETE",
      `${MINE}/current`,
    );
    expect(res.status).toBe(403);
    expect((await call(env, db, tok, "GET", "/api/me")).status).toBe(200);
  });

  it("a packages token cannot call it: 401, and it is not revoked", async () => {
    const aid = await person(env, db, "pkg");
    await bind(db, aid, "platform_admin", "platform", null);
    const pk = await mint(env, db, aid, PACKAGES_READ_SCOPE, "pk");
    expect((await call(env, db, pk, "DELETE", `${MINE}/current`)).status).toBe(
      401,
    );
    expect(
      (await db.first<{ revoked_at: number | null }>(
        "SELECT revoked_at FROM account_tokens WHERE label = 'pk'",
      ))!.revoked_at,
    ).toBeNull();
  });

  it("is a no-grant row: a holder with no grant can still end the presenting token (self-revoke only narrows)", async () => {
    const aid = await person(env, db, "nog");
    const tok = await mint(env, db, aid);
    const res = await call(env, db, tok, "DELETE", `${MINE}/current`);
    expect(res.status).toBe(200);
    expect(
      (await db.first<{ revoked_at: number | null }>(
        "SELECT revoked_at FROM account_tokens WHERE account_id = ?",
        aid,
      ))!.revoked_at,
    ).not.toBeNull();
    // Revoked: the same token now gets nothing.
    expect((await call(env, db, tok, "DELETE", `${MINE}/current`)).status).toBe(
      401,
    );
  });
});

describe("POST /products/:slug/distribution/listing/import", () => {
  const IMPORT = "/api/products/alpha/distribution/listing/import";

  it("an admin token whose holder lacks ship is 403; with ship it reaches the handler", async () => {
    const aid = await person(env, db, "imp");
    await bind(db, aid, "product_admin", "product:alpha", ["license"]);
    const tok = await mint(env, db, aid);
    const denied = await call(env, db, tok, "POST", IMPORT, {});
    expect(denied.status).toBe(403);
    expect(await refusal(denied)).toMatchObject({ area: "ship" });
    await db.run(
      "UPDATE console_role_bindings SET areas_json = '[\"ship\"]' WHERE account_id = ?",
      aid,
    );
    const ok = await call(env, db, tok, "POST", IMPORT, {});
    // Past the dispatcher: the handler's own validation answers (sources are required).
    expect([400, 422]).toContain(ok.status);
    // Another product the holder has no role on stays 403 / 404, never the handler.
    await seedProduct(db, "beta");
    expect(
      (
        await call(
          env,
          db,
          tok,
          "POST",
          "/api/products/beta/distribution/listing/import",
          {},
        )
      ).status,
    ).toBe(403);
  });

  it("a sibling listing path, or another method, is not reachable by token", async () => {
    const aid = await person(env, db, "sib");
    await bind(db, aid, "product_admin", "product:alpha", ["ship"]);
    const tok = await mint(env, db, aid);
    expect(
      (
        await call(
          env,
          db,
          tok,
          "GET",
          "/api/products/alpha/distribution/listing/fit",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          env,
          db,
          tok,
          "PUT",
          "/api/products/alpha/distribution/listing/overrides",
          {},
        )
      ).status,
    ).toBe(403);
    // Default deny answers before the method: the row exists for POST only.
    expect((await call(env, db, tok, "GET", IMPORT)).status).toBe(403);
  });
});

describe("route flags", () => {
  it("personalOnly is on exactly `current`, always with personalToken and no step-up; the new rows keep their areas", () => {
    const only = ADMIN_ROUTES.filter((r) => r.personalOnly);
    expect(only.map(routeKey)).toEqual(["DELETE /me/personal-tokens/current"]);
    expect(only.every((r) => r.personalToken && !r.stepUp)).toBe(true);
    const byKey = new Map(ADMIN_ROUTES.map((r) => [routeKey(r), r]));
    expect(byKey.get("GET /me/personal-tokens")).toMatchObject({
      area: "console",
    });
    expect(byKey.get("GET /me/personal-tokens")!.personalToken).toBeUndefined();
    expect(
      byKey.get("DELETE /me/personal-tokens/:id")!.personalToken,
    ).toBeUndefined();
    expect(
      byKey.get("POST /products/:slug/distribution/listing/import"),
    ).toMatchObject({ area: "ship", personalToken: true });
    expect(
      byKey.get("POST /products/:slug/distribution/**")!.personalToken,
    ).toBeUndefined();
  });
});

describe("fold-ins from the 34.1-34.3 review", () => {
  const lastUsed = async (label: string) =>
    (await db.first<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM account_tokens WHERE label = ?",
      label,
    ))!.last_used_at;

  it("last_used_at is not bumped by a refused request, only by an accepted one", async () => {
    const aid = await person(env, db, "lu");
    await bind(db, aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, aid, ADMIN_SCOPE, "lu");
    // Refused: a row the token may not reach, a row its holder may not reach.
    expect(
      (await call(env, db, tok, "GET", "/api/platform/version")).status,
    ).toBe(403);
    expect((await call(env, db, tok, "GET", MINE)).status).toBe(403);
    expect(await lastUsed("lu")).toBeNull();
    expect((await call(env, db, tok, "GET", "/api/me")).status).toBe(200);
    expect(await lastUsed("lu")).toBe(T);
    // Throttled to once an hour.
    await call(env, db, tok, "GET", "/api/me", undefined, T + 60);
    expect(await lastUsed("lu")).toBe(T);
    await call(env, db, tok, "GET", "/api/me", undefined, T + 3700);
    expect(await lastUsed("lu")).toBe(T + 3700);
  });

  it("a fresh last_used_at costs no UPDATE at all (the hourly throttle stays)", async () => {
    const aid = await person(env, db, "lw");
    await bind(db, aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, aid, ADMIN_SCOPE, "lw");
    const writes: string[] = [];
    const run = db.run.bind(db);
    db.run = ((sql: string, ...params: unknown[]) => {
      if (/UPDATE account_tokens SET last_used_at/.test(sql)) writes.push(sql);
      return run(sql, ...(params as never[]));
    }) as typeof db.run;
    await call(env, db, tok, "GET", "/api/me");
    expect(writes).toHaveLength(1);
    await call(env, db, tok, "GET", "/api/me", undefined, T + 60);
    await call(env, db, tok, "GET", "/api/me", undefined, T + 120);
    expect(writes).toHaveLength(1);
    await call(env, db, tok, "GET", "/api/me", undefined, T + 3700);
    expect(writes).toHaveLength(2);
  });

  it("a holder's use rows are budgeted when the principal holds no grant", async () => {
    const aid = await person(env, db, "ng");
    const tok = await mint(env, db, aid);
    for (let i = 0; i < 8; i++)
      expect((await call(env, db, tok, "GET", "/api/me")).status).toBe(200);
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'account_token.used'",
    );
    expect(n!.n).toBe(3);
    // A holder with a grant is still audited on every use.
    const aid2 = await person(env, db, "ok");
    await bind(db, aid2, "platform_admin", "platform", null);
    const tok2 = await mint(env, db, aid2);
    for (let i = 0; i < 5; i++) await call(env, db, tok2, "GET", "/api/me");
    const m = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'account_token.used' AND actor_sub = ?",
      await memberIdFor(env, aid2),
    );
    expect(m!.n).toBe(5);
  });

  it("one cap spans all of a member's tokens; another member is unaffected", async () => {
    const aid = await person(env, db, "cap");
    const other = await person(env, db, "oth");
    await bind(db, aid, "platform_admin", "platform", null);
    await bind(db, other, "platform_admin", "platform", null);
    const a = await mint(env, db, aid, ADMIN_SCOPE, "a");
    const b = await mint(env, db, aid, ADMIN_SCOPE, "b");
    const o = await mint(env, db, other, ADMIN_SCOPE, "o");
    const member = await memberIdFor(env, aid);
    for (let i = 0; i < 600; i++)
      await rateLimitOk(
        env,
        "_admin",
        { bucket: "adminApiPersonal", id: member, limit: 600, windowSec: 60 },
        T,
      );
    expect((await call(env, db, a, "GET", "/api/me")).status).toBe(429);
    expect((await call(env, db, b, "GET", "/api/me")).status).toBe(429);
    expect((await call(env, db, o, "GET", "/api/me")).status).toBe(200);
  });
});
