/**
 * ST-30c.5: console passkey sign-in and passkey step-up (ST-28 SM-1, SM-5; checklist item 14).
 *
 * The routes are `POST /manage/login/passkey/{options,verify}`; every case here drives the real
 * handler with a software authenticator. A strong passkey (SM-3(a)/(d)) opens a v2 session; a
 * passkey nobody marked strong opens nothing and writes nothing; the challenge is single-use and
 * bound to the browser that asked; a step-up is answered by the same account only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { SoftAuthenticator } from "./softAuthenticator.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import { resetConsoleSessionCache } from "../src/console/consoleSession.js";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  CSRF_HEADER,
  LIVE_CHECK_SECONDS,
  issueSessionV2,
} from "../src/core/console/session.js";
import {
  consoleSignIn,
  consoleTokenSubject,
} from "../src/services/identity/public.js";
import { handleAccountPasskeys } from "../src/services/identity/passkeys/routes.js";
import { sessionIdHash } from "../src/services/identity/portal/accountSessions.js";
import { newBindingId, stmtInsertBinding } from "../src/core/rbac/bindings.js";
import {
  CONSOLE_PASSKEY_COOKIE,
  CONSOLE_PASSKEY_PER_NETWORK_MINUTE,
} from "../src/console/passkeySignin.js";
import { CONSOLE_HINT_COOKIE } from "../src/console/auth.js";
import { matchRoute } from "../src/router.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const ORIGIN = "https://key.plrs.im";
const OPTIONS = "/login/passkey/options";
const VERIFY = "/login/passkey/verify";

type Db = ReturnType<typeof makeTestDb>;

let env: Env;
let db: Db;

beforeEach(() => {
  resetConsoleSessionCache();
  env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.KEY_HASH_PEPPER = "test-pepper";
  env.CONSOLE_ORIGIN = ORIGIN;
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  env.EMAIL = {
    send: async () => undefined,
  } as unknown as Env["EMAIL"];
  db = makeTestDb();
});

interface Member {
  accountId: string;
  auth: SoftAuthenticator;
  linkId: string;
  /** An IdP-backed session cookie of the member, to enrol and step up with. */
  token: string;
  csrf: string;
}

/** A request to `/manage<path>` shaped as a browser's same-origin fetch, unless overridden. */
function req(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  return new Request(`${ORIGIN}/manage${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as Request;
}

const run = (r: Request, path: string, now = NOW + 1) =>
  handleAdmin(r, env, db, path, { now });

const setCookies = (res: Response): string[] =>
  (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();

function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of setCookies(res)) {
    const [pair] = c.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

/** An operator signed in through the console IdP, with a passkey enrolled (strong at once). */
async function member(
  n: number,
  opts: { groups?: string[]; binding?: boolean; synced?: boolean } = {},
): Promise<Member> {
  const r = await consoleSignIn(
    env,
    db,
    {
      sub: `op-${n}`,
      email: `op${n}@example.com`,
      emailVerified: true,
      displayName: `Op ${n}`,
      groups: opts.groups ?? [GROUP],
    },
    { operator: true },
    NOW,
  );
  if (r.status !== "ok") throw new Error("fixture");
  const { token, claims } = await issueSessionV2(
    env,
    {
      aid: r.accountId,
      sid: r.sid,
      name: r.name,
      email: r.email,
      authTime: NOW,
      stepUp: true,
    },
    NOW,
  );
  const auth = await SoftAuthenticator.create({ synced: opts.synced ?? true });
  const start = await run(
    req(
      "/api/me/passkeys/options",
      {},
      { cookie: `${ADMIN_COOKIE}=${token}`, [CSRF_HEADER]: claims.csrf },
    ),
    "/api/me/passkeys/options",
  );
  const { options } = (await start.json()) as {
    options: Parameters<SoftAuthenticator["register"]>[0];
  };
  const added = await run(
    req(
      "/api/me/passkeys",
      { response: await auth.register(options) },
      { cookie: `${ADMIN_COOKIE}=${token}`, [CSRF_HEADER]: claims.csrf },
    ),
    "/api/me/passkeys",
  );
  expect(added.status).toBe(201);
  const { passkey } = (await added.json()) as { passkey: { methodId: string } };
  if (opts.binding) await bind(r.accountId);
  return {
    accountId: r.accountId,
    auth,
    linkId: passkey.methodId,
    token,
    csrf: claims.csrf,
  };
}

async function bind(accountId: string): Promise<void> {
  const s = stmtInsertBinding({
    id: newBindingId(),
    accountId,
    emailNorm: null,
    role: "console_access",
    scope: "platform",
    areas: null,
    source: "grant",
    grantedBy: null,
    grantedAt: NOW - 10,
  });
  await db.run(s.sql, ...s.params);
}

/** Make the member passkey-only: the console-IdP link is gone, the passkey stays. */
const dropIdp = (m: Member) =>
  db.run(
    "DELETE FROM account_links WHERE account_id = ? AND kind = 'oidc'",
    m.accountId,
  );

interface Ceremony {
  res: Response;
  cookie: string;
  options: Parameters<SoftAuthenticator["assert"]>[0];
}

async function begin(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  now = NOW + 1,
): Promise<Ceremony> {
  const res = await run(req(OPTIONS, body, headers), OPTIONS, now);
  const set = cookiesOf(res)[CONSOLE_PASSKEY_COOKIE];
  const json = res.status === 200 ? await res.clone().json() : {};
  return {
    res,
    cookie: set ? `${CONSOLE_PASSKEY_COOKIE}=${set}` : "",
    options: (json as { options: Ceremony["options"] }).options,
  };
}

async function finish(
  c: { cookie: string },
  response: unknown,
  headers: Record<string, string> = {},
  now = NOW + 1,
): Promise<Response> {
  return run(
    req(VERIFY, { response }, { cookie: c.cookie, ...headers }),
    VERIFY,
    now,
  );
}

/** The full passkey sign-in as a browser would: options, assert, verify. */
async function signInWith(
  m: Member,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  now = NOW + 1,
) {
  const c = await begin(body, headers, now);
  expect(c.res.status).toBe(200);
  const res = await finish(c, await m.auth.assert(c.options), headers, now);
  return { res, ceremony: c };
}

const sessionRows = (accountId: string) =>
  db.all<{ id_hash: string; amr_json: string; revoked_at: number | null }>(
    "SELECT id_hash, amr_json, revoked_at FROM account_sessions WHERE account_id = ?",
    accountId,
  );
const audits = (action: string) =>
  db.all<{ actor_sub: string; summary: string }>(
    "SELECT actor_sub, summary FROM platform_audit WHERE action = ?",
    action,
  );

function claimsOf(res: Response): {
  aid: string;
  sid: string;
  authAt: number;
  stepUpAt?: number;
} {
  const token = cookiesOf(res)[ADMIN_COOKIE]!;
  return JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
  );
}

/** Everything a request to `/api/me` needs, from a verify response. */
async function me(res: Response, now: number): Promise<Response> {
  const token = cookiesOf(res)[ADMIN_COOKIE]!;
  return run(
    req("/api/me", undefined, { cookie: `${ADMIN_COOKIE}=${token}` }, "GET"),
    "/api/me",
    now,
  );
}

describe("routes", () => {
  it("the router names both paths adminPasskey and nothing else", () => {
    expect(matchRoute("/manage/login/passkey/options").kind).toBe(
      "adminPasskey",
    );
    expect(matchRoute("/manage/login/passkey/verify").kind).toBe(
      "adminPasskey",
    );
    expect(matchRoute("/manage/login/passkey/other").kind).not.toBe(
      "adminPasskey",
    );
  });

  it("answers only POST", async () => {
    const res = await run(req(OPTIONS, undefined, {}, "GET"), OPTIONS);
    expect(res.status).toBe(405);
  });
});

describe("SM-1: a passkey nobody marked strong opens nothing", () => {
  it("is refused with `method` and nothing is written", async () => {
    const m = await member(1, { binding: true });
    // A passkey added in the Locker account is never strong (SM-4).
    const other = await SoftAuthenticator.create();
    const caller = {
      accountId: m.accountId,
      authenticatedAt: NOW,
      sessionIdHash: await sessionIdHash(env, "portal-session"),
    };
    const portalReq = (path: string, body: unknown) =>
      new Request(`${ORIGIN}/api/me/passkeys${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const start = await handleAccountPasskeys(
      portalReq("/options", {}),
      env,
      db,
      caller,
      ["options"],
      NOW,
    );
    const { options } = (await start.json()) as {
      options: Parameters<SoftAuthenticator["register"]>[0];
    };
    expect(
      (
        await handleAccountPasskeys(
          portalReq("", { response: await other.register(options) }),
          env,
          db,
          caller,
          [],
          NOW,
        )
      ).status,
    ).toBe(201);
    const rowBefore = await db.first<{ sign_count: number }>(
      "SELECT sign_count FROM account_passkeys WHERE credential_id = ?",
      other.id,
    );
    const sessionsBefore = (await sessionRows(m.accountId)).length;

    const c = await begin();
    const res = await finish(c, await other.assert(c.options));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("method");
    expect(cookiesOf(res)[ADMIN_COOKIE]).toBeUndefined();
    expect((await sessionRows(m.accountId)).length).toBe(sessionsBefore);
    expect(
      await db.first<{ sign_count: number }>(
        "SELECT sign_count FROM account_passkeys WHERE credential_id = ?",
        other.id,
      ),
    ).toEqual(rowBefore);
    expect(await audits("admin.signin")).toHaveLength(0);
  });
});

describe("a strong passkey signs in", () => {
  it("opens a v2 session (amr passkey, console TTL), audits it and sets the hint", async () => {
    const m = await member(1, { binding: true });
    await dropIdp(m);
    const { res } = await signInWith(m, { returnTo: "/manage/" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "signed_in",
      next: "/manage/",
    });
    const claims = claimsOf(res);
    expect(claims.aid).toBe(m.accountId);
    expect(claims.authAt).toBe(NOW + 1);
    expect(claims.stepUpAt).toBeUndefined();
    const jar = cookiesOf(res);
    expect(jar[CONSOLE_HINT_COOKIE]).toBe(
      encodeURIComponent("op1@example.com"),
    );
    // The ceremony cookie is spent.
    expect(setCookies(res).join("\n")).toMatch(
      new RegExp(`${CONSOLE_PASSKEY_COOKIE}=;.*Max-Age=0`),
    );
    const rows = (await sessionRows(m.accountId)).filter((r) =>
      r.amr_json.includes("passkey"),
    );
    expect(rows).toHaveLength(1);
    const ttl = await db.first<{ created_at: number; expires_at: number }>(
      "SELECT created_at, expires_at FROM account_sessions WHERE amr_json = ?",
      JSON.stringify(["passkey"]),
    );
    expect(ttl!.expires_at - ttl!.created_at).toBe(ADMIN_SESSION_TTL_SECONDS);
    const signin = await audits("admin.signin");
    expect(signin).toHaveLength(1);
    expect(signin[0]).toMatchObject({ summary: "passkey" });
    expect(signin[0]!.actor_sub).toMatch(/^mbr_/);
    // The member-id mark is on the passkey link.
    const mark = await db.first<{ member_id: string | null }>(
      "SELECT member_id FROM account_links WHERE id = ?",
      m.linkId,
    );
    expect(mark!.member_id).toMatch(/^mbr_/);
    // The cookie works as the console's own, and the body never carries the account id.
    const who = await me(res, NOW + 2);
    expect(who.status).toBe(200);
    expect(await who.text()).not.toContain(m.accountId);
  });

  it("a member with no grant is refused and the row it opened is ended", async () => {
    const m = await member(1);
    await dropIdp(m);
    const { res } = await signInWith(m);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe("no_grant");
    expect(cookiesOf(res)[ADMIN_COOKIE]).toBeUndefined();
    const rows = (await sessionRows(m.accountId)).filter((r) =>
      r.amr_json.includes("passkey"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(await audits("admin.signin")).toHaveLength(0);
  });

  it("a root-only operator whose IdP assertion is stale is told to sign in with Pocket ID first", async () => {
    const m = await member(1, { groups: [GROUP] });
    const later = NOW + ADMIN_SESSION_TTL_SECONDS + 100;
    const { res } = await signInWith(m, {}, {}, later);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string; message: string };
    expect(body.reason).toBe("idp_first");
    expect(body.message).toContain("Sign in with Pocket ID first");
    expect(cookiesOf(res)[ADMIN_COOKIE]).toBeUndefined();
    // Within the window the same operator signs in: root is still computed from the IdP link.
    const fresh = await signInWith(m, {}, {}, NOW + 60);
    expect(fresh.res.status).toBe(200);
  });
});

describe("the ceremony", () => {
  it("is single-use: a second verify of the same challenge is spent", async () => {
    const m = await member(1, { binding: true });
    const c = await begin();
    const response = await m.auth.assert(c.options);
    expect((await finish(c, response)).status).toBe(200);
    const again = await finish(c, response);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe(
      "signin_expired",
    );
  });

  it("is spent by a failed try, whatever failed", async () => {
    const m = await member(1, { binding: true });
    const c = await begin();
    const bad = await finish(c, { id: "nope" });
    expect(bad.status).toBe(401);
    const good = await finish(c, await m.auth.assert(c.options));
    expect(good.status).toBe(400);
  });

  it("is bound to the browser: no cookie, or another browser's cookie, finishes nothing", async () => {
    const m = await member(1, { binding: true });
    const mine = await begin();
    const theirs = await begin();
    const response = await m.auth.assert(mine.options);
    // No cookie at all.
    expect((await finish({ cookie: "" }, response)).status).toBe(400);
    // Another browser's ceremony: its challenge is not the one the assertion signed.
    expect((await finish(theirs, response)).status).toBe(401);
    // The ceremony cookie of the portal's own passkey flow is not this one.
    expect(
      (
        await finish(
          { cookie: `__Host-pkey_passkey=${mine.cookie.split("=")[1]}` },
          response,
        )
      ).status,
    ).toBe(400);
    expect(await audits("admin.signin")).toHaveLength(0);
    // Nothing above spent the ceremony that was never presented: `mine` still works.
    expect((await finish(mine, await m.auth.assert(mine.options))).status).toBe(
      200,
    );
  });

  it("a counter regression is refused and audited", async () => {
    const m = await member(1, { binding: true, synced: false });
    const first = await signInWith(m);
    expect(first.res.status).toBe(200);
    const c = await begin();
    const res = await finish(c, await m.auth.assert(c.options, { counter: 0 }));
    expect(res.status).toBe(401);
    expect(cookiesOf(res)[ADMIN_COOKIE]).toBeUndefined();
    const rows = await db.all(
      "SELECT 1 FROM portal_audit WHERE action = 'account.passkey.counter_regressed'",
    );
    expect(rows).toHaveLength(1);
  });

  it("a passkey enrolled under another RP id is refused", async () => {
    const m = await member(1, { binding: true });
    await db.run(
      "UPDATE account_passkeys SET rp_id = 'evil.example' WHERE credential_id = ?",
      m.auth.id,
    );
    const { res } = await signInWith(m);
    expect(res.status).toBe(401);
    expect(cookiesOf(res)[ADMIN_COOKIE]).toBeUndefined();
    // An authenticator hashing another RP id fails the same way.
    const m2 = await member(2, { binding: true });
    const c = await begin();
    const forged = await finish(
      c,
      await m2.auth.assert(c.options, { rpId: "evil.example" }),
    );
    expect(forged.status).toBe(401);
  });

  it("a ceremony on a customer origin never starts one", async () => {
    const res = await run(
      new Request(`https://elsewhere.example/manage${OPTIONS}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      }) as unknown as Request,
      OPTIONS,
    );
    expect(res.status).toBe(404);
    expect(cookiesOf(res)[CONSOLE_PASSKEY_COOKIE]).toBeUndefined();
  });
});

describe("login CSRF (checklist item 14)", () => {
  it("a cross-site verify is refused before the challenge is spent", async () => {
    const m = await member(1, { binding: true });
    const c = await begin();
    const response = await m.auth.assert(c.options);
    const attempts: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example" },
    ];
    for (const extra of attempts) {
      const res = await run(
        new Request(`${ORIGIN}/manage${VERIFY}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: c.cookie,
            ...extra,
          },
          body: JSON.stringify({ response }),
        }) as unknown as Request,
        VERIFY,
      );
      expect(res.status).toBe(400);
      expect(cookiesOf(res)[ADMIN_COOKIE]).toBeUndefined();
    }
    expect(await audits("admin.signin")).toHaveLength(0);
    // The cross-site tries did not spend the challenge the browser holds.
    expect((await finish(c, response)).status).toBe(200);
  });

  it("a cross-site or non-JSON options request mints no challenge and sets no cookie", async () => {
    const cross = await begin({}, { "sec-fetch-site": "cross-site" });
    expect(cross.res.status).toBe(400);
    expect(cross.cookie).toBe("");
    const form = await run(
      new Request(`${ORIGIN}/manage${OPTIONS}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
        },
        body: "stepUp=1",
      }) as unknown as Request,
      OPTIONS,
    );
    expect(form.status).toBe(400);
    expect(cookiesOf(form)[CONSOLE_PASSKEY_COOKIE]).toBeUndefined();
  });

  it("an attacker's own assertion presented in the victim's browser signs nobody in", async () => {
    const attacker = await member(1, { binding: true });
    const victimBrowser = await begin();
    const attackerBrowser = await begin();
    // The attacker signs THEIR challenge and replays it where the victim's cookie is.
    const forged = await attacker.auth.assert(attackerBrowser.options);
    const res = await finish(victimBrowser, forged);
    expect(res.status).toBe(401);
    expect(cookiesOf(res)[ADMIN_COOKIE]).toBeUndefined();
    // And with no cookie from the victim's browser at all, nothing is finished.
    expect((await finish({ cookie: "" }, forged)).status).toBe(400);
  });
});

describe("step-up (same account only)", () => {
  it("sets stepUpAt for the account that is signed in, and only then", async () => {
    const a = await member(1, { binding: true });
    const first = await signInWith(a);
    const aCookie = `${ADMIN_COOKIE}=${cookiesOf(first.res)[ADMIN_COOKIE]}`;

    const c = await begin({ stepUp: true }, { cookie: aCookie }, NOW + 100);
    expect(c.res.status).toBe(200);
    const res = await finish(
      c,
      await a.auth.assert(c.options),
      { cookie: `${aCookie}; ${c.cookie}` },
      NOW + 101,
    );
    expect(res.status).toBe(200);
    const claims = claimsOf(res);
    expect(claims.aid).toBe(a.accountId);
    expect(claims.authAt).toBe(NOW + 101);
    expect(claims.stepUpAt).toBe(NOW + 101);

    // A plain sign-in never sets it, even with a session in the browser.
    const plain = await begin({}, { cookie: aCookie }, NOW + 200);
    const res2 = await finish(
      plain,
      await a.auth.assert(plain.options),
      { cookie: `${aCookie}; ${plain.cookie}` },
      NOW + 201,
    );
    expect(claimsOf(res2).stepUpAt).toBeUndefined();
  });

  it("refuses a step-up without a session", async () => {
    const res = await run(req(OPTIONS, { stepUp: true }), OPTIONS);
    expect(res.status).toBe(401);
    expect(cookiesOf(res)[CONSOLE_PASSKEY_COOKIE]).toBeUndefined();
  });

  it("a step-up for account A can never mint a session for account B", async () => {
    const a = await member(1, { binding: true });
    const b = await member(2, { binding: true });
    const aSession = await signInWith(a);
    const aCookie = `${ADMIN_COOKIE}=${cookiesOf(aSession.res)[ADMIN_COOKIE]}`;
    const bBefore = (await sessionRows(b.accountId)).length;

    const c = await begin({ stepUp: true }, { cookie: aCookie }, NOW + 100);
    expect(c.res.status).toBe(200);
    // B's own valid, strong passkey answers A's step-up.
    const res = await finish(
      c,
      await b.auth.assert(c.options),
      { cookie: `${aCookie}; ${c.cookie}` },
      NOW + 101,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "step_up_account",
    );
    expect(cookiesOf(res)[ADMIN_COOKIE]).toBeUndefined();
    expect((await sessionRows(b.accountId)).length).toBe(bBefore);
    // The refusal wrote no counter either: B's passkey is untouched.
    const row = await db.first<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM account_passkeys WHERE credential_id = ?",
      b.auth.id,
    );
    expect(row!.last_used_at).toBeNull();

    // A step-up ceremony finished from a browser that holds a different session is refused too.
    const bSession = await signInWith(b, {}, {}, NOW + 150);
    const bCookie = `${ADMIN_COOKIE}=${cookiesOf(bSession.res)[ADMIN_COOKIE]}`;
    const c2 = await begin({ stepUp: true }, { cookie: aCookie }, NOW + 160);
    const swapped = await finish(
      c2,
      await a.auth.assert(c2.options),
      { cookie: `${bCookie}; ${c2.cookie}` },
      NOW + 161,
    );
    expect(swapped.status).toBe(403);
    expect(cookiesOf(swapped)[ADMIN_COOKIE]).toBeUndefined();
  });
});

describe("SM-5: a passkey-only member keeps access, per request", () => {
  it("is admitted without any console-IdP link, and loses entry within 30 s of removing the passkey", async () => {
    const m = await member(1, { binding: true });
    await dropIdp(m);
    const { res } = await signInWith(m, {}, {}, NOW + 1);
    expect(res.status).toBe(200);
    expect((await me(res, NOW + 2)).status).toBe(200);

    // The token subject follows the same rule.
    const sub = await consoleTokenSubject(env, db, m.accountId, NOW + 2);
    expect(sub).toMatchObject({ root: false, groups: [], idpSub: "" });
    expect(sub!.sub).toMatch(/^mbr_/);

    // The holder removes the passkey: the link goes with it.
    await db.run("DELETE FROM account_links WHERE id = ?", m.linkId);
    await db.run(
      "DELETE FROM account_passkeys WHERE credential_id = ?",
      m.auth.id,
    );
    expect(await consoleTokenSubject(env, db, m.accountId, NOW + 3)).toBeNull();
    // The 30 s cache may still answer for its window; past it entry has ended.
    expect((await me(res, NOW + 2 + LIVE_CHECK_SECONDS + 1)).status).toBe(401);
  });

  it("a passkey enrolled under another RP id, or never marked strong, admits nobody", async () => {
    const m = await member(1, { binding: true });
    await dropIdp(m);
    expect(
      await consoleTokenSubject(env, db, m.accountId, NOW + 5),
    ).not.toBeNull();
    await db.run(
      "UPDATE account_passkeys SET rp_id = 'evil.example' WHERE credential_id = ?",
      m.auth.id,
    );
    expect(await consoleTokenSubject(env, db, m.accountId, NOW + 5)).toBeNull();
    await db.run(
      "UPDATE account_passkeys SET rp_id = 'key.plrs.im' WHERE credential_id = ?",
      m.auth.id,
    );
    await db.run(
      "UPDATE account_links SET strong_at = NULL WHERE id = ?",
      m.linkId,
    );
    expect(await consoleTokenSubject(env, db, m.accountId, NOW + 5)).toBeNull();
  });

  it("root is still computed only from the console-IdP link", async () => {
    const m = await member(1, { groups: [GROUP] });
    const withIdp = await consoleTokenSubject(env, db, m.accountId, NOW + 5);
    expect(withIdp!.root).toBe(true);
    await dropIdp(m);
    const passkeyOnly = await consoleTokenSubject(
      env,
      db,
      m.accountId,
      NOW + 5,
    );
    expect(passkeyOnly).toMatchObject({ root: false, groups: [] });
  });
});

describe("rate limit", () => {
  it("allows 30 a minute per network, then 429", async () => {
    expect(CONSOLE_PASSKEY_PER_NETWORK_MINUTE).toBe(30);
    let last = 0;
    for (let i = 0; i < CONSOLE_PASSKEY_PER_NETWORK_MINUTE + 1; i++) {
      last = (await begin({}, { "cf-connecting-ip": "203.0.113.7" })).res
        .status;
      if (i < CONSOLE_PASSKEY_PER_NETWORK_MINUTE) expect(last).toBe(200);
    }
    expect(last).toBe(429);
    // Another network has its own budget.
    expect(
      (await begin({}, { "cf-connecting-ip": "198.51.100.9" })).res.status,
    ).toBe(200);
  });
});
