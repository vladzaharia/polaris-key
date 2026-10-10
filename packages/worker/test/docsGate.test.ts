/**
 * The gated docs site (`/docs`) + the `returnTo` leg of the admin sign-in.
 *
 * What is pinned here, and why it matters:
 *  - EVERYTHING under /docs is session-gated — pages, hashed assets, the search index, the
 *    machine-readable artifacts. The site carries real operator material (docs plan N7); a
 *    single ungated path class would defeat the reason it is allowed to.
 *  - The unauthenticated response is a redirect into the normal sign-in carrying the wanted
 *    path, and the callback honours it ONLY through `sanitizeReturnTo`'s allowlist — the
 *    validator matrix below is the open-redirect defense (R9 discipline).
 *  - Cache policy is part of the gate: HTML is `no-store`, immutable assets are `private` —
 *    a shared cache must never hold gated bytes.
 */

import { bindAdminFlow } from "./flowBinderHelper.js";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/platform/env.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { makeTestDb } from "./helpers.js";
import { handleDocs, docsAssetPath, docsSecurityHeaders } from "../src/docs.js";
import { matchRoute } from "../src/router.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  sanitizeReturnTo,
  type IdTokenVerifier,
} from "../src/console/auth.js";
import {
  ADMIN_COOKIE,
  issueSession,
  type SessionIdentity,
} from "../src/core/console/session.js";

const ADMIN_SECRET = "docs-test-admin-secret";
const PLATFORM_GROUP = "admins";
const OPERATOR: SessionIdentity = {
  sub: "op-1",
  name: "Operator",
  email: "op@example.com",
  groups: [PLATFORM_GROUP],
};

/** A tiny static-assets fixture standing in for the assembled `assets/` root. */
const ASSET_FILES: Record<string, { body: string; type: string }> = {
  "/docs/index.html": { body: "<html>docs home</html>", type: "text/html" },
  "/docs/404.html": { body: "<html>docs 404</html>", type: "text/html" },
  "/docs/services/license/index.html": {
    body: "<html>license service</html>",
    type: "text/html",
  },
  "/docs/_astro/app.abc123.css": { body: "body{}", type: "text/css" },
  "/docs/pagefind/pagefind.js": { body: "export{}", type: "text/javascript" },
  "/docs/pagefind/index/en_abc123.pf_index": {
    body: "shard",
    type: "application/octet-stream",
  },
  "/docs/schemas/v1/product.schema.json": {
    body: "{}",
    type: "application/json",
  },
};

function assetsMock(): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url,
      );
      const hit = ASSET_FILES[url.pathname];
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(hit.body, {
        status: 200,
        headers: { "content-type": hit.type },
      });
    },
  } as unknown as Fetcher;
}

function docsEnv(opts: { assets?: boolean } = {}): Env {
  const env = makeEnv(new KvMock(), []);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  env.PLATFORM_OIDC_ISSUER = "https://id.example.com";
  env.PLATFORM_OIDC_CLIENT_ID = "polaris-admin";
  if (opts.assets !== false) env.ASSETS = assetsMock();
  return env;
}

async function adminCookie(env: Env): Promise<string> {
  const { token } = await issueSession(env, OPERATOR, NOW);
  return `${ADMIN_COOKIE}=${token}`;
}

function get(path: string, cookie?: string): Request {
  return new Request(`https://key.plrs.im${path}`, {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
}

// ── routing ──────────────────────────────────────────────────────────────────

describe("router: /docs is a reserved platform route", () => {
  it("matches /docs, /docs/, and deep paths ahead of product slugs", () => {
    expect(matchRoute("/docs")).toEqual({ kind: "docs" });
    expect(matchRoute("/docs/")).toEqual({ kind: "docs" });
    expect(matchRoute("/docs/services/license/")).toEqual({ kind: "docs" });
  });

  it("does not swallow near-miss product slugs", () => {
    // `/docsy/...` is a product-scoped path for the (hypothetical) product `docsy`.
    expect(matchRoute("/docsy/license/activate")).toMatchObject({
      kind: "service",
      product: "docsy",
    });
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe("handleDocs: the platform-admin gate", () => {
  it("redirects an unauthenticated page hit into sign-in with returnTo", async () => {
    const res = await handleDocs(
      get("/docs/services/license/"),
      docsEnv(),
      NOW,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/manage/login?returnTo=${encodeURIComponent("/docs/services/license/")}`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("gates assets and machine-readable artifacts identically", async () => {
    const env = docsEnv();
    for (const path of [
      "/docs/_astro/app.abc123.css",
      "/docs/pagefind/pagefind.js",
      "/docs/schemas/v1/product.schema.json",
    ]) {
      const res = await handleDocs(get(path), env, NOW);
      expect(res.status, path).toBe(302);
    }
  });

  it("rejects a tampered session cookie", async () => {
    const env = docsEnv();
    const cookie = (await adminCookie(env)).slice(0, -4) + "AAAA";
    const res = await handleDocs(get("/docs/", cookie), env, NOW);
    expect(res.status).toBe(302);
  });

  it("rejects an expired session", async () => {
    const env = docsEnv();
    const cookie = await adminCookie(env);
    const later = NOW + 9 * 60 * 60; // past the 8h session TTL
    const res = await handleDocs(get("/docs/", cookie), env, later);
    expect(res.status).toBe(302);
  });

  it("serves a signed-in operator with no-store HTML and the hash-carrying CSP", async () => {
    const env = docsEnv();
    const res = await handleDocs(
      get("/docs/", await adminCookie(env)),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("docs home");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("strict-transport-security")).toBeTruthy();
  });

  it("refuses non-GET/HEAD methods", async () => {
    const env = docsEnv();
    const res = await handleDocs(
      new Request("https://key.plrs.im/docs/", {
        method: "POST",
        headers: { cookie: await adminCookie(env) },
      }),
      env,
      NOW,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});

// ── asset resolution + caching ───────────────────────────────────────────────

describe("handleDocs: asset resolution", () => {
  it("resolves extension-less deep links to the directory index", async () => {
    const env = docsEnv();
    const cookie = await adminCookie(env);
    for (const path of ["/docs/services/license", "/docs/services/license/"]) {
      const res = await handleDocs(get(path, cookie), env, NOW);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("license service");
    }
  });

  it("marks content-hashed assets private+immutable, never shared-cacheable", async () => {
    const env = docsEnv();
    const cookie = await adminCookie(env);
    const res = await handleDocs(
      get("/docs/_astro/app.abc123.css", cookie),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    // Pagefind's LOADER files have stable names — the rotating entry/loader set must
    // revalidate, or a deploy strands cached browsers on deleted shards (search breaks).
    const loader = await handleDocs(
      get("/docs/pagefind/pagefind.js", cookie),
      env,
      NOW,
    );
    expect(loader.headers.get("cache-control")).toBe("private, no-cache");
    const shard = await handleDocs(
      get("/docs/pagefind/index/en_abc123.pf_index", cookie),
      env,
      NOW,
    );
    expect(shard.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
  });

  it("serves the site's styled 404 for a miss", async () => {
    const env = docsEnv();
    const res = await handleDocs(
      get("/docs/no/such/page/", await adminCookie(env)),
      env,
      NOW,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("docs 404");
  });

  it("still gates (with a placeholder) when no assets binding exists", async () => {
    const env = docsEnv({ assets: false });
    const anon = await handleDocs(get("/docs/"), env, NOW);
    expect(anon.status).toBe(302);
    const authed = await handleDocs(
      get("/docs/", await adminCookie(env)),
      env,
      NOW,
    );
    expect(authed.status).toBe(200);
    expect(await authed.text()).toContain("has not been built");
  });

  it("docsAssetPath refuses unsafe shapes and resolves safe ones", () => {
    expect(docsAssetPath("/docs")).toBe("/docs/index.html");
    expect(docsAssetPath("/docs/")).toBe("/docs/index.html");
    expect(docsAssetPath("/docs/a/b/")).toBe("/docs/a/b/index.html");
    expect(docsAssetPath("/docs/a/b")).toBe("/docs/a/b/index.html");
    expect(docsAssetPath("/docs/x.css")).toBe("/docs/x.css");
    expect(docsAssetPath("/docs//x")).toBeNull(); // empty segment
    expect(docsAssetPath("/docs/%2e%2e/x")).toBeNull(); // percent-encoding
    expect(docsAssetPath("/docs/a b")).toBeNull(); // whitespace
  });

  it("docsSecurityHeaders carries the full hardening set", () => {
    const headers = docsSecurityHeaders();
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});

// ── sanitizeReturnTo: the open-redirect defense ──────────────────────────────

describe("sanitizeReturnTo", () => {
  it("accepts allowlisted same-origin paths", () => {
    for (const good of [
      "/docs",
      "/docs/",
      "/docs/services/license/",
      "/manage",
      "/manage/",
    ]) {
      expect(sanitizeReturnTo(good), good).toBe(good);
    }
  });

  it("rejects everything else", () => {
    const bad = [
      null,
      "",
      "https://evil.example/docs",
      "//evil.example/docs",
      "/docsevil",
      "/api/me",
      "/",
      "/docs/../manage/api",
      "/docs//x",
      "/docs/a?b=c",
      "/docs/a#frag",
      "/docs/a\\b",
      "/docs/%2e%2e",
      "/docs/a\r\nSet-Cookie:x=y",
      "/docs/" + "a".repeat(600),
    ];
    for (const value of bad) {
      expect(
        sanitizeReturnTo(value as string | null),
        String(value),
      ).toBeNull();
    }
  });
});

// ── the full sign-in round trip ──────────────────────────────────────────────

const stubVerifier: IdTokenVerifier = {
  verify: async () => OPERATOR,
};

/** Drive /manage/login and pull the `state` the flow was stored under. */
async function startLogin(env: Env, returnTo?: string): Promise<string> {
  const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
  const res = await handleAdminLogin(get(`/manage/login${query}`), env);
  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get("location")!);
  const state = authorize.searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
}

describe("admin sign-in returnTo round trip", () => {
  it("lands back on the requested docs page after the callback", async () => {
    const env = docsEnv();
    const db = makeTestDb();
    const state = await startLogin(env, "/docs/services/license/");
    const res = await handleAdminCallback(
      get(
        `/manage/callback?code=abc&state=${encodeURIComponent(state)}`,
        await bindAdminFlow(env, state),
      ),
      env,
      db,
      NOW,
      stubVerifier,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/docs/services/license/");
    expect(res.headers.get("set-cookie")).toContain(ADMIN_COOKIE);
  });

  it("falls back to /manage/ when the returnTo was hostile", async () => {
    const env = docsEnv();
    const db = makeTestDb();
    for (const evil of ["https://evil.example/", "//evil.example", "/api/x"]) {
      const state = await startLogin(env, evil);
      const res = await handleAdminCallback(
        get(
          `/manage/callback?code=abc&state=${encodeURIComponent(state)}`,
          await bindAdminFlow(env, state),
        ),
        env,
        db,
        NOW,
        stubVerifier,
      );
      expect(res.status, evil).toBe(302);
      expect(res.headers.get("location"), evil).toBe("/manage/");
    }
  });

  it("falls back to /manage/ when no returnTo was given", async () => {
    const env = docsEnv();
    const db = makeTestDb();
    const state = await startLogin(env);
    const res = await handleAdminCallback(
      get(
        `/manage/callback?code=abc&state=${encodeURIComponent(state)}`,
        await bindAdminFlow(env, state),
      ),
      env,
      db,
      NOW,
      stubVerifier,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/manage/");
  });
});
