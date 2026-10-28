/**
 * Admin session revocation, the step-up flag, and the dangerous-route table.
 *
 *   - an ordinary sign-in is NOT a step-up; only a `stepUp=1` flow with `auth_time` is;
 *   - platform routes that erase, export, delete or force a key need the step-up;
 *   - sign-out voids the cookie server-side; /docs and slug-check read the CURRENT platform
 *     group;
 *   - the console's ID-token verification carries the same freshness options.
 */
import { describe, expect, it } from "vitest";
import { bindAdminFlow } from "../flowBinderHelper.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import type { Env } from "../../src/platform/env.js";
import { handleAdmin } from "../../src/console/index.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../../src/console/auth.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  isSteppedUp,
  sessionFromRequest,
} from "../../src/core/console/session.js";
import {
  liveSubjectFor,
  resetConsoleSessionCache,
} from "../../src/console/consoleSession.js";
import { consoleTestSession, forgeV1Cookie } from "../consoleSessionHelper.js";
import { STEP_UP_ROUTES } from "../../src/console/stepUp.js";
import { handleDocs } from "../../src/docs.js";

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
    const plain = await consoleTestSession(
      env,
      db,
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
    const stepped = await consoleTestSession(
      env,
      db,
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
    const a = await consoleTestSession(
      env,
      db,
      { sub: "op", groups: [GROUP] },
      NOW,
    );
    const b = await consoleTestSession(
      env,
      db,
      { sub: "op", groups: [GROUP] },
      NOW,
    );
    const other = await consoleTestSession(
      env,
      db,
      { sub: "ann", groups: [GROUP] },
      NOW,
    );
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
    const s = await consoleTestSession(
      env,
      db,
      { sub: "op", groups: [GROUP] },
      NOW,
    );
    const docs = () =>
      handleDocs(
        // A gated page: Operate → Platform (the landing page is public since ST-29).
        new Request("https://key.plrs.im/docs/operate/platform/", {
          headers: { cookie: `${ADMIN_COOKIE}=${s.token}` },
        }) as unknown as Request,
        env,
        NOW,
        db,
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
    // The live check remembers an answer for 30 s; the group change is read from the next one.
    resetConsoleSessionCache();
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
// ST-30c.8: the v1 cookie (the IdP `sub` and `groups`, signed before the v2 deploy) is no longer
// read anywhere. It is no session, and the answer is the one a request with no cookie gets.
// ---------------------------------------------------------------------------

describe("a v1 cookie is no session", () => {
  it("is refused with the answer a cookie-less request gets, so nothing says why", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const v1 = await forgeV1Cookie(env, { sub: "op-1", groups: [GROUP] }, NOW);
    const none = await handleAdmin(
      new Request("https://key.plrs.im/manage/api/me") as unknown as Request,
      env,
      db,
      "/api/me",
      { now: NOW },
    );
    const res = await api(env, db, v1.token, v1.csrf, "GET", "/api/me");
    expect(res.status).toBe(401);
    expect(none.status).toBe(401);
    expect(await res.text()).toBe(await none.text());
    expect(res.headers.get("set-cookie")).toBe(none.headers.get("set-cookie"));
  });

  it("is refused by the reader itself, with and without a live check", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const v1 = await forgeV1Cookie(env, { sub: "op-1", groups: [GROUP] }, NOW);
    const req = new Request("https://key.plrs.im/manage/api/me", {
      headers: { cookie: v1.cookie },
    });
    expect(await sessionFromRequest(env, req, NOW)).toBeNull();
    expect(
      await sessionFromRequest(env, req, NOW, liveSubjectFor(env, db, NOW)),
    ).toBeNull();
  });

  it("is no session for /docs either", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const v1 = await forgeV1Cookie(env, { sub: "op-1", groups: [GROUP] }, NOW);
    const res = await handleDocs(
      new Request("https://key.plrs.im/docs/operate/platform/", {
        headers: { cookie: v1.cookie },
      }) as unknown as Request,
      env,
      NOW,
      db,
    );
    // The sign-in redirect, as for a request with no cookie.
    expect(res.status).toBe(302);
  });

  it("cannot sign out, and a sign-out attempt leaves the operator's v2 sessions alone", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const v2 = await consoleTestSession(
      env,
      db,
      { sub: "op-1", name: "Ada", email: "ada@example.com", groups: [GROUP] },
      NOW,
    );
    const v1 = await forgeV1Cookie(
      env,
      { sub: "op-1", groups: [GROUP] },
      NOW + 2,
    );
    const out = await api(env, db, v1.token, v1.csrf, "POST", "/api/logout");
    expect(out.status).toBe(401);
    expect(
      (await api(env, db, v2.token, v2.csrf, "GET", "/api/me")).status,
    ).toBe(200);
  });
});
