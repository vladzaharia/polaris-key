/**
 * ST-31.2: the principal reads stored bindings. A v2 console session resolves to the root rule
 * plus the `console_role_bindings` of its account, read per request. Each person here signs in
 * through the real callback (so the cookie, the session row and the strong console link are real);
 * the IdP groups are then stripped from the link, which leaves a signed-in non-root member.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
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
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  LIVE_CHECK_SECONDS,
} from "../../../src/core/console/session.js";
import {
  newBindingId,
  stmtDeleteBinding,
  stmtInsertBinding,
} from "../../../src/core/rbac/bindings.js";
import type { AreaId } from "../../../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../../../src/core/rbac/can.js";
import { tokenSession } from "../../../src/console/apiTokens.js";
import { importHmacKey } from "../../../src/platform/hash.js";
import { signHmacToken } from "../../../src/platform/hmacToken.js";
import { resolvePrincipal } from "../../../src/core/rbac/principal.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";

type Db = ReturnType<typeof makeTestDb>;

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  return env;
}

interface Person {
  token: string;
  accountId: string;
  csrf: string;
}

/** Sign in through the real gate (as a root group member), then drop the stored groups. */
async function person(
  env: Env,
  db: Db,
  who: string,
  opts: { keepRoot?: boolean; stepUp?: boolean } = {},
): Promise<Person> {
  const start = await handleAdminLogin(
    new Request(
      "https://key.plrs.im/manage/login?go=1" +
        (opts.stepUp ? "&stepUp=1" : ""),
    ) as unknown as Request,
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
      ...(opts.stepUp ? { authTime: NOW } : {}),
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
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const claims = JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
  ) as { aid: string; csrf: string };
  if (!opts.keepRoot) {
    await db.run(
      "UPDATE account_links SET groups_json = '[]' WHERE account_id = ?",
      claims.aid,
    );
  }
  return { token, accountId: claims.aid, csrf: claims.csrf };
}

async function bind(
  db: Db,
  accountId: string | null,
  role: Role,
  scope: GrantScope,
  areas: AreaId[] | null,
  extra: { emailNorm?: string; source?: "grant" | "invite" } = {},
): Promise<string> {
  const id = newBindingId();
  const s = stmtInsertBinding({
    id,
    accountId,
    emailNorm: extra.emailNorm ?? null,
    role,
    scope,
    areas,
    source: extra.source ?? "grant",
    grantedBy: null,
    grantedAt: NOW - 10,
    ...(accountId === null ? { expiresAt: NOW + 3600 } : {}),
  });
  await db.run(s.sql, ...s.params);
  return id;
}

async function call(
  env: Env,
  db: Db,
  p: Person,
  method: string,
  path: string,
  now = NOW + 1,
  body?: unknown,
): Promise<Response> {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${p.token}`,
        ...(method !== "GET" ? { [CSRF_HEADER]: p.csrf } : {}),
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
async function refusal(res: Response): Promise<Refusal["error"]> {
  return ((await res.json()) as Refusal).error;
}
const SHIP = "/api/products/alpha/distribution/feeds";
const COMMERCE = "/api/products/alpha/storefronts/polaris-key";
const LICENSE = "/api/products/alpha/license/licenses";
const PLATFORM = "/api/platform/version";

let env: Env;
let db: Db;

beforeEach(async () => {
  resetConsoleSessionCache();
  env = adminEnv();
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
  await seedProduct(db, SYSTEM_PRODUCT_SLUG);
  await db.run(
    "UPDATE products SET system = 1 WHERE slug = ?",
    SYSTEM_PRODUCT_SLUG,
  );
});

// Reached the handler: not refused (401/403), not a missing route (404) and not a crash (500).
const allowed = (res: Response) => ![401, 403, 404, 500].includes(res.status);

describe("a Product admin narrowed to areas", () => {
  it("passes its areas and is refused the rest, with the area named", async () => {
    const p = await person(env, db, "ann");
    await bind(db, p.accountId, "product_admin", "product:alpha", [
      "ship",
      "commerce",
    ]);
    expect(allowed(await call(env, db, p, "GET", SHIP))).toBe(true);
    expect(allowed(await call(env, db, p, "GET", COMMERCE))).toBe(true);
    const lic = await call(env, db, p, "GET", LICENSE);
    expect(lic.status).toBe(403);
    expect(await refusal(lic)).toMatchObject({
      code: "forbidden",
      reason: "no_access",
      area: "license",
    });
    const plat = await call(env, db, p, "GET", PLATFORM);
    expect(plat.status).toBe(403);
    expect((await refusal(plat))?.reason).toBe("no_access");
    // Another product is refused whatever the area.
    const beta = await call(env, db, p, "GET", "/api/products/beta/keys");
    expect(beta.status).toBe(403);
  });

  it("sees only its own product in /products and /me, with the grant as a role", async () => {
    const p = await person(env, db, "ann");
    await bind(db, p.accountId, "product_admin", "product:alpha", ["ship"]);
    const list = (await (
      await call(env, db, p, "GET", "/api/products")
    ).json()) as { products?: { slug: string }[] } | { slug: string }[];
    const slugs = JSON.stringify(list);
    expect(slugs).toContain('"alpha"');
    expect(slugs).not.toContain('"beta"');
    expect(slugs).not.toContain(SYSTEM_PRODUCT_SLUG);
    const me = (await (await call(env, db, p, "GET", "/api/me")).json()) as {
      platformAdmin: boolean;
      permissions: {
        roles: {
          role: string;
          scope: string;
          areas: string[];
          source: string;
        }[];
        products: Record<string, { view: string[] }>;
      };
    };
    expect(me.platformAdmin).toBe(false);
    expect(me.permissions.roles).toEqual([
      {
        role: "product_admin",
        scope: "product:alpha",
        areas: ["ship"],
        source: "grant",
      },
    ]);
    expect(Object.keys(me.permissions.products)).toEqual(["alpha"]);
    expect(me.permissions.products.alpha!.view).toEqual(["ship"]);
  });
});

describe("the other roles", () => {
  it("products:* reaches every product but not the system product", async () => {
    const p = await person(env, db, "pat");
    await bind(db, p.accountId, "product_admin", "products:*", null);
    expect(allowed(await call(env, db, p, "GET", LICENSE))).toBe(true);
    expect(
      allowed(await call(env, db, p, "GET", "/api/products/beta/keys")),
    ).toBe(true);
    const sys = await call(
      env,
      db,
      p,
      "GET",
      `/api/products/${SYSTEM_PRODUCT_SLUG}/keys`,
    );
    expect(sys.status).toBe(403);
    expect(await call(env, db, p, "GET", PLATFORM)).toMatchObject({
      status: 403,
    });
  });

  it("platform_admin reaches platform routes and no product area", async () => {
    const p = await person(env, db, "plat");
    await bind(db, p.accountId, "platform_admin", "platform", null);
    expect(allowed(await call(env, db, p, "GET", PLATFORM))).toBe(true);
    const lic = await call(env, db, p, "GET", LICENSE);
    expect(lic.status).toBe(403);
    const me = (await (await call(env, db, p, "GET", "/api/me")).json()) as {
      platformAdmin: boolean;
    };
    expect(me.platformAdmin).toBe(true);
  });

  it("console_access opens /me with its role and is refused every product and platform route", async () => {
    const p = await person(env, db, "cas");
    await bind(db, p.accountId, "console_access", "platform", null);
    const me = await call(env, db, p, "GET", "/api/me");
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      platformAdmin: boolean;
      products: unknown[];
      permissions: { roles: { role: string }[] };
    };
    expect(body.permissions.roles.map((r) => r.role)).toEqual([
      "console_access",
    ]);
    expect(body.platformAdmin).toBe(false);
    expect(body.products).toEqual([]);
    for (const path of [SHIP, COMMERCE, LICENSE, PLATFORM])
      expect((await call(env, db, p, "GET", path)).status, path).toBe(403);
  });

  it("a stranger (strong link, no group, no binding) is refused everything but /me", async () => {
    const p = await person(env, db, "sam");
    const me = await call(env, db, p, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(
      ((await me.json()) as { permissions: { roles: unknown[] } }).permissions
        .roles,
    ).toEqual([]);
    for (const path of [SHIP, LICENSE, PLATFORM, "/api/attention"])
      expect((await call(env, db, p, "GET", path)).status, path).toBe(403);
  });

  it("root and a binding are summed, and /me shows both sources", async () => {
    const p = await person(env, db, "rue", { keepRoot: true });
    await bind(db, p.accountId, "product_admin", "product:alpha", ["ship"]);
    const me = (await (await call(env, db, p, "GET", "/api/me")).json()) as {
      permissions: { roles: { role: string; source: string }[] };
    };
    expect(me.permissions.roles.map((r) => `${r.role}/${r.source}`)).toEqual([
      "superadmin/root",
      "product_admin/grant",
    ]);
    expect(allowed(await call(env, db, p, "GET", LICENSE))).toBe(true);
    expect(allowed(await call(env, db, p, "GET", PLATFORM))).toBe(true);
  });
});

describe("freshness and refusal", () => {
  it("a deleted binding stops granting within the 30 s live check, and in fact on the next request", async () => {
    const p = await person(env, db, "del");
    const id = await bind(db, p.accountId, "product_admin", "product:alpha", [
      "ship",
    ]);
    expect(allowed(await call(env, db, p, "GET", SHIP, NOW + 1))).toBe(true);
    const s = stmtDeleteBinding(id);
    await db.run(s.sql, ...s.params);
    // Bindings are read per request, so the revocation does not wait for the session cache.
    const next = await call(env, db, p, "GET", SHIP, NOW + 2);
    expect(next.status).toBe(403);
    const later = await call(
      env,
      db,
      p,
      "GET",
      SHIP,
      NOW + 1 + LIVE_CHECK_SECONDS,
    );
    expect(later.status).toBe(403);
  });

  it("a disabled account gets a 401 whatever its bindings, within the live-check window", async () => {
    const p = await person(env, db, "dis");
    await bind(db, p.accountId, "platform_admin", "platform", null);
    expect(allowed(await call(env, db, p, "GET", PLATFORM, NOW + 1))).toBe(
      true,
    );
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      p.accountId,
    );
    const res = await call(
      env,
      db,
      p,
      "GET",
      PLATFORM,
      NOW + 1 + LIVE_CHECK_SECONDS,
    );
    expect(res.status).toBe(401);
  });

  it("an email row whose address equals the account's email grants nothing", async () => {
    const p = await person(env, db, "eml");
    await bind(db, null, "platform_admin", "platform", null, {
      emailNorm: "eml@example.com",
      source: "invite",
    });
    expect((await call(env, db, p, "GET", PLATFORM)).status).toBe(403);
    const me = (await (await call(env, db, p, "GET", "/api/me")).json()) as {
      permissions: { roles: unknown[] };
    };
    expect(me.permissions.roles).toEqual([]);
  });

  it("a binding on another account never reaches this one", async () => {
    const a = await person(env, db, "one");
    const b = await person(env, db, "two");
    await bind(db, a.accountId, "platform_admin", "platform", null);
    expect(allowed(await call(env, db, a, "GET", PLATFORM))).toBe(true);
    expect((await call(env, db, b, "GET", PLATFORM)).status).toBe(403);
  });

  it("a malformed or unknown-area row yields no grant", async () => {
    const p = await person(env, db, "bad");
    const id = await bind(db, p.accountId, "product_admin", "product:alpha", [
      "ship",
    ]);
    await db.run(
      "UPDATE console_role_bindings SET areas_json = ? WHERE id = ?",
      '["ship","nope"]',
      id,
    );
    expect((await call(env, db, p, "GET", SHIP)).status).toBe(403);
  });
});

describe("credentials without an account", () => {
  it("a v1 cookie is no session, whatever its groups say (ST-30c.8)", async () => {
    const p = await person(env, db, "v1x");
    await bind(db, p.accountId, "platform_admin", "platform", null);
    // An account-less v1 cookie, signed directly (the console no longer mints them).
    const v1 = async (groups: string[]) =>
      signHmacToken(
        await importHmacKey(env.ADMIN_SESSION_SECRET!),
        "pkey.admin.v1|",
        {
          sub: "op-1",
          name: "Op",
          email: "op@x.io",
          groups,
          csrf: "c",
          exp: NOW + 3600,
          authAt: NOW,
        },
      );
    const token = await v1([]);
    const res = await handleAdmin(
      new Request(`https://key.plrs.im/manage${PLATFORM}`, {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }) as unknown as Request,
      env,
      db,
      PLATFORM,
      { now: NOW + 1 },
    );
    expect(res.status).toBe(401);
    // The root group changes nothing: the shape is not read.
    const rooted = { token: await v1([GROUP]) };
    const ok = await handleAdmin(
      new Request(`https://key.plrs.im/manage${PLATFORM}`, {
        headers: { cookie: `${ADMIN_COOKIE}=${rooted.token}` },
      }) as unknown as Request,
      env,
      db,
      PLATFORM,
      { now: NOW + 1 },
    );
    expect(ok.status).toBe(401);
  });

  it("a pkeya_ token session carries no account id, so it resolves root-only", async () => {
    const p = await person(env, db, "tok");
    await bind(db, p.accountId, "platform_admin", "platform", null);
    const session = tokenSession(env, {
      id: "t1",
      label: "ci",
      expires_at: NOW + 100,
    } as never);
    expect(session.aid).toBeUndefined();
    // Even handed the right account, only a caller that names it reads bindings; the token path
    // (callerFor) names none.
    const withoutId = await resolvePrincipal(
      env,
      db,
      { sub: session.sub, groups: session.groups },
      NOW,
    );
    expect(withoutId.grants.map((g) => g.role)).toEqual(["superadmin"]);
    const named = await resolvePrincipal(
      env,
      db,
      { sub: "x", groups: [], root: false, accountId: p.accountId },
      NOW,
    );
    expect(named.grants.map((g) => g.role)).toEqual(["platform_admin"]);
  });
});

describe("a forged v1 body (ST-30c.8: no session)", () => {
  it("signed with the right key, aid / sid / root in the body are ignored", async () => {
    const p = await person(env, db, "forge");
    await bind(db, p.accountId, "platform_admin", "platform", null);
    const forged = await signHmacToken(
      await importHmacKey(env.ADMIN_SESSION_SECRET!),
      "pkey.admin.v1|",
      {
        sub: "op-9",
        name: "Op",
        email: "op@x.io",
        groups: [],
        csrf: "c",
        exp: NOW + 3600,
        aid: p.accountId,
        sid: "whatever",
        root: true,
      },
    );
    const res = await handleAdmin(
      new Request(`https://key.plrs.im/manage${PLATFORM}`, {
        headers: { cookie: `${ADMIN_COOKIE}=${forged}` },
      }) as unknown as Request,
      env,
      db,
      PLATFORM,
      { now: NOW + 1 },
    );
    // Neither root (`root: true`) nor the account's platform_admin binding (`aid`) took effect:
    // the body is not read at all.
    expect(res.status).toBe(401);
  });
});

describe("admin API tokens are Superadmin-minted (the tokenSession carries the root group)", () => {
  const MINT = { label: "x", expiresInDays: 30 };

  it("a stepped-up platform_admin binding is refused POST /tokens; root gets 201", async () => {
    const p = await person(env, db, "padm", { stepUp: true });
    await bind(db, p.accountId, "platform_admin", "platform", null);
    const res = await call(env, db, p, "POST", "/api/tokens", NOW + 5, MINT);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; reason: string };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.reason).toBe("superadmin_only");
    const rows = await db.all("SELECT id FROM admin_api_tokens");
    expect(rows).toHaveLength(0);

    const root = await person(env, db, "rooty", {
      stepUp: true,
      keepRoot: true,
    });
    const ok = await call(env, db, root, "POST", "/api/tokens", NOW + 5, MINT);
    expect(ok.status).toBe(201);
  });

  it("the escalation is closed: the platform_admin cannot obtain a token that writes to a product", async () => {
    const p = await person(env, db, "esc", { stepUp: true });
    await bind(db, p.accountId, "platform_admin", "platform", null);
    expect(
      (
        await call(
          env,
          db,
          p,
          "POST",
          "/api/products/beta/bundles",
          NOW + 5,
          {},
        )
      ).status,
    ).toBe(403);
    const mint = await call(env, db, p, "POST", "/api/tokens", NOW + 5, MINT);
    expect(mint.status).toBe(403);
    expect(((await mint.json()) as { secret?: string }).secret).toBeUndefined();
  });
});

describe("the bindings table is absent (deploy order)", () => {
  it("resolves to no stored grants: root keeps working, a binding-only member is simply a stranger", async () => {
    const root = await person(env, db, "r0", { keepRoot: true });
    const other = await person(env, db, "o0");
    await db.run("DROP TABLE console_role_bindings");
    expect(allowed(await call(env, db, root, "GET", PLATFORM))).toBe(true);
    expect((await call(env, db, other, "GET", PLATFORM)).status).toBe(403);
  });
});
