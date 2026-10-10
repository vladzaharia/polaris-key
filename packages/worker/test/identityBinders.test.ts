/**
 * The `returnTo` shape, same-origin JSON on the card endpoints, the browser-session cookie
 * and key exchange, the portal logout, and the admin sign-in's origin and timeout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import {
  CARD_RETURN_TO,
  PORTAL_SIGNIN_RETURN_TO,
  PRODUCT_SIGNIN_RETURN_TO,
  safeReturnTo,
} from "../src/platform/returnTo.js";
import {
  BROWSER_JSON_MAX_BYTES,
  isSameOriginRequest,
  readGuardedJsonObject,
} from "../src/core/accounts/browserRequestGuard.js";
import { readJsonObject } from "../src/services/identity/card/http.js";
import {
  handleBrowserSession,
  handleBrowserSessionLicense,
} from "../src/services/identity/browserSession.js";
import { handlePortalLogout } from "../src/services/identity/portal/auth.js";
import { handleAdminCallback, handleAdminLogin } from "../src/console/auth.js";
import { bindAdminFlow } from "./flowBinderHelper.js";

const ORIGIN = "https://key.plrs.im";
const here = new Request(`${ORIGIN}/signin`) as unknown as Request;

describe("returnTo never yields a protocol-relative redirect", () => {
  const hostile = [
    "//evil.com",
    "//evil.com/x",
    "/\\evil.com",
    "\\\\evil.com",
    `${ORIGIN}//evil.com`,
    `${ORIGIN}/\\evil.com`,
    "///evil.com",
    "/%2F/evil.com/..//evil.com",
  ];
  it.each(hostile)(
    "the card policy refuses %s or keeps it a local path",
    (raw) => {
      const out = safeReturnTo(here, raw, CARD_RETURN_TO);
      // Either refused, or a path that is not protocol-relative once it is a Location.
      if (out !== undefined) {
        expect(out).toMatch(/^\/(?![/\\])/);
        expect(new URL(out, ORIGIN).origin).toBe(ORIGIN);
      }
    },
  );
  it("the exact reproduction is refused", () => {
    expect(safeReturnTo(here, `${ORIGIN}//evil.com`, CARD_RETURN_TO)).toBe(
      undefined,
    );
    expect(safeReturnTo(here, "//evil.com", CARD_RETURN_TO)).toBeUndefined();
  });
  it("ordinary local targets still pass", () => {
    expect(safeReturnTo(here, "/account?tab=a#x", CARD_RETURN_TO)).toBe(
      "/account?tab=a#x",
    );
    expect(safeReturnTo(here, `${ORIGIN}/ok`, CARD_RETURN_TO)).toBe("/ok");
    expect(safeReturnTo(here, "/", CARD_RETURN_TO)).toBe("/");
  });
  it("the absolute policies are unchanged", () => {
    expect(safeReturnTo(here, `${ORIGIN}/x`, PRODUCT_SIGNIN_RETURN_TO)).toBe(
      `${ORIGIN}/x`,
    );
    expect(
      safeReturnTo(here, `${ORIGIN}/manage/x`, PORTAL_SIGNIN_RETURN_TO),
    ).toBeUndefined();
  });
});

describe("card JSON endpoints", () => {
  const post = (init: RequestInit & { body?: string }) =>
    new Request(`${ORIGIN}/api/signin/email/start`, {
      method: "POST",
      ...init,
    }) as unknown as Request;
  const json = { "content-type": "application/json" };
  const body = JSON.stringify({ email: "a@b.co" });

  it("accepts same-origin JSON", async () => {
    expect(await readJsonObject(post({ headers: json, body }))).toEqual({
      email: "a@b.co",
    });
    expect(
      await readJsonObject(
        post({
          headers: { ...json, "sec-fetch-site": "same-origin" },
          body,
        }),
      ),
    ).toEqual({ email: "a@b.co" });
  });
  it("refuses a text/plain or form body (a cross-site simple request)", async () => {
    expect(
      await readJsonObject(
        post({ headers: { "content-type": "text/plain" }, body }),
      ),
    ).toBeNull();
    expect(await readJsonObject(post({ body }))).toBeNull();
  });
  it("refuses a cross-site Fetch Metadata or foreign Origin even with JSON", async () => {
    for (const headers of [
      { ...json, "sec-fetch-site": "cross-site" },
      { ...json, "sec-fetch-site": "same-site" },
      { ...json, origin: "https://evil.example" },
      { ...json, origin: "null" },
    ])
      expect(await readJsonObject(post({ headers, body }))).toBeNull();
    expect(isSameOriginRequest(post({ headers: json }))).toBe(true);
  });
  it("refuses a body over the cap, declared or streamed", async () => {
    const big = JSON.stringify({ pad: "x".repeat(BROWSER_JSON_MAX_BYTES) });
    expect(await readJsonObject(post({ headers: json, body: big }))).toBeNull();
    expect(
      await readGuardedJsonObject(
        post({
          headers: { ...json, "content-length": String(big.length) },
          body: "{}",
        }),
      ),
    ).toBeNull();
  });
});

async function productFixture() {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
  const product = (await loadProduct(env, db, "djdl"))!;
  return { db, env, product };
}

describe("/session/license is same-origin only", () => {
  it("opens a session for same-origin JSON and refuses a cross-site POST", async () => {
    const { db, env, product } = await productFixture();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const make = (extra: Record<string, string>) =>
      new Request(`${ORIGIN}/djdl/identity/session/license`, {
        method: "POST",
        headers: { "content-type": "text/plain", ...extra },
        body: JSON.stringify({ key }),
      }) as unknown as Request;
    const cross = await handleBrowserSessionLicense(
      make({ "sec-fetch-site": "cross-site" }),
      env,
      db,
      product,
      NOW,
    );
    expect(cross.status).toBe(403);
    expect(cross.headers.get("set-cookie")).toBeNull();
    const own = await handleBrowserSessionLicense(
      make({ "sec-fetch-site": "same-origin" }),
      env,
      db,
      product,
      NOW,
    );
    expect(own.status).toBe(201);
  });
});

describe("product session cookie parsing", () => {
  const get = (cookie: string) =>
    new Request(`${ORIGIN}/djdl/identity/session`, {
      headers: { cookie },
    }) as unknown as Request;
  it("a malformed percent-encoding is signed out, not a 500", async () => {
    const { db, env, product } = await productFixture();
    const res = await handleBrowserSession(
      get("pkey_djdl_session=%E0%A4%A"),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { authenticated: boolean }).authenticated,
    ).toBe(false);
  });
  it("a duplicated cookie fails closed instead of taking the first", async () => {
    const { db, env, product } = await productFixture();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const opened = await handleBrowserSessionLicense(
      new Request(`${ORIGIN}/djdl/identity/session/license`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      }) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    const mine = opened.headers.get("set-cookie")!.split(";")[0]!;
    const authed = async (cookie: string) =>
      (
        (await (
          await handleBrowserSession(get(cookie), env, db, product, NOW + 1)
        ).json()) as { authenticated: boolean }
      ).authenticated;
    expect(await authed(mine)).toBe(true);
    for (const dup of [
      `${mine}; pkey_djdl_session=planted`,
      `pkey_djdl_session=planted; ${mine}`,
    ])
      expect(await authed(dup)).toBe(false);
  });
});

describe("portal logout", () => {
  const out = (headers: Record<string, string>) =>
    new Request(`${ORIGIN}/logout`, {
      method: "POST",
      headers,
    }) as unknown as Request;
  it("refuses a cross-site POST and accepts a same-origin one", async () => {
    const crossSite: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
    ];
    for (const headers of crossSite)
      expect((await handlePortalLogout(out(headers))).status).toBe(405);
    expect(
      (await handlePortalLogout(out({ "sec-fetch-site": "same-origin" })))
        .status,
    ).toBe(302);
  });
});

describe("admin sign-in origin and timeouts", () => {
  afterEach(() => vi.unstubAllGlobals());
  const adminEnvFor = () => {
    const env = makeEnv(new KvMock(), []);
    env.ADMIN_SESSION_SECRET = "s";
    env.PLATFORM_OIDC_ISSUER = "https://id.example";
    env.PLATFORM_OIDC_CLIENT_ID = "console";
    env.PLATFORM_ADMIN_GROUP = "admins";
    return env;
  };
  it("the redirect_uri comes from CONSOLE_ORIGIN, not the request's Host", async () => {
    const env = adminEnvFor();
    env.CONSOLE_ORIGIN = "https://key.plrs.im";
    const res = await handleAdminLogin(
      new Request("https://evil.example/manage/login") as unknown as Request,
      env,
    );
    expect(
      new URL(res.headers.get("location")!).searchParams.get("redirect_uri"),
    ).toBe("https://key.plrs.im/manage/callback");
  });
  it("the token exchange carries a timeout and the callback answers no-store", async () => {
    const env = adminEnvFor();
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        seen.push(init?.signal);
        return new Response("{}", { status: 400 });
      }),
    );
    const login = await handleAdminLogin(
      new Request(`${ORIGIN}/manage/login`) as unknown as Request,
      env,
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const res = await handleAdminCallback(
      new Request(`${ORIGIN}/manage/callback?code=c&state=${state}`, {
        headers: { cookie: await bindAdminFlow(env, state) },
      }) as unknown as Request,
      env,
      makeTestDb(),
      NOW,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});
