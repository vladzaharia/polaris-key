/**
 * ST-34.3: the admin API accepts `Bearer pkeyp_` with the admin scope. Every case goes through
 * `handleAdminApi` (via `handleAdmin`) with a real `account_tokens` row for a person who signed in
 * through the real console callback. The property under test is that a token never exceeds its
 * holder's roles AT USE TIME: bindings, root freshness and the account's state are read per request.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bindAdminFlow } from "./flowBinderHelper.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { asR2 } from "./r2Mock.js";
import { LedgerBucket } from "./eraseRestore.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../src/console/auth.js";
import { resetConsoleSessionCache } from "../src/console/consoleSession.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../src/core/console/session.js";
import { ADMIN_ROUTES } from "../src/console/routes.js";
import { routeKey } from "../src/console/routeMatch.js";
import { rateLimitOk } from "../src/core/rateLimit.js";
import {
  ADMIN_SCOPE,
  PACKAGES_READ_SCOPE,
  mintAccountToken,
  revokeAccountToken,
} from "../src/core/accounts/personalTokens.js";
import { newBindingId, stmtInsertBinding } from "../src/core/rbac/bindings.js";
import type { AreaId } from "../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../src/core/rbac/can.js";
import { memberIdFor } from "../src/core/console/memberId.js";
import { erasureKey } from "../src/core/accounts/erasureFence.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { mintAdminApiToken, hashKey } from "../src/platform/crypto.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
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
  return aid;
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

const BUNDLE = (slug: string) => `/api/products/${slug}/bundles`;
const MIGRATIONS = "/api/platform/migrations";

let env: Env;
let db: Db;
let licenseId: string;

beforeEach(async () => {
  resetConsoleSessionCache();
  env = adminEnv();
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
  licenseId = (await seedLicenseWithKey(db, "alpha")).licenseId;
});

describe("never exceeds the holder's roles at use time", () => {
  it("follows the stored binding: product, narrowing, deletion", async () => {
    const aid = await person(env, db, "ann");
    const id = await bind(db, aid, "product_admin", "product:alpha", [
      "ship",
      "license",
    ]);
    const tok = await mint(env, db, aid);
    const body = { deviceId: DEVICE, graceDays: 7, licenseId };

    expect((await call(env, db, tok, "GET", "/api/me")).status).toBe(200);
    expect(
      (await call(env, db, tok, "POST", BUNDLE("alpha"), body)).status,
    ).toBe(200);

    const beta = await call(env, db, tok, "POST", BUNDLE("beta"), body);
    expect(beta.status).toBe(403);
    expect(await refusal(beta)).toMatchObject({
      code: "forbidden",
      reason: "no_access",
    });

    await db.run(
      "UPDATE console_role_bindings SET areas_json = ? WHERE id = ?",
      '["ship"]',
      id,
    );
    const narrowed = await call(env, db, tok, "POST", BUNDLE("alpha"), body);
    expect(narrowed.status).toBe(403);
    expect(await refusal(narrowed)).toMatchObject({ area: "license" });

    await db.run("DELETE FROM console_role_bindings WHERE id = ?", id);
    // No binding and no root: no grant. /me still answers (the "no access" screen); the rest is 403.
    expect((await call(env, db, tok, "GET", "/api/products")).status).toBe(403);
    expect(
      (await call(env, db, tok, "POST", BUNDLE("alpha"), body)).status,
    ).toBe(403);
  });

  it("the principal comes from the stored roles: /me lists them", async () => {
    const aid = await person(env, db, "meg");
    await bind(db, aid, "product_admin", "product:alpha", ["ship"]);
    const tok = await mint(env, db, aid);
    const me = (await (await call(env, db, tok, "GET", "/api/me")).json()) as {
      permissions: { roles: { role: string; scope: string }[] };
    };
    expect(me.permissions.roles).toEqual([
      expect.objectContaining({
        role: "product_admin",
        scope: "product:alpha",
      }),
    ]);
    // No account id anywhere in the answer.
    expect(JSON.stringify(me)).not.toContain(aid);
  });
});

describe("root freshness (D-3)", () => {
  it("a root-only holder's token works while asserted_at is fresh and is 403 console once stale", async () => {
    const aid = await person(env, db, "rue", { keepRoot: true });
    const tok = await mint(env, db, aid);
    const fresh = NOW + ADMIN_SESSION_TTL_SECONDS;
    expect(
      (await call(env, db, tok, "GET", MIGRATIONS, undefined, fresh)).status,
    ).toBe(200);
    const stale = await call(
      env,
      db,
      tok,
      "GET",
      MIGRATIONS,
      undefined,
      NOW + ADMIN_SESSION_TTL_SECONDS + 1,
    );
    expect(stale.status).toBe(403);
    expect(await refusal(stale)).toMatchObject({ area: "console" });
    // Still the same person: /products is refused for the same reason, /me still answers.
    expect(
      (
        await call(
          env,
          db,
          tok,
          "GET",
          "/api/me",
          undefined,
          NOW + ADMIN_SESSION_TTL_SECONDS + 1,
        )
      ).status,
    ).toBe(200);
  });

  it("a stored Superadmin binding outlives the stale assertion", async () => {
    const aid = await person(env, db, "sue", { keepRoot: true });
    await bind(db, aid, "superadmin", "platform", null);
    const tok = await mint(env, db, aid);
    expect(
      (
        await call(
          env,
          db,
          tok,
          "GET",
          MIGRATIONS,
          undefined,
          NOW + ADMIN_SESSION_TTL_SECONDS + 1,
        )
      ).status,
    ).toBe(200);
  });
});

describe("the one 401", () => {
  it("a disabled, merged, erased or no-strong-link holder, and a revoked, expired or foreign token", async () => {
    const make = async (who: string) => {
      const aid = await person(env, db, who);
      await bind(db, aid, "platform_admin", "platform", null);
      return { aid, tok: await mint(env, db, aid) };
    };
    const ok = async (tok: string) =>
      (await call(env, db, tok, "GET", "/api/me")).status;

    const dis = await make("dis");
    expect(await ok(dis.tok)).toBe(200);
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      dis.aid,
    );
    expect(await ok(dis.tok)).toBe(401);

    const weak = await make("weak");
    await db.run(
      "UPDATE account_links SET strong_at = NULL WHERE account_id = ?",
      weak.aid,
    );
    expect(await ok(weak.tok)).toBe(401);

    const gone = await make("gone");
    const survivor = await signIn(
      db,
      {
        issuerKey: "email",
        subject: "keep@example.com",
        kind: "email",
        email: "keep@example.com",
        emailVerified: true,
      },
      NOW,
      { unfenced: true },
    );
    if (survivor.status !== "signed_in") throw new Error("seed");
    const merged = await mergeAccounts(
      { db, env, now: NOW + 2, origin: "https://key.plrs.im" },
      {
        survivor: { accountId: survivor.account.id, authenticatedAt: NOW + 2 },
        absorbed: { accountId: gone.aid, authenticatedAt: NOW + 2 },
      },
    );
    expect(merged.ok).toBe(true);
    expect(await ok(gone.tok)).toBe(401);

    const rev = await make("rev");
    expect(await ok(rev.tok)).toBe(200);
    await revokeAccountToken(
      db,
      rev.aid,
      (await tokenId(db, rev.aid))!,
      "x",
      "manual",
      T,
    );
    expect(await ok(rev.tok)).toBe(401);

    const exp = await make("exp");
    expect(
      (
        await call(
          env,
          db,
          exp.tok,
          "GET",
          "/api/me",
          undefined,
          NOW + 8 * 86_400,
        )
      ).status,
    ).toBe(401);
  });

  it("an erased account's token is refused", async () => {
    const bucket = new LedgerBucket();
    env.BLOBS = asR2(bucket);
    const aid = await person(env, db, "era");
    await bind(db, aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, aid);
    expect((await call(env, db, tok, "GET", "/api/me")).status).toBe(200);
    await bucket.put(erasureKey(aid), "{}");
    expect(
      (await call(env, db, tok, "GET", "/api/me", undefined, T + 100)).status,
    ).toBe(401);
  });

  it("a packages token, a malformed pkeyp_ and a bad-shape pkeya_ are all 401", async () => {
    const aid = await person(env, db, "pkg");
    await bind(db, aid, "platform_admin", "platform", null);
    const packages = await mint(env, db, aid, PACKAGES_READ_SCOPE);
    expect((await call(env, db, packages, "GET", "/api/me")).status).toBe(401);
    expect((await call(env, db, "pkeyp_short", "GET", "/api/me")).status).toBe(
      401,
    );
    expect((await call(env, db, "pkeya_short", "GET", "/api/me")).status).toBe(
      401,
    );
    expect((await call(env, db, "", "GET", "/api/me")).status).toBe(401);
    // A good-shape pkeyp_ that was never minted.
    expect(
      (await call(env, db, `pkeyp_${"a".repeat(43)}`, "GET", "/api/me")).status,
    ).toBe(401);
  });

  it("a bad pkeyp_ beside a cookie is a 401, never a fall-through to the cookie", async () => {
    const aid = await person(env, db, "cky");
    await bind(db, aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, aid);
    const res = await handleAdmin(
      new Request("https://key.plrs.im/manage/api/me", {
        headers: {
          authorization: "Bearer pkeyp_" + "b".repeat(43),
          cookie: "__Host-pkey_admin=whatever",
        },
      }) as unknown as Request,
      env,
      db,
      "/api/me",
      { now: T },
    );
    expect(res.status).toBe(401);
    expect(tok).toMatch(/^pkeyp_/);
  });
});

async function tokenId(db: Db, aid: string): Promise<string | undefined> {
  return (
    await db.first<{ id: string }>(
      "SELECT id FROM account_tokens WHERE account_id = ? AND revoked_at IS NULL",
      aid,
    )
  )?.id;
}

describe("reach is default deny (D-1)", () => {
  it("a row without personalToken is 403 whatever the holder holds; unknown paths too", async () => {
    const aid = await person(env, db, "sup", { keepRoot: true });
    await bind(db, aid, "superadmin", "platform", null);
    const tok = await mint(env, db, aid);
    const patch = await call(
      env,
      db,
      tok,
      "PATCH",
      "/api/platform/settings/x",
      {},
    );
    expect(patch.status).toBe(403);
    expect(
      (await call(env, db, tok, "GET", "/api/platform/version")).status,
    ).toBe(403);
    expect((await call(env, db, tok, "GET", "/api/no/such/path")).status).toBe(
      403,
    );
    expect(
      (await call(env, db, tok, "GET", "/api/products/alpha/keys")).status,
    ).toBe(403);
  });

  it("a token never reaches /tokens or /account-tokens, itself included", async () => {
    const aid = await person(env, db, "tkn", { keepRoot: true });
    await bind(db, aid, "superadmin", "platform", null);
    const tok = await mint(env, db, aid);
    for (const [m, p] of [
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens"],
      ["DELETE", "/api/tokens/apitok_x"],
      ["GET", "/api/account-tokens"],
      ["DELETE", "/api/account-tokens/ptok_x"],
    ] as const)
      expect(
        (await call(env, db, tok, m, p, m === "POST" ? {} : undefined)).status,
        `${m} ${p}`,
      ).toBe(403);
  });

  it("flags exactly the eight planned rows, and never a step-up row", () => {
    const flagged = ADMIN_ROUTES.filter((r) => r.personalToken).map(routeKey);
    expect(flagged.sort()).toEqual(
      [
        "GET /me",
        "GET /access/admins",
        "GET /products",
        "POST /products/:slug/bundles",
        "GET /products/:slug/integration",
        "GET /platform/migrations",
        "GET /platform/migrations/runs/:id",
        "POST /platform/migrations/dry-run",
      ].sort(),
    );
    expect(ADMIN_ROUTES.filter((r) => r.personalToken && r.stepUp)).toEqual([]);
  });

  it("a step-up row refuses the token: it has no stepUpAt", async () => {
    const aid = await person(env, db, "stp", { keepRoot: true });
    await bind(db, aid, "superadmin", "platform", null);
    const tok = await mint(env, db, aid);
    const row = ADMIN_ROUTES.find((r) => routeKey(r) === "GET /access/admins")!;
    row.stepUp = true;
    try {
      const res = await call(env, db, tok, "GET", "/api/access/admins");
      expect(res.status).toBe(403);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("step_up_required");
    } finally {
      delete row.stepUp;
    }
  });

  it("needs no CSRF header on a mutation", async () => {
    const aid = await person(env, db, "csr");
    await bind(db, aid, "product_admin", "product:alpha", ["license"]);
    const tok = await mint(env, db, aid);
    const res = await call(env, db, tok, "POST", BUNDLE("alpha"), {
      deviceId: DEVICE,
      graceDays: 7,
      licenseId,
    });
    expect(res.status).toBe(200);
  });
});

describe("audit and limiter", () => {
  it("writes one account_token.used per use, on the product or the platform, with no token or hash", async () => {
    const aid = await person(env, db, "aud");
    await bind(db, aid, "product_admin", "product:alpha", ["license"]);
    await bind(db, aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, aid, ADMIN_SCOPE, "my laptop");
    await call(env, db, tok, "POST", BUNDLE("alpha"), {
      deviceId: DEVICE,
      graceDays: 7,
      licenseId,
    });
    await call(env, db, tok, "GET", MIGRATIONS);
    const product = await db.all<Record<string, string>>(
      "SELECT * FROM audit WHERE action = 'account_token.used'",
    );
    const platform = await db.all<Record<string, string>>(
      "SELECT * FROM platform_audit WHERE action = 'account_token.used'",
    );
    expect(product).toHaveLength(1);
    expect(platform).toHaveLength(1);
    const member = await memberIdFor(env, aid);
    for (const r of [product[0]!, platform[0]!]) {
      expect(r.actor_sub).toBe(member);
      expect(r.summary).toContain("my laptop");
      expect(r.summary).toContain(`…${tok.slice(-4)}`);
      const all = JSON.stringify(r);
      expect(all).not.toContain(tok);
      expect(all).not.toContain(await hashKey(tok, "test-pepper"));
      expect(all).not.toContain(aid);
    }
    expect(product[0]!.product).toBe("alpha");
  });

  it("a refused request (403 before the handler) writes no use row", async () => {
    const aid = await person(env, db, "nou");
    await bind(db, aid, "platform_admin", "platform", null);
    const tok = await mint(env, db, aid);
    await call(env, db, tok, "GET", "/api/platform/version");
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'account_token.used'",
    );
    expect(n!.n).toBe(0);
  });

  it("is rate limited per token (ptok:<id>), not the person's or another token's budget", async () => {
    const aid = await person(env, db, "lim");
    await bind(db, aid, "platform_admin", "platform", null);
    const a = await mint(env, db, aid, ADMIN_SCOPE, "a");
    const b = await mint(env, db, aid, ADMIN_SCOPE, "b");
    const rows = await db.all<{ id: string; label: string }>(
      "SELECT id, label FROM account_tokens WHERE account_id = ?",
      aid,
    );
    const idA = rows.find((r) => r.label === "a")!.id;
    for (let i = 0; i < 600; i++)
      await rateLimitOk(
        env,
        "_admin",
        { bucket: "adminApi", id: `ptok:${idA}`, limit: 600, windowSec: 60 },
        T,
      );
    expect((await call(env, db, a, "GET", "/api/me")).status).toBe(429);
    expect((await call(env, db, b, "GET", "/api/me")).status).toBe(200);
    // The person's own console budget (the member id) is untouched by the exhausted token key.
    const member = await memberIdFor(env, aid);
    expect(
      await rateLimitOk(
        env,
        "_admin",
        { bucket: "adminApi", id: member, limit: 600, windowSec: 60 },
        T,
      ),
    ).toBe(true);
  });
});

describe("pkeya_ is unchanged", () => {
  it("a pkeya_ token still never gains stored grants", async () => {
    const aid = await person(env, db, "pka");
    await bind(db, aid, "platform_admin", "platform", null);
    const secret = mintAdminApiToken();
    await db.run(
      `INSERT INTO admin_api_tokens (id, token_hash, label, scopes_json, created_at, expires_at)
       VALUES ('apitok_z', ?, 'ci', '["migrations:report"]', ?, ?)`,
      await hashKey(secret, "test-pepper"),
      NOW,
      NOW + 86_400,
    );
    expect((await call(env, db, secret, "GET", MIGRATIONS)).status).toBe(200);
    expect((await call(env, db, secret, "GET", "/api/me")).status).toBe(403);
  });
});
