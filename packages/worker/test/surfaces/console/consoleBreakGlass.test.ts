/**
 * ST-30c.1: break-glass. `/manage/login?breakGlass=1` is an explicit flow for a Superadmin by the
 * IdP's group alone: a fresh login, no account, link or session row, no ST-31.8 gate or
 * conversion, an hour-long cookie of its own realm, an audit row and a notice to every
 * Superadmin. ST-28 plan §2.6 and §5.3 (items 9 and 14).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bindAdminFlow } from "../../flowBinderHelper.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
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
  BREAK_GLASS_TTL_SECONDS,
  CSRF_HEADER,
  issueSessionV2,
  STEP_UP_MAX_AGE_SECONDS,
  type SessionIdentity,
} from "../../../src/core/console/session.js";
import { requireAccountSession } from "../../../src/console/lib/accountSession.js";
import {
  newBindingId,
  stmtInsertBinding,
} from "../../../src/core/rbac/bindings.js";
import { importHmacKey } from "../../../src/platform/hash.js";
import { signHmacToken } from "../../../src/platform/hmacToken.js";
import { breakGlassUsedNotice } from "../../../src/core/notify/templates.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const SECRET = "test-admin-session-secret";

type Db = ReturnType<typeof makeTestDb>;
interface Mail {
  to: string;
  subject: string;
  text: string;
}

let mail: Mail[];
let env: Env;
let db: Db;

beforeEach(() => {
  resetConsoleSessionCache();
  mail = [];
  env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = SECRET;
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
});

interface Idp {
  sub?: string;
  email?: string;
  groups?: string[];
  authTime?: number | null;
}

/** The start of a flow; returns the state and the authorize URL. */
async function start(query = "go=1&breakGlass=1", ip = "203.0.113.9") {
  const res = await handleAdminLogin(
    new Request(`https://key.plrs.im/manage/login?${query}`, {
      headers: { "cf-connecting-ip": ip },
    }) as unknown as Request,
    env,
  );
  const location = new URL(res.headers.get("location")!);
  return { res, location, state: location.searchParams.get("state")! };
}

/** One break-glass run through the real login and callback. */
async function breakGlass(
  idp: Idp = {},
  opts: { now?: number; cookie?: (state: string) => Promise<string> } = {},
) {
  const now = opts.now ?? NOW;
  const { state } = await start();
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: idp.sub ?? "idp-bg",
      email: idp.email ?? "bg@example.com",
      emailVerified: true,
      name: "Break Glass",
      groups: idp.groups ?? [GROUP],
      ...(idp.authTime === null ? {} : { authTime: idp.authTime ?? now }),
    }),
  };
  const cookie = opts.cookie
    ? await opts.cookie(state)
    : await bindAdminFlow(env, state);
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie, "cf-connecting-ip": "203.0.113.9" },
    }) as unknown as Request,
    env,
    db,
    now,
    verifier,
  );
  const set = setCookies(res).find((c) => c.startsWith(ADMIN_COOKIE));
  const token = set ? set.split(";")[0]!.slice(ADMIN_COOKIE.length + 1) : null;
  const body = token
    ? (JSON.parse(
        Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>)
    : null;
  return { res, token, body, set };
}

/** A normal root sign-in (the usual operator), so a Superadmin with an address exists. */
async function normalRoot(n: number) {
  const { state } = await start(`go=1`, `198.51.100.${n}`);
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: `idp-root-${n}`,
      email: `root${n}@example.com`,
      emailVerified: true,
      name: `Root ${n}`,
      groups: [GROUP],
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: {
        cookie: await bindAdminFlow(env, state),
        "cf-connecting-ip": `198.51.100.${n}`,
      },
    }) as unknown as Request,
    env,
    db,
    NOW - 100,
    verifier,
  );
  expect(res.status).toBe(302);
}

async function call(
  token: string,
  now: number,
  method = "GET",
  path = "/api/me",
  csrf = "",
  body?: unknown,
) {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    env,
    db,
    path,
    { now },
  );
}

const setCookies = (res: Response): string[] =>
  (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();

const count = async (table: string) =>
  (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const audit = (action: string) =>
  db.all<{ actor_sub: string | null; summary: string }>(
    "SELECT actor_sub, summary FROM platform_audit WHERE action = ?",
    action,
  );
const noAccountRows = async () => ({
  accounts: await count("accounts"),
  links: await count("account_links"),
  sessions: await count("account_sessions"),
});

describe("the flow", () => {
  it("breakGlass=1 forces a fresh login at the IdP and records the flag in the flow", async () => {
    const { res, location } = await start();
    expect(res.status).toBe(302);
    expect(location.searchParams.get("prompt")).toBe("login");
    expect(location.searchParams.get("max_age")).toBe("0");
    // Without the flag nothing is forced.
    const plain = await start("go=1");
    expect(plain.location.searchParams.get("prompt")).toBeNull();
    // `other=1` cannot weaken it to the account chooser.
    const other = await start("go=1&breakGlass=1&other=1");
    expect(other.location.searchParams.get("prompt")).toBe("login");
  });

  it("the card's POST carries the flag too", async () => {
    const res = await handleAdminLogin(
      new Request("https://key.plrs.im/manage/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
        },
        body: "breakGlass=1",
      }) as unknown as Request,
      env,
    );
    expect(res.status).toBe(303);
    const u = new URL(res.headers.get("location")!);
    expect(u.searchParams.get("prompt")).toBe("login");
    expect(u.searchParams.get("max_age")).toBe("0");
  });

  it("is bound to the browser by the flow cookie: a missing or foreign cookie is refused", async () => {
    for (const cookie of [
      async () => "",
      async () => "__Host-pkey_admin_flow=somebody-elses-binder",
    ]) {
      const r = await breakGlass({}, { cookie });
      expect(r.res.status).toBe(400);
      expect(r.token).toBeNull();
    }
    expect(await audit("rbac.breakglass")).toHaveLength(0);
    expect(await noAccountRows()).toEqual({
      accounts: 0,
      links: 0,
      sessions: 0,
    });
  });
});

describe("the callback", () => {
  it("refuses an identity outside the group: 403, a refused event, nothing written", async () => {
    // Even a person with a stored binding and an invite: break-glass admits by the group alone.
    const r = await breakGlass({ groups: ["other"] });
    expect(r.res.status).toBe(403);
    expect(r.token).toBeNull();
    expect(await audit("admin.signin.refused")).toHaveLength(1);
    expect(await audit("rbac.breakglass")).toHaveLength(0);
    expect(await noAccountRows()).toEqual({
      accounts: 0,
      links: 0,
      sessions: 0,
    });
    expect(await count("console_role_bindings")).toBe(0);
  });

  it("with the group: a break-glass cookie, one rbac.breakglass row, no account, link or session", async () => {
    const r = await breakGlass();
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get("location")).toBe("/manage/");
    expect(r.token).toBeTruthy();
    expect(r.set).toContain(`Max-Age=${BREAK_GLASS_TTL_SECONDS}`);
    expect(r.set).toMatch(/HttpOnly/);
    expect(r.set).toMatch(/Secure/);
    expect(r.set).toMatch(/SameSite=Strict/);
    expect(r.body).toMatchObject({
      sub: "idp-bg",
      bg: true,
      exp: NOW + BREAK_GLASS_TTL_SECONDS,
      authAt: NOW,
      stepUpAt: NOW,
    });
    expect(r.body).not.toHaveProperty("aid");
    expect(r.body).not.toHaveProperty("sid");
    const rows = await audit("rbac.breakglass");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_sub).toBe("idp-bg");
    expect(rows[0]!.summary).not.toContain(r.token!);
    expect(await audit("admin.signin")).toHaveLength(0);
    expect(await noAccountRows()).toEqual({
      accounts: 0,
      links: 0,
      sessions: 0,
    });
    // The flow cookie is cleared.
    expect(
      setCookies(r.res).some((c) => c.startsWith("__Host-pkey_admin_flow=;")),
    ).toBe(true);
  });

  it("mails every Superadmin, within the cap, and the notice says who, when, where and what to do", async () => {
    await normalRoot(1);
    await normalRoot(2);
    const before = await noAccountRows();
    const r = await breakGlass();
    expect(r.res.status).toBe(302);
    expect(await noAccountRows()).toEqual(before);
    const got = mail.filter((m) => m.subject === "Emergency sign-in used");
    expect(got.map((m) => m.to).sort()).toEqual([
      "root1@example.com",
      "root2@example.com",
    ]);
    expect(got[0]!.text).toContain("rotate ADMIN_SESSION_SECRET");
    expect(got[0]!.text).toContain("bg@example");
    expect(got[0]!.text).toContain("from 203.0.113.9");
    expect(got[0]!.text).toContain("2023-11-14T22:13:20Z");
  });

  it("caps the notices at 25 addresses", async () => {
    for (let i = 1; i <= 27; i++) await normalRoot(i);
    await breakGlass();
    expect(
      mail.filter((m) => m.subject === "Emergency sign-in used"),
    ).toHaveLength(25);
  });

  it("refuses a stale auth_time, and an IdP that sent none", async () => {
    for (const authTime of [NOW - STEP_UP_MAX_AGE_SECONDS - 1, null]) {
      const r = await breakGlass({ authTime });
      expect(r.res.status).toBe(401);
      expect(r.token).toBeNull();
    }
    expect(await audit("rbac.breakglass")).toHaveLength(0);
    expect(await audit("admin.signin.refused")).toHaveLength(2);
    expect(await noAccountRows()).toEqual({
      accounts: 0,
      links: 0,
      sessions: 0,
    });
    // A recent one passes.
    expect(
      (await breakGlass({ authTime: NOW - STEP_UP_MAX_AGE_SECONDS })).res
        .status,
    ).toBe(302);
  });

  it("converts no invite and applies no ST-31.8 gate (items 9 and 14)", async () => {
    const s = stmtInsertBinding({
      id: newBindingId(),
      accountId: null,
      emailNorm: "bg@example.com",
      role: "console_access",
      scope: "platform",
      areas: null,
      source: "invite",
      grantedBy: null,
      grantedAt: NOW - 5,
      expiresAt: NOW + 86400,
    });
    await db.run(s.sql, ...s.params);
    const r = await breakGlass();
    expect(r.res.status).toBe(302);
    const rows = await db.all<{
      account_id: string | null;
      email_norm: string | null;
    }>("SELECT account_id, email_norm FROM console_role_bindings");
    expect(rows).toEqual([{ account_id: null, email_norm: "bg@example.com" }]);
    expect(
      mail.filter((m) => m.subject.startsWith("Console invitation accepted")),
    ).toHaveLength(0);
    expect(await audit("admin.signin")).toHaveLength(0);
    expect(await noAccountRows()).toEqual({
      accounts: 0,
      links: 0,
      sessions: 0,
    });
  });
});

describe("the session", () => {
  it("/me says breakGlass, shows the root grant only, and a normal session says false", async () => {
    // A stored Superadmin binding for the same person's account must not be read.
    await normalRoot(1);
    const acct = await db.first<{ id: string }>("SELECT id FROM accounts");
    const b = stmtInsertBinding({
      id: newBindingId(),
      accountId: acct!.id,
      emailNorm: null,
      role: "superadmin",
      scope: "platform",
      areas: null,
      source: "grant",
      grantedBy: null,
      grantedAt: NOW - 50,
    });
    await db.run(b.sql, ...b.params);
    const r = await breakGlass({
      sub: "idp-root-1",
      email: "root1@example.com",
    });
    const me = await call(r.token!, NOW + 1);
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      breakGlass: boolean;
      sub: string;
      platformAdmin: boolean;
      permissions: { roles: { source: string }[] };
    };
    expect(body.breakGlass).toBe(true);
    expect(body.sub).toBe("idp-root-1");
    expect(body.platformAdmin).toBe(true);
    expect(body.permissions.roles.map((g) => g.source)).toEqual(["root"]);
    expect(await count("account_sessions")).toBe(1); // the normal sign-in's only
  });

  it("expires at exactly 3600 seconds", async () => {
    const r = await breakGlass();
    expect(
      (await call(r.token!, NOW + BREAK_GLASS_TTL_SECONDS - 1)).status,
    ).toBe(200);
    expect((await call(r.token!, NOW + BREAK_GLASS_TTL_SECONDS)).status).toBe(
      401,
    );
  });

  it("the sign-out mark ends it, and a mark from before it was minted does not", async () => {
    const earlier = await breakGlass({}, { now: NOW });
    const out = await call(
      earlier.token!,
      NOW + 10,
      "POST",
      "/api/logout",
      String(earlier.body!.csrf),
    );
    expect(out.status).toBe(200);
    expect((await call(earlier.token!, NOW + 11)).status).toBe(401);
    // A later break-glass sign-in of the same identity is not caught by the older mark.
    const later = await breakGlass({}, { now: NOW + 20 });
    expect((await call(later.token!, NOW + 21)).status).toBe(200);
  });

  it("removing the group from the env makes root false on the next request", async () => {
    const r = await breakGlass();
    expect(
      (
        (await (await call(r.token!, NOW + 1)).json()) as {
          platformAdmin: boolean;
        }
      ).platformAdmin,
    ).toBe(true);
    env.PLATFORM_ADMIN_GROUP = "some-other-group";
    const me = await call(r.token!, NOW + 2);
    expect(
      ((await me.json()) as { platformAdmin: boolean }).platformAdmin,
    ).toBe(false);
    expect((await call(r.token!, NOW + 2, "GET", "/api/products")).status).toBe(
      403,
    );
  });

  it("account routes are refused with reason break_glass_session", async () => {
    const r = await breakGlass();
    const res = await call(
      r.token!,
      NOW + 1,
      "POST",
      "/api/bindings",
      String(r.body!.csrf),
      {
        member: "mbr_AAAAAAAAAAAAAAAAAAAAAA",
        role: "console_access",
        scope: "platform",
        confirm: true,
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; reason?: string };
    };
    expect(JSON.stringify(body)).toContain("break_glass_session");
    expect(await count("console_role_bindings")).toBe(0);
  });
});

describe("realms", () => {
  /** The cookie body of a real break-glass session. */
  async function realBody() {
    const r = await breakGlass();
    return r.body!;
  }
  async function sign(domain: string, body: unknown, secret = SECRET) {
    return signHmacToken(await importHmacKey(secret), domain, body);
  }

  it("a break-glass body signed under another realm's tag is not break-glass", async () => {
    const body = await realBody();
    // v2: no aid or sid. portal: another key and tag.
    for (const [domain, secret] of [
      ["pkey.admin.v2|", SECRET],
      ["pkey.portal.v1|", SECRET],
      ["pkey.portal.v1|", "portal-secret"],
      ["pkey.admin.bg2|", SECRET],
      ["", SECRET],
    ] as const) {
      const token = await sign(domain, body, secret);
      expect((await call(token, NOW + 1)).status).toBe(401);
    }
    // v1: the retired shape is no session at all (ST-30c.8), so `bg` is moot.
    const v1 = await sign("pkey.admin.v1|", body);
    expect((await call(v1, NOW + 1)).status).toBe(401);
  });

  it("v1, v2 and portal tokens with the same body do not verify as break-glass", async () => {
    const identity: SessionIdentity = {
      sub: "idp-x",
      groups: [GROUP],
      authTime: NOW,
    };
    // A v1 body (the IdP sub and groups), signed under the v1 tag.
    const v1 = await sign("pkey.admin.v1|", {
      sub: identity.sub,
      name: identity.sub,
      email: "",
      groups: identity.groups,
      csrf: "c",
      // A v1 cookie lived 8 hours; the break-glass verifier caps its realm at one.
      exp: NOW + 8 * 3600,
      authAt: NOW,
    });
    const v2 = (
      await issueSessionV2(
        env,
        { aid: "a", sid: "s", name: "n", email: "e" },
        NOW,
      )
    ).token;
    // Re-sign each real body under the break-glass tag.
    for (const t of [v1, v2]) {
      const body = JSON.parse(
        Buffer.from(t.split(".")[0]!, "base64url").toString("utf8"),
      );
      const forged = await sign("pkey.admin.bg1|", { ...body, bg: true });
      expect((await call(forged, NOW + 1)).status).toBe(401);
      // and without `bg`
      const bare = await sign("pkey.admin.bg1|", body);
      expect((await call(bare, NOW + 1)).status).toBe(401);
    }
  });

  it("the verifier is strict: an extra, missing or mistyped field fails", async () => {
    const good = await realBody();
    const forge = async (b: Record<string, unknown>) =>
      call(await sign("pkey.admin.bg1|", b), NOW + 1);
    expect((await forge({ ...good })).status).toBe(200);
    expect((await forge({ ...good, aid: "acct" })).status).toBe(401);
    expect((await forge({ ...good, root: true })).status).toBe(401);
    expect((await forge({ ...good, bg: false })).status).toBe(401);
    expect((await forge({ ...good, groups: "x" })).status).toBe(401);
    expect(
      (await forge({ ...good, exp: NOW + BREAK_GLASS_TTL_SECONDS * 8 })).status,
    ).toBe(401);
    const { csrf: _c, ...noCsrf } = good;
    expect((await forge(noCsrf)).status).toBe(401);
    const { sub: _s, ...noSub } = good;
    expect((await forge(noSub)).status).toBe(401);
  });
});

describe("requireAccountSession", () => {
  it("returns the account and session, and refuses break-glass and account-less sessions", async () => {
    expect(requireAccountSession({ aid: "a1", sid: "s1" })).toEqual({
      accountId: "a1",
      sid: "s1",
    });
    const bg = requireAccountSession({ breakGlass: true });
    expect(bg).toBeInstanceOf(Response);
    expect((bg as Response).status).toBe(403);
    expect(JSON.stringify(await (bg as Response).json())).toContain(
      "break_glass_session",
    );
    // A break-glass flag wins even if an account id were somehow present.
    expect(
      requireAccountSession({ aid: "a1", sid: "s1", breakGlass: true }),
    ).toBeInstanceOf(Response);
    const none = requireAccountSession({});
    expect(JSON.stringify(await (none as Response).json())).toContain(
      "account_session_required",
    );
  });
});

describe("the notice", () => {
  it("names who, when and where, and strips a hostile identity", () => {
    const n = breakGlassUsedNotice({
      who: "evil‮@x.example\nBcc: a@b.c",
      at: NOW,
      network: "203.0.113.7",
      origin: "https://key.plrs.im",
    });
    expect(n.subject).toBe("Emergency sign-in used");
    expect(n.text).toContain("203.0.113.7");
    expect(n.subject).not.toMatch(/[\r\n]/);
    expect(n.text).not.toContain("‮");
    expect(n.text).toContain("rotate ADMIN_SESSION_SECRET and check the audit");
  });
});
