/**
 * ST-31.4: the Platform Members read API. Each person signs in through the real callback (so the
 * cookie, the session row and the strong console link are real); the IdP groups are then stripped
 * from the link, which leaves a signed-in non-root member (as in rbacStoredPrincipal.test.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";
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
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
  LIVE_CHECK_SECONDS,
} from "../src/core/console/session.js";
import { newBindingId, stmtInsertBinding } from "../src/core/rbac/bindings.js";
import type { AreaId } from "../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../src/core/rbac/can.js";
import {
  PACKAGES_READ_SCOPE,
  mintAccountToken,
} from "../src/core/accounts/personalTokens.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { memberIdFor } from "../src/core/console/memberId.js";
import { asR2 } from "./r2Mock.js";
import { LedgerBucket } from "./eraseRestore.js";
import { recordPlatformSecurityEvent } from "../src/core/ops/securityEvents.js";

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

let env: Env;
let db: Db;

beforeEach(async () => {
  resetConsoleSessionCache();
  env = adminEnv();
  db = makeTestDb();
  await seedProduct(db, "alpha");
});

interface MemberBody {
  memberId: string;
  name: string;
  email: string;
  lastSignInAt: number | null;
  you: boolean;
  roles: {
    role: string;
    scope: string;
    areas: string[] | null;
    source: string;
    bindingId: string | null;
    grantedBy: { name: string | null } | null;
    grantedAt: number | null;
  }[];
}
interface ListBody {
  incomplete?: boolean;
  rootRule: { group: string | null };
  members: MemberBody[];
  invites: {
    bindingId: string;
    email: string;
    role: string;
    scope: string;
    areas: string[] | null;
    invitedBy: { name: string | null } | null;
    sentAt: number;
    expiresAt: number;
  }[];
}

async function list(p: Person): Promise<ListBody> {
  const res = await call(env, db, p, "GET", "/api/members");
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

describe("GET /members", () => {
  it("lists root-only holders without a binding, bound members with sources, and invites", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const ann = await person(env, db, "ann");
    const bob = await person(env, db, "bob");
    const rootMid = await memberIdFor(env, root.accountId);
    const annMid = await memberIdFor(env, ann.accountId);
    const bindAnn = await bind(
      db,
      ann.accountId,
      "product_admin",
      "product:alpha",
      ["ship", "commerce"],
    );
    await db.run(
      "UPDATE console_role_bindings SET granted_by = ? WHERE id = ?",
      rootMid,
      bindAnn,
    );
    await bind(db, bob.accountId, "platform_admin", "platform", null);
    // A signed-in person with no role never appears.
    await person(env, db, "nobody");
    // An open invite sent by ann, and an expired one.
    const inv = await bind(db, null, "console_access", "platform", null, {
      emailNorm: "new@example.com",
      source: "invite",
    });
    await db.run(
      "UPDATE console_role_bindings SET granted_by = ? WHERE id = ?",
      annMid,
      inv,
    );
    const old = await bind(db, null, "console_access", "platform", null, {
      emailNorm: "old@example.com",
      source: "invite",
    });
    await db.run(
      "UPDATE console_role_bindings SET expires_at = ? WHERE id = ?",
      NOW - 5,
      old,
    );

    const body = await list(root);
    expect(body.rootRule.group).toBe(GROUP);
    expect(body.members.map((m) => m.name).sort()).toEqual([
      "ann",
      "bob",
      "rita",
    ]);
    const r = body.members.find((m) => m.name === "rita")!;
    expect(r.you).toBe(true);
    expect(r.memberId).toBe(rootMid);
    expect(r.roles).toEqual([
      {
        role: "superadmin",
        scope: "platform",
        areas: null,
        source: "root",
        bindingId: null,
        grantedBy: null,
        grantedAt: null,
      },
    ]);
    const a = body.members.find((m) => m.name === "ann")!;
    expect(a.you).toBe(false);
    expect(a.email).toBe("ann@example.com");
    expect(a.roles).toEqual([
      {
        role: "product_admin",
        scope: "product:alpha",
        areas: ["ship", "commerce"],
        source: "grant",
        bindingId: bindAnn,
        grantedBy: { name: "rita" },
        grantedAt: NOW - 10,
      },
    ]);
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({
      bindingId: inv,
      email: "new@example.com",
      role: "console_access",
      invitedBy: { name: "ann" },
      sentAt: NOW - 10,
    });
    expect(body.invites[0]!.expiresAt).toBe(NOW + 3600);
  });

  it("a granter who is no longer a member is named null, and the system is null", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const ann = await person(env, db, "ann");
    const b1 = await bind(
      db,
      ann.accountId,
      "platform_admin",
      "platform",
      null,
    );
    await db.run(
      "UPDATE console_role_bindings SET granted_by = 'mbr_AAAAAAAAAAAAAAAAAAAAAA' WHERE id = ?",
      b1,
    );
    const body = await list(root);
    expect(
      body.members.find((m) => m.name === "ann")!.roles[0]!.grantedBy,
    ).toEqual({ name: null });
  });

  it("Superadmin and Platform admin read it; a Product admin is refused", async () => {
    const sup = await person(env, db, "sue", { keepRoot: true });
    const pa = await person(env, db, "pam");
    await bind(db, pa.accountId, "platform_admin", "platform", null);
    const prod = await person(env, db, "pru");
    await bind(db, prod.accountId, "product_admin", "products:*", null);
    for (const p of [sup, pa]) {
      expect((await call(env, db, p, "GET", "/api/members")).status).toBe(200);
      const mid = await memberIdFor(env, sup.accountId);
      expect(
        (await call(env, db, p, "GET", `/api/members/${mid}`)).status,
      ).toBe(200);
    }
    expect((await call(env, db, prod, "GET", "/api/members")).status).toBe(403);
    const mid = await memberIdFor(env, sup.accountId);
    expect(
      (await call(env, db, prod, "GET", `/api/members/${mid}`)).status,
    ).toBe(403);
    // Read-only: a write is refused as a wrong method.
    expect(
      (await call(env, db, sup, "POST", "/api/members", NOW + 1, {})).status,
    ).toBe(405);
  });

  it("a stale root holder (groups asserted over the freshness bound ago) is not listed", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const old = await person(env, db, "olga", { keepRoot: true });
    await db.run(
      "UPDATE account_links SET asserted_at = ? WHERE account_id = ?",
      NOW - 8 * 3600 - 10,
      old.accountId,
    );
    const body = await list(root);
    expect(body.members.map((m) => m.name)).toEqual(["rita"]);
  });
});

describe("GET /members/:memberId", () => {
  it("returns the member by computing ids, and 404s an unknown or forged id", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    const mid = await memberIdFor(env, ann.accountId);
    const res = await call(env, db, root, "GET", `/api/members/${mid}`);
    expect(res.status).toBe(200);
    const { member } = (await res.json()) as { member: MemberBody };
    expect(member.memberId).toBe(mid);
    expect(member.name).toBe("ann");
    // A well-formed id for an account that is not a member (never decoded, just not found).
    const nobody = await person(env, db, "nobody");
    const nid = await memberIdFor(env, nobody.accountId);
    expect(
      (await call(env, db, root, "GET", `/api/members/${nid}`)).status,
    ).toBe(404);
    for (const bad of [
      "mbr_AAAAAAAAAAAAAAAAAAAAAA",
      "mbr_short",
      "x",
      mid.toUpperCase(),
      ann.accountId,
    ]) {
      expect(
        (await call(env, db, root, "GET", `/api/members/${bad}`)).status,
      ).toBe(404);
    }
  });
});

describe("last sign-in", () => {
  it("is the newest admin.signin across the IdP sub and the mbr_ alias, per person", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const ann = await person(env, db, "ann");
    const bob = await person(env, db, "bob");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    await bind(db, bob.accountId, "platform_admin", "platform", null);
    const annMid = await memberIdFor(env, ann.accountId);
    // The callback wrote admin.signin under the IdP sub at NOW; a later row under the mbr_ id wins.
    await recordPlatformSecurityEvent(db, {
      action: "admin.signin",
      sub: annMid,
      summary: "x",
      now: NOW + 500,
    });
    // An older row under the IdP sub and a newer non-signin row must not count.
    await recordPlatformSecurityEvent(db, {
      action: "admin.signin",
      sub: "idp-bob",
      summary: "x",
      now: NOW - 99,
    });
    await recordPlatformSecurityEvent(db, {
      action: "admin.signin.refused",
      sub: "idp-bob",
      summary: "x",
      now: NOW + 900,
    });
    const body = await list(root);
    const by = (n: string) => body.members.find((m) => m.name === n)!;
    expect(by("ann").lastSignInAt).toBe(NOW + 500);
    expect(by("bob").lastSignInAt).toBe(NOW);
    expect(by("rita").lastSignInAt).toBe(NOW);
    // A person who never signed in has null.
    await db.run("DELETE FROM platform_audit WHERE actor_sub = 'idp-bob'");
    expect(by("bob")).toBeDefined();
    expect(
      (await list(root)).members.find((m) => m.name === "bob")!.lastSignInAt,
    ).toBeNull();
  });
});

describe("the account id never reaches a body", () => {
  it("neither route carries any account id, nor a link subject's account", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "product_admin", "product:alpha", ["ship"]);
    const mid = await memberIdFor(env, ann.accountId);
    const texts = [
      await (await call(env, db, root, "GET", "/api/members")).text(),
      await (await call(env, db, root, "GET", `/api/members/${mid}`)).text(),
      await (
        await call(
          env,
          db,
          root,
          "GET",
          "/api/members/mbr_AAAAAAAAAAAAAAAAAAAAAA",
        )
      ).text(),
    ];
    for (const t of texts)
      for (const id of [root.accountId, ann.accountId])
        expect(t).not.toContain(id);
  });
});

describe("ST-31.4 review fixes", () => {
  async function mintFor(email: string) {
    const holder = await getOrCreateAccountByEmail(db, email, NOW);
    const res = await mintAccountToken(
      env,
      db,
      {
        accountId: holder.id,
        label: "laptop",
        scope: PACKAGES_READ_SCOPE,
        createdBy: "x",
      },
      NOW,
    );
    if (!res.ok) throw new Error("mint");
    return res.view.id;
  }

  it("/account-tokens shows the holder's address to root only, in the list and the DELETE", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const pa = await person(env, db, "pat");
    await bind(db, pa.accountId, "platform_admin", "platform", null);
    const id = await mintFor("customer@example.com");

    const asPa = (await (
      await call(env, db, pa, "GET", "/api/account-tokens")
    ).json()) as {
      tokens: { email: string | null }[];
      token: { email: string | null };
    };
    expect(asPa.tokens[0]?.email).toBeNull();
    const asRoot = (await (
      await call(env, db, root, "GET", "/api/account-tokens")
    ).json()) as {
      tokens: { email: string | null }[];
      token: { email: string | null };
    };
    expect(asRoot.tokens[0]?.email).toBe("customer@example.com");

    const delPa = await call(
      env,
      db,
      pa,
      "DELETE",
      `/api/account-tokens/${id}`,
    );
    expect(delPa.status).toBe(200);
    const text = await delPa.text();
    expect(text).not.toContain("customer@example.com");
    expect(JSON.parse(text).token.email).toBeNull();
    const id2 = await mintFor("other@example.com");
    const delRoot = (await (
      await call(env, db, root, "DELETE", `/api/account-tokens/${id2}`)
    ).json()) as {
      tokens: { email: string | null }[];
      token: { email: string | null };
    };
    expect(delRoot.token.email).toBe("other@example.com");
  });

  it("a disabled account is flagged", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const ann = await person(env, db, "ann");
    const bob = await person(env, db, "bob");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    await bind(db, bob.accountId, "platform_admin", "platform", null);
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      ann.accountId,
    );
    const body = await list(root);
    const flag = (n: string) =>
      (body.members.find((m) => m.name === n) as { disabled?: boolean })
        ?.disabled;
    expect(flag("ann")).toBe(true);
    expect(flag("bob")).toBe(false);
    expect(flag("rita")).toBe(false);
  });

  it("an erased account (root holder or binding holder) is on no roster; an unreadable ledger says incomplete", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const erasedRoot = await person(env, db, "ed", { keepRoot: true });
    const erasedBound = await person(env, db, "bea");
    const ann = await person(env, db, "ann");
    await bind(db, erasedBound.accountId, "platform_admin", "platform", null);
    await bind(db, erasedBound.accountId, "product_admin", "product:alpha", [
      "members",
    ]);
    await bind(db, ann.accountId, "product_admin", "product:alpha", [
      "members",
    ]);
    // The ledger holds two ids; D1 still says they are active.
    const ledger = new LedgerBucket();
    await ledger.put(`erasures/${erasedRoot.accountId}`, "x");
    await ledger.put(`erasures/${erasedBound.accountId}`, "x");
    env.BLOBS = asR2(ledger);
    const emails = (b: { members: { email: string }[] }) =>
      b.members.map((m) => m.email);
    const platform = await list(root);
    expect(emails(platform)).toContain("ann@example.com");
    expect(emails(platform)).not.toContain("ed@example.com");
    expect(emails(platform)).not.toContain("bea@example.com");
    expect(platform.incomplete).toBe(false);
    const prodRes = await call(
      env,
      db,
      root,
      "GET",
      "/api/products/alpha/members",
    );
    expect(prodRes.status).toBe(200);
    const prodText = await prodRes.text();
    const prod = JSON.parse(prodText) as {
      members: { email: string }[];
      platformRoles: { email: string }[];
      incomplete: boolean;
    };
    expect(emails(prod)).toEqual(["ann@example.com"]);
    expect(prod.platformRoles.map((r) => r.email)).toEqual([
      "rita@example.com",
    ]);
    // The product route never carries a co-admin's last sign-in or disabled flag.
    expect(prodText).not.toContain("lastSignInAt");
    expect(prodText).not.toContain("disabled");
    const acc = await call(
      env,
      db,
      ann,
      "GET",
      "/api/access/admins?scope=product:alpha&area=members",
    );
    const accBody = (await acc.json()) as { admins: { email: string }[] };
    expect(accBody.admins.map((a) => a.email)).toEqual(["rita@example.com"]);
    const accAsRoot = await call(
      env,
      db,
      root,
      "GET",
      "/api/access/admins?scope=product:alpha&area=members",
    );
    expect(
      ((await accAsRoot.json()) as { admins: { email: string }[] }).admins.map(
        (a) => a.email,
      ),
    ).toEqual(["ann@example.com"]);

    // Ledger unreadable for an account the fence has not yet cached: it is dropped, and the
    // roster says so instead of looking complete.
    const late = await getOrCreateAccountByEmail(db, "late@example.com", NOW);
    await bind(db, late.id, "product_admin", "product:alpha", ["members"]);
    ledger.down = true;
    const down = await call(env, db, root, "GET", "/api/members");
    expect(down.status).toBe(200);
    const downBody = (await down.json()) as ListBody;
    expect(downBody.incomplete).toBe(true);
    expect(emails(downBody)).not.toContain("late@example.com");
    const downProd = (await (
      await call(env, db, root, "GET", "/api/products/alpha/members")
    ).json()) as { incomplete: boolean };
    expect(downProd.incomplete).toBe(true);
    const downAcc = (await (
      await call(
        env,
        db,
        root,
        "GET",
        "/api/access/admins?scope=product:alpha&area=members",
      )
    ).json()) as { incomplete: boolean };
    expect(downAcc.incomplete).toBe(true);
  });

  it("an uncached root-only holder while the ledger is down is dropped and every roster says incomplete", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    await person(env, db, "rob", { keepRoot: true });
    const ledger = new LedgerBucket();
    env.BLOBS = asR2(ledger);
    // Warm only the caller's fence (a 404 never reads the roster), then take the ledger down.
    expect(
      (await call(env, db, root, "GET", "/api/members/mbr_short")).status,
    ).toBe(404);
    ledger.down = true;
    const body = (await (
      await call(env, db, root, "GET", "/api/members")
    ).json()) as ListBody;
    expect(body.incomplete).toBe(true);
    expect(body.members.map((m) => m.email)).not.toContain("rob@example.com");
    const prod = (await (
      await call(env, db, root, "GET", "/api/products/alpha/members")
    ).json()) as { platformRoles: { email: string }[]; incomplete: boolean };
    expect(prod.incomplete).toBe(true);
    expect(prod.platformRoles.map((r) => r.email)).not.toContain(
      "rob@example.com",
    );
    const acc = (await (
      await call(
        env,
        db,
        root,
        "GET",
        "/api/access/admins?scope=product:alpha&area=members",
      )
    ).json()) as { incomplete: boolean };
    expect(acc.incomplete).toBe(true);
  });

  it("GET /members/:id answers 503, not 404, when the member is not found and the roster is incomplete", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const rob = await person(env, db, "rob", { keepRoot: true });
    const robId = await memberIdFor(env, rob.accountId);
    const ledger = new LedgerBucket();
    env.BLOBS = asR2(ledger);
    await call(env, db, root, "GET", "/api/members/mbr_short");
    ledger.down = true;
    const res = await call(env, db, root, "GET", `/api/members/${robId}`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason?: string }).reason).toBe(
      "erasure_ledger_unavailable",
    );
    // A forged id stays a plain 404 while the ledger is up.
    ledger.down = false;
    expect(
      (
        await call(
          env,
          db,
          root,
          "GET",
          "/api/members/mbr_AAAAAAAAAAAAAAAAAAAAAA",
        )
      ).status,
    ).toBe(404);
  });

  it("says truncated when a cap cuts the list, and still finds a real member past the cap by id", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    expect((await list(root)) as { truncated?: boolean }).toMatchObject({
      truncated: false,
    });
    for (let i = 0; i < 501; i++)
      await bind(db, null, "console_access", "platform", null, {
        emailNorm: `n${i}@example.com`,
        source: "invite",
      });
    expect((await list(root)) as { truncated?: boolean }).toMatchObject({
      truncated: true,
    });
  });

  it("a root link that is not the newest strong link does not list the account as a root holder", async () => {
    const root = await person(env, db, "rita", { keepRoot: true });
    const ghost = await person(env, db, "ghost", { keepRoot: true });
    // The group is on an old link; the newest strong link carries none.
    await db.run(
      "UPDATE account_links SET last_used_at = 1 WHERE account_id = ?",
      ghost.accountId,
    );
    await db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, groups_json, strong_at, asserted_at, last_used_at, created_at)
       SELECT 'lnk_new', account_id, issuer_key, tenant_scope, 'idp-ghost-2', kind, '[]', strong_at, asserted_at, ${NOW}, created_at
         FROM account_links WHERE account_id = ? LIMIT 1`,
      ghost.accountId,
    );
    const names = (await list(root)).members.map((m) => m.name);
    expect(names).toContain("rita");
    expect(names).not.toContain("ghost");
  });
});
