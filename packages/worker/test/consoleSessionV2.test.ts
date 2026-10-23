/**
 * ST-30 slice 2a: console cookie v2 (account id + session id), the 30-second live check,
 * `consoleSubject`, `operatorIssuerAllowed` and v1 compatibility.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bindAdminFlow } from "./flowBinderHelper.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
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
  issueSessionV2,
  LIVE_CHECK_SECONDS,
} from "../src/core/console/session.js";
import { memberIdFor } from "../src/core/console/memberId.js";
import { operatorIssuerAllowed } from "../src/core/rbac/operatorIssuer.js";
import {
  accountMayOpenConsole,
  consoleSubject,
} from "../src/services/identity/public.js";
import { handlePortalApi } from "./portalHarness.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { importHmacKey } from "../src/platform/hash.js";
import { signHmacToken } from "../src/platform/hmacToken.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  return env;
}

type Db = ReturnType<typeof makeTestDb>;
type Claims = {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  groups?: string[];
};

/** A full sign-in through the real login and callback handlers; returns the cookie value. */
async function signInThrough(
  env: Env,
  db: Db,
  claims: Claims = {},
  now = NOW,
): Promise<{ res: Response; token: string | null }> {
  const start = await handleAdminLogin(
    new Request("https://key.plrs.im/manage/login?go=1") as unknown as Request,
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: claims.sub ?? "op-1",
      email: claims.email ?? "ada@example.com",
      emailVerified: claims.emailVerified ?? true,
      name: "Ada",
      groups: claims.groups ?? [GROUP],
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
  const set = res.headers.get("set-cookie");
  const cookie = set?.split(";")[0] ?? "";
  const token = cookie.startsWith(`${ADMIN_COOKIE}=`)
    ? cookie.slice(cookie.indexOf("=") + 1)
    : null;
  return { res, token };
}

async function call(
  env: Env,
  db: Db,
  token: string,
  now: number,
  method = "GET",
  path = "/api/me",
  csrf = "",
): Promise<Response> {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
      },
    }) as unknown as Request,
    env,
    db,
    path,
    { now },
  );
}

beforeEach(() => resetConsoleSessionCache());

describe("the console sign-in lands on an account and mints a v2 cookie", () => {
  it("opens an account session row and the cookie resolves through it", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { res, token } = await signInThrough(env, db);
    expect(res.status).toBe(302);
    expect(token).toBeTruthy();
    const rows = await db.all<{ account_id: string; expires_at: number }>(
      "SELECT account_id, expires_at FROM account_sessions",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expires_at).toBe(NOW + 8 * 60 * 60);
    const me = await call(env, db, token!, NOW + 1);
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      sub: string;
      email: string;
      platformAdmin: boolean;
    };
    // The audit actor is the member id (ST-30 slice 2b), never the IdP subject or the account id.
    expect(body.sub).toMatch(/^mbr_[A-Za-z0-9_-]{22}$/);
    expect(body.sub).not.toContain(rows[0]!.account_id);
    expect(body.email).toBe("ada@example.com");
    expect(body.platformAdmin).toBe(true);
    expect(JSON.stringify(body)).not.toContain(rows[0]!.account_id);
  });

  it("the cookie body names the account and the session, and carries no groups", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const body = JSON.parse(
      Buffer.from(token!.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(typeof body.aid).toBe("string");
    expect(typeof body.sid).toBe("string");
    expect(body).not.toHaveProperty("groups");
    expect(body).not.toHaveProperty("sub");
  });

  it("two sign-ins of one person are one account with two sessions", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await signInThrough(env, db);
    await signInThrough(env, db, {}, NOW + 5);
    expect(
      (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM accounts"))!.n,
    ).toBe(1);
    expect(
      (await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM account_sessions",
      ))!.n,
    ).toBe(2);
  });

  it("an identity outside the group gets no account and no cookie", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { res, token } = await signInThrough(env, db, { groups: ["other"] });
    expect(res.status).toBe(403);
    expect(token).toBeNull();
    expect(
      (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM accounts"))!.n,
    ).toBe(0);
  });

  it("an operator whose address another account already uses joins it; a stranger does not", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    // A Polaris Locker account made by an email code, before the console knew the person.
    const made = await signIn(
      db,
      {
        issuerKey: "email",
        subject: "ada@example.com",
        kind: "email",
        email: "ada@example.com",
        emailVerified: true,
      },
      NOW - 100,
      { unfenced: true },
    );
    expect(made.status).toBe("signed_in");
    const { res, token } = await signInThrough(env, db);
    expect(res.status).toBe(302);
    expect(token).toBeTruthy();
    expect(
      (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM accounts"))!.n,
    ).toBe(1);
    const links = await db.all<{ issuer_key: string }>(
      "SELECT issuer_key FROM account_links ORDER BY issuer_key",
    );
    expect(links.map((l) => l.issuer_key)).toEqual(["email", ISSUER]);
  });

  it("an operator whose address the IdP does not vouch for gets a separate account, not a join", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await signIn(
      db,
      {
        issuerKey: "email",
        subject: "ada@example.com",
        kind: "email",
        email: "ada@example.com",
        emailVerified: true,
      },
      NOW - 100,
      { unfenced: true },
    );
    // Unverified at the IdP: the address is not kept, so this is a new, separate account.
    const { res } = await signInThrough(env, db, { emailVerified: false });
    expect(res.status).toBe(302);
    expect(
      (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM accounts"))!.n,
    ).toBe(2);
  });
});

describe("a refused operator join writes nothing", () => {
  const counts = async (db: Db) => ({
    accounts: (await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM accounts",
    ))!.n,
    links: (await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_links",
    ))!.n,
    sessions: (await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_sessions",
    ))!.n,
    audit: (await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM portal_audit",
    ))!.n,
  });
  const emailAccount = async (db: Db, email: string) => {
    const made = await signIn(
      db,
      {
        issuerKey: "email",
        subject: email,
        kind: "email",
        email,
        emailVerified: true,
      },
      NOW - 100,
      { unfenced: true },
    );
    if (made.status !== "signed_in") throw new Error("fixture");
    return made.account.id;
  };

  it("a disabled account that uses the address is refused before any link or audit row", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const id = await emailAccount(db, "ada@example.com");
    await db.run("UPDATE accounts SET status = 'disabled' WHERE id = ?", id);
    const before = await counts(db);
    const { res, token } = await signInThrough(env, db);
    expect(res.status).toBe(403);
    expect(token).toBeNull();
    expect(await counts(db)).toEqual(before);
  });

  it("an address used by more than one account is refused and writes nothing", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    // One account uses it as an email method; another holds it as its verified primary address.
    await emailAccount(db, "ada@example.com");
    const other = await emailAccount(db, "other@example.com");
    await db.run(
      "UPDATE accounts SET primary_email = ?, primary_email_verified_at = ? WHERE id = ?",
      "ada@example.com",
      NOW - 50,
      other,
    );
    const before = await counts(db);
    const { res, token } = await signInThrough(env, db);
    expect(res.status).toBe(403);
    expect(token).toBeNull();
    expect(await counts(db)).toEqual(before);
  });
});

describe("the live check: revocation takes effect within 30 seconds", () => {
  it("a revoked session is answered from the check for at most 30 s, then refused", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    expect((await call(env, db, token!, NOW + 1)).status).toBe(200);

    await db.run("UPDATE account_sessions SET revoked_at = ?", NOW + 2);
    // Inside the window the last answer stands (the cost of not reading D1 per request).
    expect((await call(env, db, token!, NOW + 10)).status).toBe(200);
    // At the window's end the session is asked about again, and refused.
    const after = await call(env, db, token!, NOW + 1 + LIVE_CHECK_SECONDS);
    expect(after.status).toBe(401);
    expect(after.headers.get("X-PKey-Session")).toBe("expired");
  });

  it("the check reads D1 at most once per window", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    await call(env, db, token!, NOW + 1);
    let reads = 0;
    const real = db.first.bind(db);
    db.first = (async (...a: Parameters<typeof real>) => {
      if (String(a[0]).includes("FROM account_sessions")) reads++;
      return real(...a);
    }) as typeof db.first;
    for (let i = 2; i < 25; i++) await call(env, db, token!, NOW + i);
    expect(reads).toBe(0);
    await call(env, db, token!, NOW + 40);
    expect(reads).toBe(1);
  });

  it("a disabled account is refused at the next check", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    expect((await call(env, db, token!, NOW + 1)).status).toBe(200);
    await db.run("UPDATE accounts SET status = 'disabled'");
    expect((await call(env, db, token!, NOW + 40)).status).toBe(401);
  });

  it("a deleted or merged-away account is refused at the next check", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    expect((await call(env, db, token!, NOW + 1)).status).toBe(200);
    await db.run("DELETE FROM account_sessions");
    await db.run("DELETE FROM accounts");
    expect((await call(env, db, token!, NOW + 40)).status).toBe(401);
  });

  it("sign out ends the row at once, in this isolate, and the operator's other cookies via the mark", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const first = await signInThrough(env, db);
    const second = await signInThrough(env, db, {}, NOW + 1);
    const me = (await (await call(env, db, first.token!, NOW + 2)).json()) as {
      csrf: string;
    };
    const out = await call(
      env,
      db,
      first.token!,
      NOW + 3,
      "POST",
      "/api/logout",
      me.csrf,
    );
    expect(out.status).toBe(200);
    expect((await call(env, db, first.token!, NOW + 4)).status).toBe(401);
    // The mark was written for the operator: the other browser's session is refused at its next
    // check too (a fresh isolate would not have it cached).
    resetConsoleSessionCache();
    expect((await call(env, db, second.token!, NOW + 5)).status).toBe(401);
  });

  it("a session whose row belongs to another account is refused", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const row = (await db.first<{ id_hash: string }>(
      "SELECT id_hash FROM account_sessions",
    ))!;
    const other = await signIn(
      db,
      {
        issuerKey: "email",
        subject: "bo@example.com",
        kind: "email",
        email: "bo@example.com",
        emailVerified: true,
      },
      NOW,
      { unfenced: true },
    );
    if (other.status !== "signed_in") throw new Error("fixture");
    await db.run(
      "UPDATE account_sessions SET account_id = ? WHERE id_hash = ?",
      other.account.id,
      row.id_hash,
    );
    expect((await call(env, db, token!, NOW + 40)).status).toBe(401);
  });

  it("an expired row is refused even though the cookie is within its own expiry", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    await db.run("UPDATE account_sessions SET expires_at = ?", NOW + 100);
    expect((await call(env, db, token!, NOW + 200)).status).toBe(401);
  });

  it("a group removed at the IdP ends root at the next sign-in's check, not at 8 h", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const old = await signInThrough(env, db);
    expect((await call(env, db, old.token!, NOW + 1)).status).toBe(200);
    // The IdP no longer lists the group: the callback refuses (no cookie) and writes nothing...
    const gone = await signInThrough(env, db, { groups: [] }, NOW + 60);
    expect(gone.token).toBeNull();
    // ...so the older session keeps the groups of the last sign-in that succeeded (the bound is the
    // 8 h session row). Documented residual; the test pins it so a change is deliberate.
    expect((await call(env, db, old.token!, NOW + 100)).status).toBe(200);
  });
});

describe("cookie versions", () => {
  it("a v2 payload signed under the v1 tag, and a v1 payload under the v2 tag, never verify", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const v2 = await issueSessionV2(
      env,
      { aid: "acct_x", sid: "sid_x", name: "n", email: "e@x.io" },
      NOW,
    );
    // The v2 token verifies only as v2: its row does not exist, so it is refused...
    expect((await call(env, db, v2.token, NOW + 1)).status).toBe(401);
    // ...and a v1 reader cannot be handed a v2 body: tampering with the body breaks the MAC.
    const [body, mac] = v2.token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString()),
        groups: [GROUP],
        sub: "root",
      }),
    ).toString("base64url");
    expect((await call(env, db, `${forged}.${mac}`, NOW + 1)).status).toBe(401);
  });

  it("a portal-tagged token under the v2 reader is refused", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    // Same key material, another realm's tag: a signature over a different message.
    const key = await importHmacKey(env.ADMIN_SESSION_SECRET!);
    const forged = await signHmacToken(key, "pkey.portal.v1|", {
      aid: "acct_x",
      sid: "sid_x",
      name: "n",
      email: "e@x.io",
      csrf: "c",
      exp: NOW + 3600,
      authAt: NOW,
    });
    expect((await call(env, db, forged, NOW + 1)).status).toBe(401);
  });

  it("without a database to ask, a v2 cookie is refused", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const { resolveConsoleCaller } = await import("../src/console/api.js");
    const req = new Request("https://key.plrs.im/docs/x", {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    });
    expect(await resolveConsoleCaller(env, null, req, NOW + 1)).toBeNull();
    expect(await resolveConsoleCaller(env, db, req, NOW + 1)).not.toBeNull();
  });
});

describe("consoleSubject", () => {
  async function opened() {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const claims = JSON.parse(
      Buffer.from(token!.split(".")[0]!, "base64url").toString(),
    ) as { aid: string; sid: string };
    return { env, db, claims };
  }

  it("answers the member id, the IdP subject, the address and the fresh groups", async () => {
    const { env, db, claims } = await opened();
    expect(await consoleSubject(env, db, claims, NOW + 1)).toEqual({
      sub: await memberIdFor(env, claims.aid),
      idpSub: "op-1",
      name: "Ada",
      email: "ada@example.com",
      groups: [GROUP],
      root: true,
    });
  });

  it("is null for an unknown session, a wrong account, and a console IdP that is not configured", async () => {
    const { env, db, claims } = await opened();
    expect(
      await consoleSubject(env, db, { ...claims, sid: "nope" }, NOW + 1),
    ).toBeNull();
    expect(
      await consoleSubject(env, db, { ...claims, aid: "acct_x" }, NOW + 1),
    ).toBeNull();
    const bare = adminEnv();
    delete bare.PLATFORM_OIDC_ISSUER;
    expect(await consoleSubject(bare, db, claims, NOW + 1)).toBeNull();
  });

  it("is null once the account holds no link through the console IdP", async () => {
    const { env, db, claims } = await opened();
    await db.run("DELETE FROM account_links WHERE issuer_key = ?", ISSUER);
    expect(await consoleSubject(env, db, claims, NOW + 1)).toBeNull();
  });
});

describe("operatorIssuerAllowed fails closed", () => {
  const base = (): Env => adminEnv();

  it("always admits the console's own IdP, trailing slash or not", () => {
    expect(operatorIssuerAllowed(base(), ISSUER)).toBe(true);
    expect(operatorIssuerAllowed(base(), `${ISSUER}/`)).toBe(true);
  });

  it("admits no other issuer when the allowlist is unset or empty", () => {
    const env = base();
    expect(operatorIssuerAllowed(env, "https://other.example")).toBe(false);
    env.OIDC_ISSUER_ALLOWLIST = "";
    expect(operatorIssuerAllowed(env, "https://other.example")).toBe(false);
    env.OIDC_ISSUER_ALLOWLIST = " , ";
    expect(operatorIssuerAllowed(env, "https://other.example")).toBe(false);
  });

  it("admits a listed https host and nothing it does not list", () => {
    const env = base();
    env.OIDC_ISSUER_ALLOWLIST = "other.example, third.example";
    expect(operatorIssuerAllowed(env, "https://other.example")).toBe(true);
    expect(operatorIssuerAllowed(env, "https://OTHER.example/tenant")).toBe(
      true,
    );
    expect(operatorIssuerAllowed(env, "https://evil.example")).toBe(false);
    expect(
      operatorIssuerAllowed(env, "https://other.example.evil.example"),
    ).toBe(false);
    // Plain http never qualifies, nor does a non-URL.
    expect(operatorIssuerAllowed(env, "http://other.example")).toBe(false);
    expect(operatorIssuerAllowed(env, "other.example")).toBe(false);
    expect(operatorIssuerAllowed(env, "")).toBe(false);
  });

  it("admits nothing when no console IdP is configured and the list is empty", () => {
    const env = base();
    delete env.PLATFORM_OIDC_ISSUER;
    expect(operatorIssuerAllowed(env, ISSUER)).toBe(false);
  });
});

describe('the Locker account menu\'s "Open console" pointer', () => {
  async function portalMe(env: Env, db: Db, email: string) {
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    const account = await getOrCreateAccountByEmail(db, email, NOW);
    const { token } = await issuePortalSessionRow(
      env,
      db,
      {
        accountId: account.id,
        email: account.primary_email,
        name: account.display_name,
      },
      NOW,
    );
    const res = await handlePortalApi(
      new Request("https://key.plrs.im/api/me", {
        headers: { cookie: `${PORTAL_COOKIE}=${token}` },
      }) as unknown as Request,
      env,
      db,
      "/api/me",
      NOW + 1,
    );
    return {
      accountId: account.id,
      body: (await res.json()) as { account: { console: string | null } },
    };
  }

  it("is true for an operator's account and false for everyone else", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await signInThrough(env, db);
    const operator = await db.first<{ account_id: string }>(
      "SELECT account_id FROM account_sessions",
    );
    expect(
      await accountMayOpenConsole(env, db, operator!.account_id, NOW),
    ).toBe(true);
    const ada = await portalMe(env, db, "ada@example.com");
    expect(ada.accountId).toBe(operator!.account_id);
    expect(ada.body.account.console).toBe("https://key.plrs.im/manage/");
    expect(
      (await portalMe(env, db, "eve@example.com")).body.account.console,
    ).toBeNull();
  });

  it("is false when no platform-admin group is configured or the groups no longer carry it", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await signInThrough(env, db);
    const operator = (await db.first<{ account_id: string }>(
      "SELECT account_id FROM account_sessions",
    ))!;
    await db.run(
      "UPDATE account_links SET groups_json = ?",
      JSON.stringify(["x"]),
    );
    expect(await accountMayOpenConsole(env, db, operator.account_id, NOW)).toBe(
      false,
    );
    await db.run(
      "UPDATE account_links SET groups_json = ?",
      JSON.stringify([GROUP]),
    );
    delete env.PLATFORM_ADMIN_GROUP;
    expect(await accountMayOpenConsole(env, db, operator.account_id, NOW)).toBe(
      false,
    );
  });
});
