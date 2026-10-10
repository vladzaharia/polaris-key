// I-03 (S-16 §5.4 item 1): the console signs operators in through its own Pocket ID client
// (`ADMIN_OIDC_*`), falling back to the shared platform client (`PLATFORM_OIDC_*`) only while the
// admin trio is unset. The portal and `provider: platform` products read `PLATFORM_OIDC_*` only,
// so a customer sign-in can never go through the operators' client.

import { bindAdminFlow } from "./flowBinderHelper.js";
import { issuerMetadataResponse } from "./oidcIssuerFake.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import {
  adminOidcConfig,
  adminOidcIsDedicated,
  platformOidcConfig,
} from "../src/platform/platformOidc.js";
import { handleAdminCallback, handleAdminLogin } from "../src/console/auth.js";
import { handlePortalLogin } from "../src/services/identity/portal/auth.js";

const ADMIN = {
  ADMIN_OIDC_ISSUER: "https://id.admin.example",
  ADMIN_OIDC_CLIENT_ID: "console-client",
  ADMIN_OIDC_CLIENT_SECRET: "console-SENTINEL-secret",
};
const PLATFORM = {
  PLATFORM_OIDC_ISSUER: "https://id.platform.example",
  PLATFORM_OIDC_CLIENT_ID: "platform-client",
  PLATFORM_OIDC_CLIENT_SECRET: "platform-SENTINEL-secret",
};

function envWith(vars: Record<string, string>): Env {
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  Object.assign(env, vars);
  return env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adminOidcConfig / platformOidcConfig precedence", () => {
  it("with both trios set, the console uses ADMIN_OIDC_* and the platform uses PLATFORM_OIDC_*", () => {
    const env = envWith({ ...ADMIN, ...PLATFORM });
    expect(adminOidcConfig(env)).toEqual({
      issuer: ADMIN.ADMIN_OIDC_ISSUER,
      clientId: ADMIN.ADMIN_OIDC_CLIENT_ID,
      clientSecret: ADMIN.ADMIN_OIDC_CLIENT_SECRET,
    });
    expect(platformOidcConfig(env)).toEqual({
      issuer: PLATFORM.PLATFORM_OIDC_ISSUER,
      clientId: PLATFORM.PLATFORM_OIDC_CLIENT_ID,
      clientSecret: PLATFORM.PLATFORM_OIDC_CLIENT_SECRET,
    });
    expect(adminOidcIsDedicated(env)).toBe(true);
  });

  it("with only PLATFORM_OIDC_* set, the console falls back to the platform client", () => {
    const env = envWith(PLATFORM);
    expect(adminOidcConfig(env)).toEqual(platformOidcConfig(env));
    expect(adminOidcConfig(env)?.clientId).toBe("platform-client");
    expect(adminOidcIsDedicated(env)).toBe(false);
  });

  it("never lends ADMIN_OIDC_* to the platform: only the admin trio set leaves the portal unconfigured", () => {
    const env = envWith(ADMIN);
    expect(platformOidcConfig(env)).toBeNull();
    expect(adminOidcConfig(env)?.clientId).toBe("console-client");
  });

  it("a half-set admin trio falls back whole: no field is mixed across trios", () => {
    const env = envWith({
      ...PLATFORM,
      ADMIN_OIDC_ISSUER: ADMIN.ADMIN_OIDC_ISSUER,
      ADMIN_OIDC_CLIENT_SECRET: ADMIN.ADMIN_OIDC_CLIENT_SECRET,
    });
    expect(adminOidcConfig(env)).toEqual(platformOidcConfig(env));
    expect(adminOidcIsDedicated(env)).toBe(false);
  });

  it("a dedicated console client without a secret stays public: it never borrows the platform secret", () => {
    const env = envWith({
      ...PLATFORM,
      ADMIN_OIDC_ISSUER: ADMIN.ADMIN_OIDC_ISSUER,
      ADMIN_OIDC_CLIENT_ID: ADMIN.ADMIN_OIDC_CLIENT_ID,
    });
    expect(adminOidcConfig(env)).toEqual({
      issuer: ADMIN.ADMIN_OIDC_ISSUER,
      clientId: ADMIN.ADMIN_OIDC_CLIENT_ID,
      clientSecret: undefined,
    });
  });

  it("treats an empty string as unset", () => {
    const env = envWith({
      ...PLATFORM,
      ADMIN_OIDC_ISSUER: "",
      ADMIN_OIDC_CLIENT_ID: "",
    });
    expect(adminOidcConfig(env)?.clientId).toBe("platform-client");
  });

  it("with neither trio set, nothing is configured", () => {
    const env = envWith({});
    expect(adminOidcConfig(env)).toBeNull();
    expect(platformOidcConfig(env)).toBeNull();
  });
});

async function authorizeOf(res: Response): Promise<URL> {
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

async function adminLogin(env: Env): Promise<URL> {
  return authorizeOf(
    await handleAdminLogin(
      new Request("https://key.plrs.im/manage/login") as unknown as Request,
      env,
    ),
  );
}

async function portalLogin(env: Env): Promise<URL> {
  const db = makeTestDb();
  await seedProduct(db, "djdl");
  return authorizeOf(
    await handlePortalLogin(
      new Request("https://key.plrs.im/login") as unknown as Request,
      env,
      db,
    ),
  );
}

/** Drive the admin callback with the production verifier and capture the token exchange. The
 *  stubbed IdP refuses the code, so the callback ends in 401 after the request is observed. */
async function adminTokenExchange(
  env: Env,
): Promise<{ url: string; body: URLSearchParams }> {
  const seen: { url: string; body: URLSearchParams }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // I-30: the one client discovers the issuer first; only the token request is recorded.
      const meta = await issuerMetadataResponse(String(input), null);
      if (meta) return meta;
      seen.push({
        url: String(input),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      return new Response("{}", { status: 400 });
    }),
  );
  // A real login writes the flow; its state comes back in the authorize redirect.
  const state = (await adminLogin(env)).searchParams.get("state")!;
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie: await bindAdminFlow(env, state) },
    }) as unknown as Request,
    env,
    makeTestDb(),
    NOW,
  );
  expect(res.status).toBe(401);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe("console and portal sign-in use their own clients", () => {
  it("with both trios set: console sign-in uses ADMIN_OIDC_*, portal sign-in uses PLATFORM_OIDC_*", async () => {
    const env = envWith({ ...ADMIN, ...PLATFORM });

    const console = await adminLogin(env);
    expect(console.origin).toBe(ADMIN.ADMIN_OIDC_ISSUER);
    expect(console.searchParams.get("client_id")).toBe("console-client");

    const exchange = await adminTokenExchange(env);
    expect(exchange.url).toBe(`${ADMIN.ADMIN_OIDC_ISSUER}/api/oidc/token`);
    expect(exchange.body.get("client_id")).toBe("console-client");
    expect(exchange.body.get("client_secret")).toBe(
      ADMIN.ADMIN_OIDC_CLIENT_SECRET,
    );

    const portal = await portalLogin(env);
    expect(portal.origin).toBe(PLATFORM.PLATFORM_OIDC_ISSUER);
    expect(portal.searchParams.get("client_id")).toBe("platform-client");
  });

  it("with only PLATFORM_OIDC_* set: both console and portal still sign in through the platform client", async () => {
    const env = envWith(PLATFORM);

    const console = await adminLogin(env);
    expect(console.origin).toBe(PLATFORM.PLATFORM_OIDC_ISSUER);
    expect(console.searchParams.get("client_id")).toBe("platform-client");

    const exchange = await adminTokenExchange(env);
    expect(exchange.url).toBe(
      `${PLATFORM.PLATFORM_OIDC_ISSUER}/api/oidc/token`,
    );
    expect(exchange.body.get("client_id")).toBe("platform-client");
    expect(exchange.body.get("client_secret")).toBe(
      PLATFORM.PLATFORM_OIDC_CLIENT_SECRET,
    );

    const portal = await portalLogin(env);
    expect(portal.searchParams.get("client_id")).toBe("platform-client");
  });

  it("the sign-in error pages never echo either client secret", async () => {
    const env = envWith({ ...ADMIN, ...PLATFORM });
    const res = await handleAdminCallback(
      new Request(
        "https://key.plrs.im/manage/callback?code=c&state=unknown",
      ) as unknown as Request,
      env,
      makeTestDb(),
      NOW,
    );
    const text = await res.text();
    expect(text).not.toContain("SENTINEL");
  });
});

describe("admin sign-in leaves detection rows", () => {
  async function callback(
    env: Env,
    db: ReturnType<typeof makeTestDb>,
    identity: { sub: string; groups: string[] } | null,
  ) {
    const state = (await adminLogin(env)).searchParams.get("state")!;
    return handleAdminCallback(
      // The browser that started the sign-in (the flow binder), as every callback needs.
      new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
        headers: { cookie: await bindAdminFlow(env, state) },
      }) as unknown as Request,
      env,
      db,
      NOW,
      {
        verify: async () =>
          identity
            ? ({ ...identity, name: "A", email: "a@example.com" } as never)
            : null,
      },
    );
  }

  it("records success, refusal and failure without the email", async () => {
    const env = envWith({ ...ADMIN, PLATFORM_ADMIN_GROUP: "pk-admins" });
    const db = makeTestDb();
    expect((await callback(env, db, null)).status).toBe(401);
    expect((await callback(env, db, { sub: "u1", groups: [] })).status).toBe(
      403,
    );
    expect(
      (await callback(env, db, { sub: "u2", groups: ["pk-admins"] })).status,
    ).toBe(302);
    const rows = await db.all<{ action: string; actor_sub: string | null }>(
      "SELECT action, actor_sub FROM platform_audit ORDER BY at, id",
    );
    expect(rows.map((r) => r.action).sort()).toEqual([
      "admin.signin",
      "admin.signin.failed",
      "admin.signin.refused",
    ]);
    expect(
      JSON.stringify(await db.all("SELECT * FROM platform_audit")),
    ).not.toContain("@");
  });
});
