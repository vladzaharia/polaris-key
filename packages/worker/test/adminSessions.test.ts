/**
 * Admin session revocation, the step-up flag, and the dangerous-route table.
 *
 *   - an ordinary sign-in is NOT a step-up; only a `stepUp=1` flow with `auth_time` is;
 *   - platform routes that erase, export, delete or force a key need the step-up;
 *   - sign-out voids the cookie server-side; /docs and slug-check read the CURRENT platform
 *     group;
 *   - the console's ID-token verification carries the same freshness options.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  isSteppedUp,
  issueSession,
  buildSessionCookie,
  sessionFromRequest,
  verifySession,
} from "../src/core/console/session.js";
import { revokeAdminSessions } from "../src/core/console/sessionRevocation.js";
import {
  liveSubjectFor,
  resetConsoleSessionCache,
} from "../src/console/consoleSession.js";
import { consoleTestSession } from "./consoleSessionHelper.js";
import { STEP_UP_ROUTES } from "../src/console/stepUp.js";
import { handleDocs } from "../src/docs.js";

const GROUP = "platform-admins";

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = "https://id.example";
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  return env;
}

async function login(env: Env, opts: { stepUp?: boolean; authTime?: number }) {
  const db = makeTestDb();
  const start = await handleAdminLogin(
    new Request(
      `https://key.plrs.im/manage/login?go=1${opts.stepUp ? "&stepUp=1" : ""}`,
    ) as unknown as Request,
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: "op",
      groups: [GROUP],
      ...(opts.authTime !== undefined ? { authTime: opts.authTime } : {}),
    }),
  };
  const res = await handleAdminCallback(
    // The browser that started the sign-in (the console flow binder).
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
  // The sign-in mints a v2 cookie: resolve it the way the console does, against the session row.
  const session = await sessionFromRequest(
    env,
    new Request("https://key.plrs.im/manage/api/me", {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }),
    NOW,
    liveSubjectFor(env, db, NOW),
  );
  return { res, token, session };
}

async function api(
  env: Env,
  db: ReturnType<typeof makeTestDb>,
  token: string,
  csrf: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
  };
  if (method !== "GET") headers[CSRF_HEADER] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as unknown as Request,
    env,
    db,
    path.split("?")[0]!,
    { now: NOW },
  );
}

describe("step-up is a proven re-authentication", () => {
  it("an ordinary sign-in, even a brand new one, is not stepped up", async () => {
    const env = adminEnv();
    const { session } = await login(env, { authTime: NOW });
    expect(session?.authAt).toBe(NOW);
    expect(isSteppedUp(session!, NOW)).toBe(false);
  });

  it("a step-up flow whose token carries auth_time is; one without auth_time is not", async () => {
    const env = adminEnv();
    const proven = await login(env, { stepUp: true, authTime: NOW - 5 });
    expect(isSteppedUp(proven.session!, NOW)).toBe(true);
    const unproven = await login(env, { stepUp: true });
    expect(isSteppedUp(unproven.session!, NOW)).toBe(false);
  });
});

describe("dangerous platform routes", () => {
  it("lists the gated routes in one table", () => {
    expect(STEP_UP_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        "DELETE /products/:slug",
        "POST /products/kek",
        "GET /products/:slug/users/:subject/export",
      ]),
    );
  });

  it("product delete and the KEK re-seal refuse a session that never stepped up", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await seedProduct(db, "alpha");
    const plain = await issueSession(
      env,
      { sub: "op", groups: [GROUP], authTime: NOW },
      NOW,
    );
    for (const [method, path, body] of [
      ["DELETE", "/api/products/alpha", { confirmSlug: "alpha" }],
      ["POST", "/api/products/kek", {}],
    ] as const) {
      const res = await api(
        env,
        db,
        plain.token,
        plain.session.csrf,
        method,
        path,
        body,
      );
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(
        "step_up_required",
      );
    }
    const stepped = await issueSession(
      env,
      { sub: "op", groups: [GROUP], authTime: NOW, stepUp: true },
      NOW,
    );
    const res = await api(
      env,
      db,
      stepped.token,
      stepped.session.csrf,
      "DELETE",
      "/api/products/alpha",
      { confirmSlug: "alpha" },
    );
    expect(res.status).toBe(200);
  });
});

describe("server-side sign-out", () => {
  it("a cookie replayed after logout is a 401, for every cookie that operator holds", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const a = await issueSession(env, { sub: "op", groups: [GROUP] }, NOW);
    const b = await issueSession(env, { sub: "op", groups: [GROUP] }, NOW);
    const other = await issueSession(env, { sub: "ann", groups: [GROUP] }, NOW);
    expect(
      (await api(env, db, a.token, a.session.csrf, "GET", "/api/me")).status,
    ).toBe(200);
    const out = await api(
      env,
      db,
      a.token,
      a.session.csrf,
      "POST",
      "/api/logout",
    );
    expect(out.status).toBe(200);
    for (const s of [a, b])
      expect(
        (await api(env, db, s.token, s.session.csrf, "GET", "/api/me")).status,
      ).toBe(401);
    expect(
      (await api(env, db, other.token, other.session.csrf, "GET", "/api/me"))
        .status,
    ).toBe(200);
  });

  it("/docs and slug-check follow the current platform group", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const s = await issueSession(env, { sub: "op", groups: [GROUP] }, NOW);
    const docs = () =>
      handleDocs(
        // A gated page: Operate → Platform (the landing page is public since ST-29).
        new Request("https://key.plrs.im/docs/operate/platform/", {
          headers: { cookie: `${ADMIN_COOKIE}=${s.token}` },
        }) as unknown as Request,
        env,
        NOW,
      );
    expect((await docs()).status).not.toBe(403);
    expect(
      (
        await api(
          env,
          db,
          s.token,
          s.session.csrf,
          "GET",
          "/api/products/slug-check?slug=free-slug",
        )
      ).status,
    ).toBe(200);
    env.PLATFORM_ADMIN_GROUP = "someone-else";
    expect((await docs()).status).toBe(403);
    expect(
      (
        await api(
          env,
          db,
          s.token,
          s.session.csrf,
          "GET",
          "/api/products/slug-check?slug=free-slug",
        )
      ).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// v1 cookies. The reader still honours cookies signed before the v2 deploy, until they expire.
// These are the cases that need a v1 minter; every other worker test signs in through
// `consoleTestSession` (ST-30c.7). ST-30c.8 deletes the v1 reader, and with it this block (the
// replacement asserts that a v1-signed cookie is refused).
// ---------------------------------------------------------------------------

describe("v1 cookies", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a v1 cookie signed before the v2 deploy is still read until it expires", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token, session } = await issueSession(
      env,
      { sub: "op-1", name: "Ada", email: "ada@example.com", groups: [GROUP] },
      NOW,
    );
    const at = async (now: number) =>
      (
        await handleAdmin(
          new Request("https://key.plrs.im/manage/api/me", {
            headers: { cookie: `${ADMIN_COOKIE}=${token}` },
          }) as unknown as Request,
          env,
          db,
          "/api/me",
          { now },
        )
      ).status;
    expect(session.csrf).toBeTruthy();
    expect(await at(NOW + 1)).toBe(200);
    // Past its own 8 h it is gone.
    expect(await at(NOW + 8 * 3600 + 1)).toBe(401);
  });

  it("a v1 cookie honours the sign-out mark", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const v1 = await issueSession(env, { sub: "op-1", groups: [GROUP] }, NOW);
    await revokeAdminSessions(env, "op-1", NOW + 1);
    const res = await api(env, db, v1.token, v1.session.csrf, "GET", "/api/me");
    expect(res.status).toBe(401);
  });

  it("a v1 logout also ends the operator's v2 sessions (member-id mark)", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const v2 = await consoleTestSession(
      env,
      db,
      { sub: "op-1", name: "Ada", email: "ada@example.com", groups: [GROUP] },
      NOW,
    );
    expect(
      (await api(env, db, v2.token, v2.csrf, "GET", "/api/me")).status,
    ).toBe(200);
    const v1 = await issueSession(
      env,
      { sub: "op-1", name: "Ada", email: "ada@example.com", groups: [GROUP] },
      NOW + 2,
    );
    const out = await api(
      env,
      db,
      v1.token,
      v1.session.csrf,
      "POST",
      "/api/logout",
    );
    expect(out.status).toBe(200);
    resetConsoleSessionCache();
    expect(
      (await api(env, db, v2.token, v2.csrf, "GET", "/api/me")).status,
    ).toBe(401);
  });

  it("R1-02e: lastIndexOf('.') splitting is not forgeable (extra dots move the signed body)", async () => {
    const env = adminEnv();
    const { token } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [GROUP] },
      NOW,
    );
    // Appending a fake segment makes `body` = "<real body>.<real sig>", whose HMAC the
    // attacker cannot produce.
    expect(await verifySession(env, `${token}.zzzz`, NOW)).toBeNull();
    // A leading segment likewise changes the signed input.
    expect(await verifySession(env, `zzzz.${token}`, NOW)).toBeNull();
  });

  it("mints the identical v1 token and cookie from the same inputs (the P0-15 pin)", async () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(a: T): T => {
        const bytes = a as unknown as Uint8Array;
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
        return a;
      },
    );
    const pinNow = 1_800_000_000;
    const { token } = await issueSession(
      { ADMIN_SESSION_SECRET: "pin-admin-secret-0123456789" } as unknown as Env,
      {
        sub: "op-sub-1",
        name: "Ada Op",
        email: "ada@example.com",
        groups: ["polaris-admins"],
        authTime: pinNow - 30,
      },
      pinNow,
    );
    const pinned =
      "eyJzdWIiOiJvcC1zdWItMSIsIm5hbWUiOiJBZGEgT3AiLCJlbWFpbCI6ImFkYUBleGFtcGxlLmNvbSIsImdyb3VwcyI6WyJwb2xhcmlzLWFkbWlucyJdLCJjc3JmIjoiQXdvUkdCOG1MVFE3UWtsUVYxNWxiQSIsImV4cCI6MTgwMDAyODgwMCwiYXV0aEF0IjoxNzk5OTk5OTcwfQ.DwEnh2CmprxeDBR8RN87_ZrORb9J9XR34l4x_spJLhk";
    expect(token).toBe(pinned);
    expect(buildSessionCookie(token)).toBe(
      `__Host-pkey_admin=${pinned}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
    );
  });
});
