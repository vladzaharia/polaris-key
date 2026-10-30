/**
 * ST-31.8: the sign-in gate and invite conversion. A person who is not root signs in through the
 * real callback; the pre-gate admits a root holder, a known member, or an identity the IdP vouched
 * an address for that has an unexpired invite; `convertInvites` then turns the invites on the
 * account's verified primary email into its bindings (REV-ST31-7's ten must-enforce items); the
 * post-gate ends a session that still holds no grant. Each item below names its number.
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
import { convertInvites } from "../../../src/console/inviteConversion.js";
import { consoleAssertedEmail } from "../../../src/services/identity/consoleAccount.js";
import { resetConsoleSessionCache } from "../../../src/console/consoleSession.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import {
  INVITE_TTL_SECONDS,
  newBindingId,
  stmtInsertBinding,
  stmtsConvertInvite,
  type BindingRow,
} from "../../../src/core/rbac/bindings.js";
import type { AreaId } from "../../../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../../../src/core/rbac/can.js";
import { memberIdFor } from "../../../src/core/console/memberId.js";
import { erasureKey } from "../../../src/core/accounts/erasureFence.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";

type Db = ReturnType<typeof makeTestDb>;
interface Mail {
  to: string;
  subject: string;
  text: string;
}

let mail: Mail[];
let env: Env;
let db: Db;

beforeEach(async () => {
  resetConsoleSessionCache();
  mail = [];
  env = makeEnv(new KvMock(), ["alpha", "beta"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.EMAIL = {
    send: async (m: Mail) => {
      mail.push(m);
    },
  } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
});

interface Idp {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  groups?: string[];
}

/** One run of the real callback; returns the response and the cookie claims when it signed in. */
async function signInWith(idp: Idp, now = NOW, stepUp = false) {
  const start = await handleAdminLogin(
    new Request(
      `https://key.plrs.im/manage/login?go=1${stepUp ? "&stepUp=1" : ""}`,
    ) as unknown as Request,
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: idp.sub,
      email: idp.email ?? `${idp.sub.replace(/^idp-/, "")}@example.com`,
      emailVerified: idp.emailVerified ?? true,
      name: idp.sub,
      groups: idp.groups ?? [],
      ...(stepUp ? { authTime: NOW } : {}),
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie: await bindAdminFlow(env, state) },
    }) as unknown as Request,
    env,
    db,
    now,
    verifier,
  );
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie || !setCookie.includes(ADMIN_COOKIE))
    return { res, signedIn: false as const };
  const cookie = setCookie.split(";")[0]!;
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const claims = JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
  ) as { aid: string; csrf: string };
  return { res, signedIn: true as const, token, ...claims };
}

/** The root operator (IdP group), signed in; the usual inviter. */
async function root() {
  const s = await signInWith({ sub: "idp-root", groups: [GROUP] });
  if (!s.signedIn) throw new Error("root sign-in failed");
  return { ...s, memberId: await memberIdFor(env, s.aid) };
}

async function invite(
  email: string,
  role: Role,
  scope: GrantScope,
  areas: AreaId[] | null,
  grantedBy: string | null,
  opts: { expiresAt?: number; id?: string } = {},
): Promise<string> {
  const id = opts.id ?? newBindingId();
  const s = stmtInsertBinding({
    id,
    accountId: null,
    emailNorm: email,
    role,
    scope,
    areas,
    source: "invite",
    grantedBy,
    grantedAt: NOW,
    expiresAt: opts.expiresAt ?? NOW + INVITE_TTL_SECONDS,
  });
  await db.run(s.sql, ...s.params);
  return id;
}

async function bind(
  accountId: string,
  role: Role,
  scope: GrantScope,
  areas: AreaId[] | null,
) {
  const s = stmtInsertBinding({
    id: newBindingId(),
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
}

const mine = (aid: string) =>
  db.all<{
    role: string;
    scope: string;
    areas_json: string | null;
    source: string;
    granted_by: string | null;
  }>(
    "SELECT role, scope, areas_json, source, granted_by FROM console_role_bindings WHERE account_id = ? ORDER BY role, scope",
    aid,
  );
const invites = () =>
  db.all<{ id: string; email_norm: string }>(
    "SELECT id, email_norm FROM console_role_bindings WHERE email_norm IS NOT NULL",
  );
const accountCount = async () =>
  (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM accounts"))!.n;
const grantAudits = () =>
  db.all<{ summary: string }>(
    "SELECT summary FROM audit WHERE action = 'rbac.grant' ORDER BY rowid",
  );

/** Sign `who` in once with a harmless invite so the account exists, and return its id. */
async function member(who: string, grantedBy: string) {
  await invite(
    `${who}@example.com`,
    "console_access",
    "platform",
    null,
    grantedBy,
  );
  const s = await signInWith({ sub: `idp-${who}` });
  if (!s.signedIn) throw new Error(`${who} did not sign in`);
  return {
    aid: s.aid,
    memberId: await memberIdFor(env, s.aid),
    email: `${who}@example.com`,
  };
}

const operator = (aid: string, email: string, now = NOW + 5) =>
  convertInvites(env, db, now, {
    accountId: aid,
    assertedEmail: email,
    via: "operator",
  });

describe("the gate", () => {
  it("a new console link with an invite converts and signs in; a second sign-in converts nothing (9)", async () => {
    const r = await root();
    const id = await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["ship"],
      r.memberId,
    );
    const s = await signInWith({ sub: "idp-dana" });
    expect(s.signedIn).toBe(true);
    if (!s.signedIn) return;
    expect(await mine(s.aid)).toEqual([
      {
        role: "product_admin",
        scope: "product:alpha",
        areas_json: '["ship"]',
        source: "invite",
        granted_by: r.memberId,
      },
    ]);
    expect((await invites()).map((i) => i.id)).not.toContain(id);
    expect((await grantAudits()).length).toBeGreaterThan(0);
    // The inviter (also a Superadmin) hears about it.
    expect(
      mail.some((m) => m.subject.startsWith("Console invitation accepted")),
    ).toBe(true);
    // 9: a repeat sign-in converts nothing and still signs in.
    const before = (await grantAudits()).length;
    const again = await signInWith({ sub: "idp-dana" });
    expect(again.signedIn).toBe(true);
    expect((await grantAudits()).length).toBe(before);
    expect(await mine(s.aid)).toHaveLength(1);
  });

  it("expired invite, mismatched address and unverified address are each refused with no account written", async () => {
    const r = await root();
    const accounts = await accountCount();
    await invite(
      "eve@example.com",
      "console_access",
      "platform",
      null,
      r.memberId,
    );
    // Expired: the sign-in happens after the invite's lifetime.
    const late = await signInWith(
      { sub: "idp-eve" },
      NOW + INVITE_TTL_SECONDS + 10,
    );
    expect(late.signedIn).toBe(false);
    // Mismatch: the IdP vouches for another address.
    const other = await signInWith({
      sub: "idp-eve",
      email: "someone@example.com",
    });
    expect(other.signedIn).toBe(false);
    // Unverified: the right address, not vouched for.
    const unverified = await signInWith({
      sub: "idp-eve",
      email: "eve@example.com",
      emailVerified: false,
    });
    expect(unverified.signedIn).toBe(false);
    expect(await accountCount()).toBe(accounts);
    expect(await invites()).toHaveLength(1);
  });

  it("an email-code-only account with an invite is refused (method) and the invite stays", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await db.run(
      "UPDATE account_links SET strong_at = NULL WHERE account_id = ?",
      dana.aid,
    );
    await db.run(
      "DELETE FROM console_role_bindings WHERE account_id = ?",
      dana.aid,
    );
    await invite(
      "dana@example.com",
      "console_access",
      "platform",
      null,
      r.memberId,
    );
    const s = await signInWith({ sub: "idp-dana" });
    expect(s.signedIn).toBe(false);
    expect(await invites()).toHaveLength(1);
    expect(await mine(dana.aid)).toHaveLength(0);
  });

  it("root is unchanged: a group member signs in with no binding and no invite", async () => {
    const s = await signInWith({ sub: "idp-root2", groups: [GROUP] });
    expect(s.signedIn).toBe(true);
  });

  it("the post-gate ends the new session row when no grant results (inviter lost authority)", async () => {
    const r = await root();
    const bob = await member("bob", r.memberId);
    await bind(bob.aid, "product_admin", "product:alpha", null);
    // Bob invites for beta, which a product admin of alpha may not grant.
    await invite(
      "fay@example.com",
      "product_admin",
      "product:beta",
      ["ship"],
      bob.memberId,
    );
    const s = await signInWith({ sub: "idp-fay" });
    expect(s.signedIn).toBe(false);
    const live = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM account_sessions s JOIN account_links l ON l.account_id = s.account_id
        WHERE l.subject = 'idp-fay' AND s.revoked_at IS NULL`,
    );
    expect(live!.n).toBe(0);
    expect(await invites()).toHaveLength(1);
  });

  it("audits a merge into an existing binding (union; NULL wins)", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await bind(dana.aid, "product_admin", "product:alpha", ["ship"]);
    await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["keys"],
      r.memberId,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(1);
    const held = await mine(dana.aid);
    const alpha = held.find((h) => h.scope === "product:alpha")!;
    expect(JSON.parse(alpha.areas_json!).sort()).toEqual(["keys", "ship"]);
    expect(
      (await grantAudits()).some((a) => a.summary.startsWith("Merged")),
    ).toBe(true);
    await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      null,
      r.memberId,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(1);
    expect(
      (await mine(dana.aid)).find((h) => h.scope === "product:alpha")!
        .areas_json,
    ).toBeNull();
  });
});

describe("the must-enforce list (REV-ST31-7)", () => {
  it("1: never converts when the inviter is the converting account (D-g)", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["ship"],
      dana.memberId,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
    expect((await invites()).length).toBe(1);
  });

  it("2: re-checks the inviter now (unknown, no longer a member, lost the authority, disabled)", async () => {
    const r = await root();
    const bob = await member("bob", r.memberId);
    const dana = await member("dana", r.memberId);
    const spec: [Role, GrantScope, AreaId[]] = [
      "product_admin",
      "product:alpha",
      ["ship"],
    ];
    // Unresolved inviter.
    await invite("dana@example.com", ...spec, "mbr_" + "0".repeat(20));
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
    await db.run(
      "DELETE FROM console_role_bindings WHERE email_norm IS NOT NULL",
    );
    // Inviter with no console grant any more.
    await db.run(
      "DELETE FROM console_role_bindings WHERE account_id = ?",
      bob.aid,
    );
    await invite("dana@example.com", ...spec, bob.memberId);
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
    await db.run(
      "DELETE FROM console_role_bindings WHERE email_norm IS NOT NULL",
    );
    // Inviter narrowed so it cannot grant what the invite grants.
    await bind(bob.aid, "product_admin", "product:beta", null);
    await invite("dana@example.com", ...spec, bob.memberId);
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
    await db.run(
      "DELETE FROM console_role_bindings WHERE email_norm IS NOT NULL",
    );
    // Disabled inviter (the root keeps its grant, but is disabled).
    await db.run("UPDATE accounts SET status = 'disabled' WHERE id = ?", r.aid);
    await invite("dana@example.com", ...spec, r.memberId);
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
  });

  it("3: the invite address must equal the verified primary email, asserted at this sign-in", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await db.run(
      "DELETE FROM console_role_bindings WHERE email_norm IS NOT NULL",
    );
    await invite(
      "other@example.com",
      "console_access",
      "platform",
      null,
      r.memberId,
    );
    // Asserted address is not the account's verified primary email.
    expect((await operator(dana.aid, "other@example.com")).converted).toBe(0);
    // No assertion at all.
    expect(
      (
        await convertInvites(env, db, NOW + 5, {
          accountId: dana.aid,
          assertedEmail: null,
          via: "operator",
        })
      ).converted,
    ).toBe(0);
    // The primary email unverified.
    await invite(
      "dana@example.com",
      "console_access",
      "platform",
      null,
      r.memberId,
    );
    await db.run(
      "UPDATE accounts SET primary_email_verified_at = NULL WHERE id = ?",
      dana.aid,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
  });

  it("4: an address verified on more than one active account converts for neither", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["ship"],
      r.memberId,
    );
    // A second active account holding the same verified primary address.
    await db.run(
      "INSERT INTO accounts (id, status, primary_email, primary_email_verified_at, created_at, modified_at) VALUES ('acct_twin', 'active', 'dana@example.com', ?, ?, ?)",
      NOW,
      NOW,
      NOW,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
  });

  it("5: a passkey converts only SM-6 eligible invites; the operator connection converts the rest", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await invite(
      "dana@example.com",
      "platform_admin",
      "platform",
      null,
      r.memberId,
    );
    const viaPasskey = await convertInvites(env, db, NOW + 5, {
      accountId: dana.aid,
      assertedEmail: dana.email,
      via: "passkey",
    });
    expect(viaPasskey.converted).toBe(0);
    expect((await invites()).length).toBe(1);
    await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["ship"],
      r.memberId,
    );
    expect(
      (
        await convertInvites(env, db, NOW + 5, {
          accountId: dana.aid,
          assertedEmail: dana.email,
          via: "passkey",
        })
      ).converted,
    ).toBe(1);
    expect((await operator(dana.aid, dana.email)).converted).toBe(1);
    expect((await mine(dana.aid)).map((m) => m.role)).toContain(
      "platform_admin",
    );
  });

  it("6: an erased or unreadable-ledger account, or a disabled one, converts nothing", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["ship"],
      r.memberId,
    );
    const blobs = env.BLOBS;
    env.BLOBS = {
      head: async (key: string) => {
        if (key === erasureKey(dana.aid)) throw new Error("r2 down");
        return null;
      },
    } as unknown as Env["BLOBS"];
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
    env.BLOBS = blobs;
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      dana.aid,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
    await db.run(
      "UPDATE accounts SET status = 'active' WHERE id = ?",
      dana.aid,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(1);
  });

  it("7: re-validates the row (unknown product, the system product, expired, unreadable)", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await invite(
      "dana@example.com",
      "product_admin",
      "product:ghost",
      ["ship"],
      r.memberId,
    );
    await invite(
      "dana@example.com",
      "product_admin",
      "product:system",
      ["ship"],
      r.memberId,
    );
    await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["ship"],
      r.memberId,
      { expiresAt: NOW + 1 },
    );
    expect((await operator(dana.aid, dana.email, NOW + 5)).converted).toBe(0);
    await db.run(
      "DELETE FROM console_role_bindings WHERE email_norm IS NOT NULL",
    );
    const id = await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["ship"],
      r.memberId,
    );
    await db.run(
      "UPDATE console_role_bindings SET areas_json = '[\"nonsense\"]' WHERE id = ?",
      id,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
  });

  it("8: the batch is guarded: a changed invite converts nothing, writes no binding and no audit", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    const id = await invite(
      "dana@example.com",
      "product_admin",
      "product:alpha",
      ["ship"],
      r.memberId,
    );
    const stale = (await db.first<BindingRow>(
      "SELECT * FROM console_role_bindings WHERE id = ?",
      id,
    ))!;
    // The invite is widened after the converter read it.
    await db.run(
      "UPDATE console_role_bindings SET areas_json = NULL WHERE id = ?",
      id,
    );
    const plan = stmtsConvertInvite({
      invite: stale,
      accountId: dana.aid,
      existing: null,
      newId: newBindingId(),
      now: NOW + 5,
    })!;
    await db.batch([...plan.write, plan.remove]);
    expect(
      (await mine(dana.aid)).filter((m) => m.scope === "product:alpha"),
    ).toHaveLength(0);
    expect((await invites()).map((i) => i.id)).toContain(id);
    // And the converter itself notifies only when its batch applied: the repeat finds nothing.
    expect((await operator(dana.aid, dana.email)).converted).toBe(1);
    const mails = mail.length;
    expect((await operator(dana.aid, dana.email)).converted).toBe(0);
    expect(mail.length).toBe(mails);
  });

  it("8: an L2 conversion notice is not silenced by a spent per-recipient budget (priority path)", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    // Spend the root's hourly operator-notice budget.
    const { OPERATOR_NOTICE_PER_RECIPIENT_HOUR } =
      await import("../../../src/console/handlers/accessShared.js");
    for (let i = 0; i < OPERATOR_NOTICE_PER_RECIPIENT_HOUR + 2; i++) {
      const c = await invite(
        `x${i}@example.com`,
        "console_access",
        "platform",
        null,
        r.memberId,
      );
      await db.run("DELETE FROM console_role_bindings WHERE id = ?", c);
    }
    mail = [];
    await invite(
      "dana@example.com",
      "platform_admin",
      "platform",
      null,
      r.memberId,
    );
    expect((await operator(dana.aid, dana.email)).converted).toBe(1);
    expect(
      mail.some((m) => m.subject.startsWith("Console invitation accepted")),
    ).toBe(true);
  });

  it("10: a D-e binding is immediate, so the gate never sees an invite for it", async () => {
    const stepped = await signInWith(
      { sub: "idp-root", groups: [GROUP] },
      NOW,
      true,
    );
    if (!stepped.signedIn) throw new Error("step-up sign-in failed");
    const r = { ...stepped, memberId: await memberIdFor(env, stepped.aid) };
    const dana = await member("dana", r.memberId);
    const res = await handleAdmin(
      new Request("https://key.plrs.im/manage/api/bindings", {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${r.token}`,
          [CSRF_HEADER]: r.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          emails: [dana.email],
          role: "product_admin",
          scope: "product:beta",
          areas: ["ship"],
        }),
      }) as unknown as Request,
      env,
      db,
      "/api/bindings",
      { now: NOW + 1 },
    );
    expect(res.status).toBe(201);
    expect((await mine(dana.aid)).some((m) => m.scope === "product:beta")).toBe(
      true,
    );
    expect(
      (await invites()).filter((i) => i.email_norm === dana.email),
    ).toHaveLength(0);
  });
});

describe("the slug oracle (404 before 403)", () => {
  it("an unknown product slug answers the same 403 as a real product the caller cannot reach", async () => {
    const r = await root();
    const dana = await member("dana", r.memberId);
    await bind(dana.aid, "product_admin", "product:alpha", null);
    const s = await signInWith({ sub: "idp-dana" });
    if (!s.signedIn) throw new Error("no session");
    const get = async (slug: string) => {
      const res = await handleAdmin(
        new Request(`https://key.plrs.im/manage/api/products/${slug}/members`, {
          headers: { cookie: `${ADMIN_COOKIE}=${s.token}` },
        }) as unknown as Request,
        env,
        db,
        `/api/products/${slug}/members`,
        { now: NOW + 1 },
      );
      return {
        status: res.status,
        body: (await res.json()) as {
          code?: string;
          reason?: string;
          area?: string;
          scope?: string;
        },
      };
    };
    const real = await get("beta");
    const ghost = await get("nope");
    expect(real.status).toBe(403);
    expect(ghost.status).toBe(403);
    expect(ghost.body.code).toBe(real.body.code);
    expect(ghost.body.reason).toBe(real.body.reason);
    expect(ghost.body.area).toBe(real.body.area);
    // A caller who can reach every product still learns an unknown slug is a 404.
    const res = await handleAdmin(
      new Request("https://key.plrs.im/manage/api/products/nope/members", {
        headers: { cookie: `${ADMIN_COOKIE}=${r.token}` },
      }) as unknown as Request,
      env,
      db,
      "/api/products/nope/members",
      { now: NOW + 1 },
    );
    expect(res.status).toBe(404);
  });
});

describe("the slug oracle holds on service route families too (ST-31.18)", () => {
  it.each(["devices", "keys", "activity"])(
    "/products/<slug>/%s answers an unknown slug like a real product the caller cannot reach",
    async (family) => {
      const r = await root();
      const dana = await member("dana", r.memberId);
      await bind(dana.aid, "product_admin", "product:alpha", null);
      const s = await signInWith({ sub: "idp-dana" });
      if (!s.signedIn) throw new Error("no session");
      const get = async (slug: string) => {
        const res = await handleAdmin(
          new Request(
            `https://key.plrs.im/manage/api/products/${slug}/${family}`,
            { headers: { cookie: `${ADMIN_COOKIE}=${s.token}` } },
          ) as unknown as Request,
          env,
          db,
          `/api/products/${slug}/${family}`,
          { now: NOW + 1 },
        );
        return {
          status: res.status,
          body: (await res.json()) as Record<string, unknown>,
        };
      };
      const real = await get("beta");
      const ghost = await get("nope");
      expect(real.status).toBe(403);
      expect(ghost.status).toBe(real.status);
      expect(ghost.body.code).toBe(real.body.code);
      expect(ghost.body.reason).toBe(real.body.reason);
      expect(ghost.body.area).toBe(real.body.area);
    },
  );
});

describe("the asserted address is plain ASCII before it is lower-cased (REV-ST31-8 note 1)", () => {
  it("a Kelvin-sign lookalike asserts nothing, so it cannot fold onto kate@x", () => {
    expect(
      consoleAssertedEmail({
        email: "\u212Aate@example.com",
        emailVerified: true,
      }),
    ).toBeNull();
    expect(
      consoleAssertedEmail({ email: "Kate@Example.com", emailVerified: true }),
    ).toBe("kate@example.com");
    expect(
      consoleAssertedEmail({ email: "kate@example.com", emailVerified: false }),
    ).toBeNull();
  });
});
