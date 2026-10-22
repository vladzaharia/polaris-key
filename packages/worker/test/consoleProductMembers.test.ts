/**
 * ST-31.5: the product Members read API and GET /access/admins from bindings. Each person signs in through the real callback (so the
 * cookie, the session row and the strong console link are real); the IdP groups are then stripped
 * from the link, which leaves a signed-in non-root member (as in rbacStoredPrincipal.test.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";
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
import { ADMIN_COOKIE } from "../src/core/console/session.js";
import { newBindingId, stmtInsertBinding } from "../src/core/rbac/bindings.js";
import type { AreaId } from "../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../src/core/rbac/can.js";

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
  path: string,
  now = NOW + 1,
): Promise<Response> {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      headers: { cookie: `${ADMIN_COOKIE}=${p.token}` },
    }) as unknown as Request,
    env,
    db,
    path,
    { now },
  );
}

let env: Env;
let db: Db;

beforeEach(async () => {
  resetConsoleSessionCache();
  env = adminEnv();
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
});

interface Admin {
  name: string;
  email: string;
  role: string;
}
async function admins(p: Person, q: string): Promise<Admin[]> {
  const res = await call(env, db, p, `/api/access/admins?${q}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { admins: Admin[] }).admins;
}

describe("GET /products/:slug/members", () => {
  it("lists bindings, open invites and the read-only platform roles, with ids only as member ids", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const ann = await person(env, db, "ann");
    const cat = await person(env, db, "cat");
    const wide = await person(env, db, "wes");
    const plat = await person(env, db, "pat");
    const sup = await person(env, db, "sue");
    await bind(db, ann.accountId, "product_admin", "product:alpha", [
      "ship",
      "members",
    ]);
    await bind(db, cat.accountId, "product_admin", "product:beta", null);
    await bind(db, wide.accountId, "product_admin", "products:*", null);
    await bind(db, plat.accountId, "platform_admin", "platform", null);
    await bind(db, sup.accountId, "superadmin", "platform", null);
    await bind(db, null, "product_admin", "product:alpha", ["ship"], {
      emailNorm: "new@example.com",
      source: "invite",
    });
    await bind(db, null, "product_admin", "product:beta", null, {
      emailNorm: "other@example.com",
      source: "invite",
    });
    const res = await call(env, db, root, "/api/products/alpha/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product: string;
      members: { email: string; roles: { areas: string[] | null }[] }[];
      invites: { email: string }[];
      platformRoles: { email: string; role: string; source: string }[];
    };
    expect(body.product).toBe("alpha");
    expect(body.members.map((m) => m.email)).toEqual(["ann@example.com"]);
    expect(body.members[0]!.roles[0]!.areas).toEqual(["members", "ship"]);
    expect(body.invites.map((i) => i.email)).toEqual(["new@example.com"]);
    expect(body.platformRoles.map((r) => [r.email, r.role, r.source])).toEqual([
      ["rita@example.com", "superadmin", "root"],
      ["sue@example.com", "superadmin", "grant"],
      ["wes@example.com", "product_admin", "grant"],
    ]);
    // No platform admin, and no account id anywhere.
    expect(JSON.stringify(body)).not.toContain("pat@example.com");
    for (const p of [root, ann, cat, wide, plat, sup])
      expect(JSON.stringify(body)).not.toContain(p.accountId);
  });

  it("refuses a narrowed admin without `members`, and a product admin of another product", async () => {
    const ship = await person(env, db, "sam");
    await bind(db, ship.accountId, "product_admin", "product:alpha", ["ship"]);
    expect(
      (await call(env, db, ship, "/api/products/alpha/members")).status,
    ).toBe(403);
    expect(
      (await call(env, db, ship, "/api/products/beta/members")).status,
    ).toBe(403);
    const none = await person(env, db, "nia");
    expect(
      (await call(env, db, none, "/api/products/alpha/members")).status,
    ).toBe(403);
  });

  it("lets a narrowed admin holding `members` read it", async () => {
    const mgr = await person(env, db, "meg");
    await bind(db, mgr.accountId, "product_admin", "product:alpha", [
      "members",
    ]);
    const res = await call(env, db, mgr, "/api/products/alpha/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: { you: boolean }[] };
    expect(body.members.map((m) => m.you)).toEqual([true]);
  });
});

describe("GET /access/admins from bindings", () => {
  it("names the product's admins narrowest first, then Superadmins, at most three, never the caller", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const caller = await person(env, db, "carl");
    await bind(db, caller.accountId, "product_admin", "product:alpha", [
      "ship",
    ]);
    const wide = await person(env, db, "wide");
    const two = await person(env, db, "two");
    const one = await person(env, db, "one");
    await bind(db, wide.accountId, "product_admin", "product:alpha", null);
    await bind(db, two.accountId, "product_admin", "product:alpha", [
      "ship",
      "members",
    ]);
    await bind(db, one.accountId, "product_admin", "product:alpha", [
      "members",
    ]);
    // Holds `members` but not the asked area, and a Platform admin: neither is named.
    const noArea = await person(env, db, "noarea");
    await bind(db, noArea.accountId, "product_admin", "product:alpha", [
      "members",
      "core",
    ]);
    const plat = await person(env, db, "plat");
    await bind(db, plat.accountId, "platform_admin", "platform", null);
    expect(root.accountId).toBeTruthy();

    // `ship` + `members`: narrowest first, so the two-area admin, then the all-areas one; the
    // admin who lacks `ship` is not named; the Superadmin fills the third place.
    expect(await admins(caller, "scope=product:alpha&area=ship")).toEqual([
      { name: "two", email: "two@example.com", role: "product_admin" },
      { name: "wide", email: "wide@example.com", role: "product_admin" },
      { name: "rita", email: "rita@example.com", role: "superadmin" },
    ]);
    // `members` only: the one-area admin leads, then the two-area ones (their tie is by grant time).
    const list = await admins(caller, "scope=product:alpha&area=members");
    expect(list[0]!.name).toBe("one");
    expect(
      list
        .slice(1)
        .map((a) => a.name)
        .sort(),
    ).toEqual(["noarea", "two"]);
    expect(JSON.stringify(list)).not.toContain("plat@");
    for (const p of [root, caller, wide, two, one, noArea, plat])
      expect(JSON.stringify(list)).not.toContain(p.accountId);
  });

  it("adds stored Superadmin bindings to the root holders", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const sue = await person(env, db, "sue");
    await bind(db, sue.accountId, "superadmin", "platform", null);
    const caller = await person(env, db, "carl");
    await bind(db, caller.accountId, "console_access", "platform", null);
    expect(root.accountId).toBeTruthy();
    expect(
      (await admins(caller, "scope=platform&area=console")).map((a) => a.name),
    ).toEqual(["rita", "sue"]);
  });

  it("does not count a sign-in or an audit row as a Superadmin", async () => {
    const caller = await person(env, db, "carl");
    await bind(db, caller.accountId, "console_access", "platform", null);
    // A past root sign-in that no longer asserts the group.
    await person(env, db, "ghost");
    expect(await admins(caller, "scope=platform&area=console")).toEqual([]);
  });

  it("answers a non-holder exactly as for a product that does not exist (Superadmins only)", async () => {
    await person(env, db, "rita", { keepRoot: true });
    const holder = await person(env, db, "hal");
    await bind(db, holder.accountId, "product_admin", "product:alpha", null);
    const outsider = await person(env, db, "olly");
    await bind(db, outsider.accountId, "product_admin", "product:beta", null);
    const real = await admins(outsider, "scope=product:alpha&area=ship");
    const fake = await admins(outsider, "scope=product:zzz&area=ship");
    expect(real).toEqual(fake);
    expect(real).toEqual([
      { name: "rita", email: "rita@example.com", role: "superadmin" },
    ]);
    // The holder of alpha does see its admins; the outsider's own product shows its own.
    const own = await admins(holder, "scope=product:alpha&area=ship");
    expect(own.map((a) => a.role)).toEqual(["superadmin"]);
    const other = await person(env, db, "otto");
    await bind(db, other.accountId, "product_admin", "product:alpha", [
      "ship",
      "members",
    ]);
    expect((await admins(holder, "scope=product:alpha&area=ship"))[0]).toEqual({
      name: "otto",
      email: "otto@example.com",
      role: "product_admin",
    });
    expect(await admins(outsider, "scope=product:alpha&area=ship")).toEqual(
      real,
    );
  });

  it("does not name an inactive account", async () => {
    const caller = await person(env, db, "carl");
    await bind(db, caller.accountId, "product_admin", "product:alpha", null);
    const gone = await person(env, db, "gone");
    await bind(db, gone.accountId, "product_admin", "product:alpha", null);
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      gone.accountId,
    );
    expect(await admins(caller, "scope=product:alpha&area=ship")).toEqual([]);
  });
});
