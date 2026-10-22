/**
 * ST-31.6: grant, edit and revoke (G1 to G5, D-c, D-d, D-g). Each person signs in through the
 * real callback (so the cookie, the session row and the strong console link are real); the IdP
 * groups are then stripped from the link unless the person is the root operator, which leaves a
 * signed-in non-root member whose authority is exactly the bindings written here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { bindAdminFlow } from "./flowBinderHelper.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../src/console/auth.js";
import { resetConsoleSessionCache } from "../src/console/consoleSession.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../src/core/console/session.js";
import {
  bindingUnchangedSql,
  newBindingId,
  stmtInsertBinding,
  stmtUpdateBindingAreas,
} from "../src/core/rbac/bindings.js";
import type { AreaId } from "../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../src/core/rbac/can.js";
import { memberIdFor } from "../src/core/console/memberId.js";
import { erasureKey } from "../src/core/accounts/erasureFence.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";

type Db = ReturnType<typeof makeTestDb>;

interface Mail {
  to: string;
  subject: string;
  text: string;
  from: unknown;
}

let mail: Mail[];
/** Everyone who signed in, so every response body can be checked for an account id. */
let people: { accountId: string }[];

function adminEnv(withEmail = true): Env {
  const env = makeEnv(new KvMock(), ["alpha", "beta"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  if (withEmail) {
    env.EMAIL = {
      send: async (m: Mail) => {
        mail.push(m);
      },
    } as unknown as Env["EMAIL"];
    env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  }
  return env;
}

interface Person {
  token: string;
  accountId: string;
  csrf: string;
  who: string;
  memberId: string;
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
  people.push({ accountId: claims.aid });
  return {
    token,
    accountId: claims.aid,
    csrf: claims.csrf,
    who,
    memberId: await memberIdFor(env, claims.aid),
  };
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

async function call(
  p: Person,
  method: string,
  path: string,
  body?: unknown,
  opts: { csrf?: boolean; now?: number } = {},
): Promise<Response> {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${p.token}`,
        ...(method !== "GET" && opts.csrf !== false
          ? { [CSRF_HEADER]: p.csrf }
          : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    env,
    db,
    path,
    { now: opts.now ?? NOW + 1 },
  );
}

interface Body {
  ok?: boolean;
  code?: string;
  reason?: string;
  fields?: string[];
  bindingId?: string;
  unchanged?: boolean;
  widened?: boolean;
  confirm?: string;
  binding?: {
    bindingId: string;
    memberId: string;
    role: string;
    scope: string;
    areas: string[] | null;
  };
  notified?: { sent: number; of: number; nobodyNotified: boolean };
  error?: { reason?: string };
}

/** Every response body in a test, to assert the account id never appears in one. */
let seen: string[];

async function send(
  p: Person,
  method: string,
  path: string,
  body?: unknown,
  opts?: { csrf?: boolean; now?: number },
): Promise<{ status: number; b: Body }> {
  const res = await call(p, method, path, body, opts);
  const text = await res.text();
  seen.push(text);
  return { status: res.status, b: (text ? JSON.parse(text) : {}) as Body };
}

async function rows(sql: string, ...params: string[]) {
  return db.all<Record<string, string | number | null>>(sql, ...params);
}

async function storedAreas(id: string) {
  const r = await db.first<{ areas_json: string | null }>(
    "SELECT areas_json FROM console_role_bindings WHERE id = ?",
    id,
  );
  return r === null ? "gone" : r.areas_json;
}

let env: Env;
let db: Db;

beforeEach(async () => {
  resetConsoleSessionCache();
  mail = [];
  seen = [];
  people = [];
  env = adminEnv();
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
});

afterEach(() => {
  // The account id never reaches a response body, whatever the route answered.
  for (const t of seen)
    for (const p of people) expect(t).not.toContain(p.accountId);
});

describe("POST /bindings", () => {
  it("refuses without a step-up, and without the CSRF token", async () => {
    const root = await person(env, db, "root", { keepRoot: true });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const body = {
      member: bob.memberId,
      role: "product_admin",
      scope: "product:alpha",
      areas: null,
    };
    const r = await send(root, "POST", "/api/bindings", body);
    expect(r.status).toBe(403);
    expect(r.b.code).toBe("step_up_required");
    const stepped = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const c = await send(stepped, "POST", "/api/bindings", body, {
      csrf: false,
    });
    expect(c.status).toBe(403);
    expect(await rows("SELECT * FROM console_role_bindings")).toHaveLength(1);
  });

  it("a Superadmin grants a product admin: stored, audited in both trails, the actor an mbr_ id", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const r = await send(root, "POST", "/api/bindings", {
      member: bob.memberId,
      role: "product_admin",
      scope: "product:alpha",
      areas: ["commerce", "ship", "ship"],
    });
    expect(r.status).toBe(201);
    expect(r.b.confirm).toBe("L1");
    expect(r.b.binding).toMatchObject({
      memberId: bob.memberId,
      role: "product_admin",
      scope: "product:alpha",
      areas: ["ship", "commerce"],
    });
    const id = r.b.binding!.bindingId;
    const row = await db.first<Record<string, unknown>>(
      "SELECT * FROM console_role_bindings WHERE id = ?",
      id,
    );
    expect(row).toMatchObject({
      account_id: bob.accountId,
      source: "grant",
      granted_by: root.memberId,
      areas_json: '["ship","commerce"]',
    });
    const platform = await rows(
      "SELECT * FROM platform_audit WHERE action = 'rbac.grant'",
    );
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({
      actor_sub: root.memberId,
      target_kind: "console_role_binding",
      target_id: id,
    });
    const product = await rows(
      "SELECT * FROM audit WHERE action = 'rbac.grant' AND product = 'alpha'",
    );
    expect(product).toHaveLength(1);
    expect(product[0]!.actor_sub).toBe(root.memberId);
    // The binding takes effect on the very next request.
    const members = await send(bob, "GET", "/api/products/alpha/members");
    expect(members.status).toBe(403); // ship + commerce only, no `members` area
    const ship = await send(bob, "GET", "/api/products/alpha/activity");
    expect(ship.status).toBe(403);
    expect((await send(bob, "GET", "/api/me")).status).toBe(200);
    // No response named an account id.
    for (const t of seen)
      for (const a of [root.accountId, bob.accountId])
        expect(t).not.toContain(a);
  });

  it("an existing (role, scope) answers 409 with its id and writes nothing", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const bob = await person(env, db, "bob");
    const have = await bind(
      db,
      bob.accountId,
      "product_admin",
      "product:alpha",
      ["ship"],
    );
    const r = await send(root, "POST", "/api/bindings", {
      member: bob.memberId,
      role: "product_admin",
      scope: "product:alpha",
      areas: null,
    });
    expect(r.status).toBe(409);
    expect(r.b.bindingId).toBe(have);
    expect(r.b.reason ?? r.b.error?.reason).toBe("exists");
    expect(await storedAreas(have)).toBe('["ship"]');
    expect(
      await rows("SELECT * FROM platform_audit WHERE action LIKE 'rbac.%'"),
    ).toHaveLength(0);
  });

  it("G5: emails the grantee and every Superadmin as Polaris Key; counts them; email off says nobody", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const sue = await person(env, db, "sue");
    await bind(db, sue.accountId, "superadmin", "platform", null);
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const r = await send(root, "POST", "/api/bindings", {
      member: bob.memberId,
      role: "product_admin",
      scope: "product:alpha",
      areas: ["ship"],
    });
    expect(r.status).toBe(201);
    expect(mail.map((m) => m.to).sort()).toEqual([
      "bob@example.com",
      "root@example.com",
      "sue@example.com",
    ]);
    expect(r.b.notified).toEqual({ sent: 3, of: 3, nobodyNotified: false });
    expect(JSON.stringify(mail[0]!.from)).toContain("Polaris Key");
    expect(mail[0]!.subject).toContain("Access changed");
    // Email off: the change still happens and the response says no one was told.
    resetConsoleSessionCache();
    env = adminEnv(false);
    db = makeTestDb();
    await seedProduct(db, "alpha");
    const root2 = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const dee = await person(env, db, "dee");
    await bind(db, dee.accountId, "console_access", "platform", null);
    const off = await send(root2, "POST", "/api/bindings", {
      member: dee.memberId,
      role: "product_admin",
      scope: "product:alpha",
      areas: null,
    });
    expect(off.status).toBe(201);
    expect(off.b.notified).toMatchObject({ sent: 0, nobodyNotified: true });
  });

  it("G2: a Platform admin gives Console access and nothing else", async () => {
    const pam = await person(env, db, "pam", { stepUp: true });
    await bind(db, pam.accountId, "platform_admin", "platform", null);
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const targets = [
      { role: "superadmin", scope: "platform", areas: null },
      { role: "platform_admin", scope: "platform", areas: null },
      { role: "product_admin", scope: "products:*", areas: null },
      { role: "product_admin", scope: "product:alpha", areas: null },
      { role: "product_admin", scope: "product:alpha", areas: ["ship"] },
    ];
    for (const t of targets) {
      const r = await send(pam, "POST", "/api/bindings", {
        member: bob.memberId,
        ...t,
      });
      expect(r.status, JSON.stringify(t)).toBe(403);
      expect(r.b.error?.reason ?? r.b.reason).toBe("grant_refused");
    }
    expect(await rows("SELECT * FROM console_role_bindings")).toHaveLength(2);
    // The one thing a Platform admin may give: Console access, to someone who lacks it.
    const carol = await person(env, db, "carol");
    await bind(db, carol.accountId, "product_admin", "product:beta", null);
    const ok = await send(pam, "POST", "/api/bindings", {
      member: carol.memberId,
      role: "console_access",
      scope: "platform",
    });
    expect(ok.status).toBe(201);
  });

  it("D-g: no one grants themselves access, a Superadmin included", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const r = await send(root, "POST", "/api/bindings", {
      member: root.memberId,
      role: "product_admin",
      scope: "product:alpha",
      areas: null,
    });
    expect(r.status).toBe(403);
    expect(r.b.error?.reason ?? r.b.reason).toBe("self_grant");
    const pam = await person(env, db, "pam", { stepUp: true });
    await bind(db, pam.accountId, "platform_admin", "platform", null);
    const s = await send(pam, "POST", "/api/bindings", {
      member: pam.memberId,
      role: "console_access",
      scope: "platform",
    });
    expect(s.status).toBe(403);
    expect(s.b.error?.reason ?? s.b.reason).toBe("self_grant");
    expect(await rows("SELECT * FROM console_role_bindings")).toHaveLength(1);
  });

  it("resolves the member through the roster and refuses an erased account before writing", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const body = (m: string) => ({
      member: m,
      role: "product_admin",
      scope: "product:alpha",
      areas: null,
    });
    // A well-formed id nobody holds, a malformed one, and an account that holds no role.
    const nobody = await getOrCreateAccountByEmail(
      db,
      "nobody@example.com",
      NOW,
    );
    for (const m of [
      "mbr_" + "A".repeat(22),
      await memberIdFor(env, nobody.id),
    ]) {
      const r = await send(root, "POST", "/api/bindings", body(m));
      expect(r.status).toBe(404);
    }
    expect(
      (await send(root, "POST", "/api/bindings", body("bob"))).status,
    ).toBe(422);
    // The ledger holds bob: a restored D1 row must not be granted anything.
    await env.BLOBS!.put(erasureKey(bob.accountId), "1");
    const erased = await send(
      root,
      "POST",
      "/api/bindings",
      body(bob.memberId),
    );
    expect(erased.status).toBe(404);
    expect(
      await rows(
        "SELECT * FROM console_role_bindings WHERE role = 'product_admin'",
      ),
    ).toHaveLength(0);
  });

  it("refuses a disabled account", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      bob.accountId,
    );
    const r = await send(root, "POST", "/api/bindings", {
      member: bob.memberId,
      role: "product_admin",
      scope: "product:alpha",
      areas: null,
    });
    expect(r.status).toBe(409);
    expect(r.b.error?.reason ?? r.b.reason).toBe("member_disabled");
    expect(
      await rows(
        "SELECT * FROM console_role_bindings WHERE role = 'product_admin'",
      ),
    ).toHaveLength(0);
  });

  it("requires the product to exist and not be the system product; bad shapes are 422", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const base = { member: bob.memberId, role: "product_admin", areas: null };
    expect(
      (
        await send(root, "POST", "/api/bindings", {
          ...base,
          scope: "product:ghost",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(root, "POST", "/api/bindings", {
          ...base,
          scope: `product:${SYSTEM_PRODUCT_SLUG}`,
        })
      ).status,
    ).toBe(422);
    for (const bad of [
      { ...base, scope: "product:alpha", extra: 1 },
      { ...base, scope: "product:alpha", areas: [] },
      { ...base, scope: "product:alpha", areas: ["nonsense"] },
      { member: bob.memberId, role: "product_admin", scope: "product:alpha" },
      { ...base, scope: "platform" },
      { ...base, role: "root", scope: "product:alpha" },
    ]) {
      const r = await send(root, "POST", "/api/bindings", bad);
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await rows("SELECT * FROM console_role_bindings")).toHaveLength(1);
  });

  it("an L2 target needs confirm L2", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const body = {
      member: bob.memberId,
      role: "platform_admin",
      scope: "platform",
    };
    const r = await send(root, "POST", "/api/bindings", body);
    expect(r.status).toBe(422);
    expect(r.b.error?.reason ?? r.b.reason).toBe("confirm_required");
    const ok = await send(root, "POST", "/api/bindings", {
      ...body,
      confirm: "L2",
    });
    expect(ok.status).toBe(201);
    expect(ok.b.confirm).toBe("L2");
  });

  it("is rate limited per member", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (await send(root, "DELETE", "/api/bindings/crb_missing")).status;
    expect(last).toBe(429);
  });
});

describe("the product twins (D-d)", () => {
  async function world() {
    const ada = await person(env, db, "ada", { stepUp: true });
    await bind(db, ada.accountId, "product_admin", "product:alpha", null);
    const nan = await person(env, db, "nan", { stepUp: true });
    await bind(db, nan.accountId, "product_admin", "product:alpha", [
      "members",
      "ship",
    ]);
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    return { ada, nan, bob };
  }

  it("a Product admin grants within the areas it holds, audited in the product's trail", async () => {
    const { ada, bob } = await world();
    const r = await send(ada, "POST", "/api/products/alpha/members", {
      member: bob.memberId,
      areas: ["ship"],
    });
    expect(r.status).toBe(201);
    expect(r.b.binding).toMatchObject({
      role: "product_admin",
      scope: "product:alpha",
      areas: ["ship"],
    });
    expect(
      await rows(
        "SELECT * FROM audit WHERE product = 'alpha' AND action = 'rbac.grant'",
      ),
    ).toHaveLength(1);
    expect(
      await rows("SELECT * FROM platform_audit WHERE action = 'rbac.grant'"),
    ).toHaveLength(1);
    // The new admin reaches ship at once, and nothing of beta.
    expect(
      (await send(bob, "GET", "/api/products/alpha/distribution/releases"))
        .status,
    ).not.toBe(403);
    expect((await send(bob, "GET", "/api/products/beta/members")).status).toBe(
      403,
    );
  });

  it("G1: a narrowed admin cannot give areas it lacks, and may give Console access (G3)", async () => {
    const { nan, bob } = await world();
    for (const areas of [["ship", "keys"], null, ["core"]]) {
      const r = await send(nan, "POST", "/api/products/alpha/members", {
        member: bob.memberId,
        areas,
      });
      expect(r.status, JSON.stringify(areas)).toBe(403);
    }
    const ok = await send(nan, "POST", "/api/products/alpha/members", {
      member: bob.memberId,
      areas: ["ship"],
    });
    expect(ok.status).toBe(201);
    const carol = await person(env, db, "carol");
    await bind(db, carol.accountId, "product_admin", "product:beta", null);
    const g3 = await send(nan, "POST", "/api/products/alpha/members", {
      member: carol.memberId,
      role: "console_access",
    });
    expect(g3.status).toBe(201);
    expect(g3.b.binding).toMatchObject({
      role: "console_access",
      scope: "platform",
    });
  });

  it("the role is fixed: a body naming a scope or another role is refused", async () => {
    const { ada, bob } = await world();
    for (const extra of [
      { scope: "platform" },
      { role: "platform_admin" },
      { role: "superadmin", areas: null },
    ]) {
      const r = await send(ada, "POST", "/api/products/alpha/members", {
        member: bob.memberId,
        areas: null,
        ...extra,
      });
      expect(r.status, JSON.stringify(extra)).toBe(422);
    }
  });

  it("a Platform admin cannot use the twin to hand out product admin; the system product takes none", async () => {
    const pam = await person(env, db, "pam", { stepUp: true });
    await bind(db, pam.accountId, "platform_admin", "platform", null);
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    await seedProduct(db, SYSTEM_PRODUCT_SLUG);
    await db.run(
      "UPDATE products SET system = 1 WHERE slug = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    // The dispatcher treats the system product as the platform's, so a Platform admin reaches it.
    const sys = await send(
      pam,
      "POST",
      `/api/products/${SYSTEM_PRODUCT_SLUG}/members`,
      {
        member: bob.memberId,
        role: "console_access",
      },
    );
    expect(sys.status).toBe(422);
    const r = await send(pam, "POST", "/api/products/alpha/members", {
      member: bob.memberId,
      areas: null,
    });
    // The dispatcher already refuses: a Platform admin holds no area of a product.
    expect(r.status).toBe(403);
  });

  it("cannot touch another product's binding or a platform one", async () => {
    const { ada, bob } = await world();
    const onBeta = await bind(
      db,
      bob.accountId,
      "product_admin",
      "product:beta",
      null,
    );
    const platform = await bind(
      db,
      bob.accountId,
      "platform_admin",
      "platform",
      null,
    );
    for (const id of [onBeta, platform]) {
      expect(
        (await send(ada, "DELETE", `/api/products/alpha/members/${id}`)).status,
      ).toBe(404);
      expect(
        (
          await send(ada, "PATCH", `/api/products/alpha/members/${id}`, {
            areas: ["ship"],
          })
        ).status,
      ).toBe(404);
    }
    expect(
      await rows(
        "SELECT * FROM console_role_bindings WHERE id IN (?, ?)",
        onBeta,
        platform,
      ),
    ).toHaveLength(2);
  });
});

describe("PATCH /bindings/:id and DELETE", () => {
  async function granted(areas: AreaId[] | null = ["ship", "commerce"]) {
    const ada = await person(env, db, "ada");
    await bind(db, ada.accountId, "product_admin", "product:alpha", null);
    const adaStep = await person(env, db, "ada", { stepUp: true });
    const bob = await person(env, db, "bob");
    const id = await bind(
      db,
      bob.accountId,
      "product_admin",
      "product:alpha",
      areas,
    );
    return { ada, adaStep, bob, id };
  }

  it("narrowing needs no step-up and audits rbac.revoke; widening needs one and audits rbac.grant", async () => {
    const { ada, adaStep, id } = await granted();
    const narrow = await send(
      ada,
      "PATCH",
      `/api/products/alpha/members/${id}`,
      {
        areas: ["ship"],
      },
    );
    expect(narrow.status).toBe(200);
    expect(narrow.b.widened).toBe(false);
    expect(await storedAreas(id)).toBe('["ship"]');
    expect(
      await rows("SELECT * FROM platform_audit WHERE action = 'rbac.revoke'"),
    ).toHaveLength(1);
    const wide = await send(ada, "PATCH", `/api/products/alpha/members/${id}`, {
      areas: ["ship", "keys"],
    });
    expect(wide.status).toBe(403);
    expect(wide.b.code).toBe("step_up_required");
    expect(await storedAreas(id)).toBe('["ship"]');
    const ok = await send(
      adaStep,
      "PATCH",
      `/api/products/alpha/members/${id}`,
      {
        areas: ["ship", "keys"],
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.b.widened).toBe(true);
    expect(await storedAreas(id)).toBe('["ship","keys"]');
    expect(
      await rows("SELECT * FROM platform_audit WHERE action = 'rbac.grant'"),
    ).toHaveLength(1);
    expect(
      await rows(
        "SELECT * FROM audit WHERE product = 'alpha' AND action LIKE 'rbac.%'",
      ),
    ).toHaveLength(2);
  });

  it("an edit that changes nothing writes and tells no one", async () => {
    const { ada, id } = await granted();
    const r = await send(ada, "PATCH", `/api/products/alpha/members/${id}`, {
      areas: ["commerce", "ship"],
    });
    expect(r.status).toBe(200);
    expect(r.b.unchanged).toBe(true);
    expect(
      await rows("SELECT * FROM platform_audit WHERE action LIKE 'rbac.%'"),
    ).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });

  it("mayChange: a narrowed admin cannot edit away areas it does not hold, or widen past its own", async () => {
    const nan = await person(env, db, "nan", { stepUp: true });
    await bind(db, nan.accountId, "product_admin", "product:alpha", [
      "members",
      "ship",
    ]);
    const bob = await person(env, db, "bob");
    const wide = await bind(
      db,
      bob.accountId,
      "product_admin",
      "product:alpha",
      ["core", "keys"],
    );
    // Rewriting [core, keys] to [ship] passes a grant check on [ship] alone; the edit also drops core and keys.
    const drop = await send(
      nan,
      "PATCH",
      `/api/products/alpha/members/${wide}`,
      { areas: ["ship"] },
    );
    expect(drop.status).toBe(403);
    expect(await storedAreas(wide)).toBe('["core","keys"]');
    const own = await bind(
      db,
      (await person(env, db, "eve")).accountId,
      "product_admin",
      "product:alpha",
      ["ship"],
    );
    const past = await send(
      nan,
      "PATCH",
      `/api/products/alpha/members/${own}`,
      { areas: ["ship", "keys"] },
    );
    expect(past.status).toBe(403);
    expect(await storedAreas(own)).toBe('["ship"]');
  });

  it("only the areas can change: a member, role or scope in the body is refused", async () => {
    const { adaStep, id } = await granted();
    for (const extra of [
      { member: "mbr_" + "A".repeat(22) },
      { role: "superadmin" },
      { scope: "platform" },
    ]) {
      const r = await send(
        adaStep,
        "PATCH",
        `/api/products/alpha/members/${id}`,
        { areas: ["ship"], ...extra },
      );
      expect(r.status).toBe(422);
    }
    expect(
      (await send(adaStep, "PATCH", `/api/products/alpha/members/${id}`, {}))
        .status,
    ).toBe(422);
    expect(
      (
        await send(adaStep, "PATCH", `/api/products/alpha/members/${id}`, {
          areas: ["bogus"],
        })
      ).status,
    ).toBe(422);
    expect(await storedAreas(id)).toBe('["ship","commerce"]');
  });

  it("widening your own binding is a self-grant", async () => {
    const nan = await person(env, db, "nan", { stepUp: true });
    const mine = await bind(
      db,
      nan.accountId,
      "product_admin",
      "product:alpha",
      ["members", "ship"],
    );
    await bind(db, nan.accountId, "product_admin", "product:beta", null);
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    // A Superadmin holds every area, so only D-g stops it widening its own stored binding.
    const own = await bind(
      db,
      root.accountId,
      "product_admin",
      "product:alpha",
      ["ship"],
    );
    const r = await send(root, "PATCH", `/api/bindings/${own}`, {
      areas: ["ship", "keys"],
    });
    expect(r.status).toBe(403);
    expect(r.b.error?.reason ?? r.b.reason).toBe("self_grant");
    expect(mine).toBeTruthy();
    // Widening it to every area is the same self-grant, whatever the engine allows a Superadmin.
    const wider = await send(root, "PATCH", `/api/bindings/${own}`, {
      areas: null,
    });
    expect(wider.status).toBe(403);
    expect(wider.b.error?.reason ?? wider.b.reason).toBe("self_grant");
    expect(await storedAreas(own)).toBe('["ship"]');
    // Narrowing your own binding is fine (taking access back only narrows): no step-up, no D-g.
    const own2 = await bind(
      db,
      root.accountId,
      "product_admin",
      "product:beta",
      ["ship", "keys"],
    );
    const narrow = await send(root, "PATCH", `/api/bindings/${own2}`, {
      areas: ["ship"],
    });
    expect(narrow.status).toBe(200);
    expect(narrow.b.widened).toBe(false);
    expect(await storedAreas(own2)).toBe('["ship"]');
  });

  it("budgets G5 notices per recipient: a grant/revoke cycle mails an address ten times an hour", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    let last: Body | undefined;
    for (let i = 0; i < 6; i++) {
      const made = await send(root, "POST", "/api/bindings", {
        member: bob.memberId,
        role: "product_admin",
        scope: "product:alpha",
        areas: null,
      });
      expect(made.status).toBe(201);
      last = (
        await send(root, "DELETE", `/api/bindings/${made.b.binding!.bindingId}`)
      ).b;
    }
    expect(mail.filter((m) => m.to === "bob@example.com")).toHaveLength(10);
    expect(mail.filter((m) => m.to === "root@example.com")).toHaveLength(10);
    // An over-budget notice counts as not sent; the change stands.
    expect(last!.notified).toMatchObject({ sent: 0, nobodyNotified: true });
  });

  it("a guarded write fails closed on a Db that cannot count batch changes", async () => {
    const root = await person(env, db, "root", {
      keepRoot: true,
      stepUp: true,
    });
    const bob = await person(env, db, "bob");
    const id = await bind(db, bob.accountId, "product_admin", "product:alpha", [
      "ship",
    ]);
    const original = db.batchChanges;
    (db as { batchChanges?: unknown }).batchChanges = undefined;
    try {
      await expect(send(root, "DELETE", `/api/bindings/${id}`)).rejects.toThrow(
        /batch changes/,
      );
    } finally {
      db.batchChanges = original;
    }
    expect(await storedAreas(id)).toBe('["ship"]');
  });

  it("DELETE needs no step-up, removes the grant at once, audits it, and emails", async () => {
    const root = await person(env, db, "root", { keepRoot: true });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "product_admin", "product:alpha", null);
    const id = await bind(
      db,
      bob.accountId,
      "console_access",
      "platform",
      null,
    );
    expect((await send(bob, "GET", "/api/products/alpha/members")).status).toBe(
      200,
    );
    const pa = (await db.first<{ id: string }>(
      "SELECT id FROM console_role_bindings WHERE role = 'product_admin'",
    ))!.id;
    const r = await send(root, "DELETE", `/api/bindings/${pa}`);
    expect(r.status).toBe(200);
    expect(await storedAreas(pa)).toBe("gone");
    expect((await send(bob, "GET", "/api/products/alpha/members")).status).toBe(
      403,
    );
    expect(
      await rows("SELECT * FROM platform_audit WHERE action = 'rbac.revoke'"),
    ).toHaveLength(1);
    expect(
      await rows(
        "SELECT * FROM audit WHERE product = 'alpha' AND action = 'rbac.revoke'",
      ),
    ).toHaveLength(1);
    expect(mail.map((m) => m.to).sort()).toEqual([
      "bob@example.com",
      "root@example.com",
    ]);
    expect(id).toBeTruthy();
    expect((await send(root, "DELETE", `/api/bindings/${pa}`)).status).toBe(
      404,
    );
  });

  it("D-c and G2: revoking needs what granting needs, and a Platform admin touches only Console access", async () => {
    const pam = await person(env, db, "pam");
    await bind(db, pam.accountId, "platform_admin", "platform", null);
    const nan = await person(env, db, "nan");
    await bind(db, nan.accountId, "product_admin", "product:alpha", [
      "members",
      "ship",
    ]);
    const a = await person(env, db, "a1");
    const wideAdmin = await bind(
      db,
      a.accountId,
      "product_admin",
      "product:alpha",
      null,
    );
    const b = await person(env, db, "b1");
    const other = await bind(
      db,
      b.accountId,
      "platform_admin",
      "platform",
      null,
    );
    const c = await person(env, db, "c1");
    const star = await bind(
      db,
      c.accountId,
      "product_admin",
      "products:*",
      null,
    );
    const d = await person(env, db, "d1");
    const sup = await bind(db, d.accountId, "superadmin", "platform", null);
    const e = await person(env, db, "e1");
    const ca = await bind(db, e.accountId, "console_access", "platform", null);
    // A narrowed admin cannot remove an all-areas admin; a Platform admin none of the product roles.
    expect(
      (await send(nan, "DELETE", `/api/products/alpha/members/${wideAdmin}`))
        .status,
    ).toBe(403);
    for (const id of [wideAdmin, other, star, sup])
      expect(
        (await send(pam, "DELETE", `/api/bindings/${id}`)).status,
        id,
      ).toBe(403);
    expect(await rows("SELECT * FROM console_role_bindings")).toHaveLength(7);
    expect((await send(pam, "DELETE", `/api/bindings/${ca}`)).status).toBe(200);
  });

  it("a products:* binding and a Superadmin binding are a Superadmin's alone; root cannot be revoked", async () => {
    const root = await person(env, db, "root", { keepRoot: true });
    const star = await bind(
      db,
      (await person(env, db, "c1")).accountId,
      "product_admin",
      "products:*",
      null,
    );
    const own = await bind(db, root.accountId, "superadmin", "platform", null);
    expect((await send(root, "DELETE", `/api/bindings/${star}`)).status).toBe(
      200,
    );
    // The root holder's stored Superadmin binding goes; the root rule (computed) does not.
    expect((await send(root, "DELETE", `/api/bindings/${own}`)).status).toBe(
      200,
    );
    const members = await send(root, "GET", "/api/members");
    expect(members.status).toBe(200);
    expect(JSON.stringify(members.b)).toContain('"source":"root"');
    expect((await send(root, "GET", "/api/platform/version")).status).toBe(200);
  });

  it("an unreadable stored row can be cleared by a Superadmin only", async () => {
    const root = await person(env, db, "root", { keepRoot: true });
    const ada = await person(env, db, "ada");
    await bind(db, ada.accountId, "product_admin", "product:alpha", null);
    const bob = await person(env, db, "bob");
    const bad = await bind(
      db,
      bob.accountId,
      "product_admin",
      "product:alpha",
      ["ship"],
    );
    await db.run(
      "UPDATE console_role_bindings SET areas_json = '[\"nope\"]' WHERE id = ?",
      bad,
    );
    expect(
      (await send(ada, "DELETE", `/api/products/alpha/members/${bad}`)).status,
    ).toBe(403);
    expect((await send(root, "DELETE", `/api/bindings/${bad}`)).status).toBe(
      200,
    );
  });

  it("a concurrent change makes the edit a 409 that writes neither the change nor its audit rows", async () => {
    const { adaStep, id } = await granted();
    const real = db.batchChanges!.bind(db);
    db.batchChanges = async (statements) => {
      await db.run(
        "UPDATE console_role_bindings SET areas_json = '[\"keys\"]' WHERE id = ?",
        id,
      );
      return real(statements);
    };
    const r = await send(
      adaStep,
      "PATCH",
      `/api/products/alpha/members/${id}`,
      {
        areas: ["ship"],
      },
    );
    expect(r.status).toBe(409);
    expect(await storedAreas(id)).toBe('["keys"]');
    expect(
      await rows("SELECT * FROM platform_audit WHERE action LIKE 'rbac.%'"),
    ).toHaveLength(0);
    expect(
      await rows("SELECT * FROM audit WHERE action LIKE 'rbac.%'"),
    ).toHaveLength(0);
  });

  it("every write refuses a request without the CSRF token", async () => {
    const { adaStep, id } = await granted();
    for (const [m, path, body] of [
      ["PATCH", `/api/products/alpha/members/${id}`, { areas: ["ship"] }],
      ["DELETE", `/api/products/alpha/members/${id}`, undefined],
      ["DELETE", `/api/bindings/${id}`, undefined],
    ] as const) {
      const r = await send(adaStep, m, path, body, { csrf: false });
      expect(r.status, `${m} ${path}`).toBe(403);
    }
    expect(await storedAreas(id)).toBe('["ship","commerce"]');
  });

  it("an edit carries a guard: a stale expectation changes nothing", async () => {
    const bob = await person(env, db, "bob");
    const id = await bind(db, bob.accountId, "product_admin", "product:alpha", [
      "ship",
    ]);
    const stale = stmtUpdateBindingAreas(id, ["ship", "keys"], '["commerce"]');
    const [changes] = await db.batchChanges!([stale]);
    expect(changes).toBe(0);
    expect(await storedAreas(id)).toBe('["ship"]');
    const g = bindingUnchangedSql(id, '["ship"]');
    expect(
      await db.first(`SELECT 1 AS ok WHERE ${g.sql}`, ...g.params),
    ).toEqual({ ok: 1 });
  });
});
