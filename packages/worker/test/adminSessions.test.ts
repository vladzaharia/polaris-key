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
import { bindAdminFlow } from "./flowBinderHelper.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../src/admin/auth.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  isSteppedUp,
  issueSession,
  verifySession,
} from "../src/admin/session.js";
import { STEP_UP_ROUTES } from "../src/admin/stepUp.js";
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
  const start = await handleAdminLogin(
    new Request(
      `https://key.plrs.im/manage/login${opts.stepUp ? "?stepUp=1" : ""}`,
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
    makeTestDb(),
    NOW,
    verifier,
  );
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const token = cookie.slice(cookie.indexOf("=") + 1);
  return { res, token, session: await verifySession(env, token, NOW) };
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
        new Request("https://key.plrs.im/docs/", {
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
