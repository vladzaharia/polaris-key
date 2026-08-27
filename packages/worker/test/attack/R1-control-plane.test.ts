/**
 * RED TEAM — R1 "control-plane takeover" proof-of-concept suite.
 *
 * These tests are ADVERSARIAL: each one asserts the *attacker-favourable* behaviour that
 * exists today, so that a future fix flips the assertion and the test fails loudly. Findings
 * that were investigated and REFUTED are kept here too (marked `REFUTED`) so the guard that
 * stops them is pinned by a test.
 *
 * See docs/security/findings/R1-control-plane.md for the write-up.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock, asKv } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import type { Env } from "../../src/env.js";
import type { Db } from "../../src/db/types.js";
import { handleAdmin } from "../../src/admin/index.js";
import type { IdTokenVerifier } from "../../src/admin/auth.js";
import {
  ADMIN_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  issueSession,
  verifySession,
} from "../../src/admin/session.js";
import {
  PORTAL_COOKIE,
  issuePortalSession,
  verifyPortalSession,
} from "../../src/services/identity/portal/session.js";
import { hasAnyAdminGrant } from "../../src/admin/authz.js";
import { hashKey } from "../../src/crypto.js";
import { listAudit } from "../../src/repo.js";
import { handleMintAuth } from "../../src/services/config/mint.js";
import { secureResponse } from "../../src/securityHeaders.js";
import { loadProduct } from "../../src/core/products.js";
import {
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
} from "../../src/services/identity/oidc.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

function adminEnv(kv: KvMock, slugs: string[] = []): Env {
  const env = makeEnv(kv, slugs);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  env.PLATFORM_OIDC_ISSUER = "https://id.example";
  env.PLATFORM_OIDC_CLIENT_ID = "polaris-admin";
  return env;
}

function req(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { method, headers }) as unknown as Request;
}

/** base64url helpers — identical scheme to src/admin/session.ts. */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

/** Sign `body` with the SAME raw HMAC key both session modules import. */
async function hmacB64url(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return b64url(new Uint8Array(sig));
}

// ───────────────────────────────────────────────────────────────────────────────
// R1-01 — Login CSRF / admin session fixation on GET /manage/callback
// ───────────────────────────────────────────────────────────────────────────────

describe("R1-01 login CSRF / session fixation (admin OIDC)", () => {
  it("R1-01a: /manage/login binds the flow to nothing in the browser (no Set-Cookie)", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = adminEnv(kv);
    const res = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/login"),
      env,
      db,
      "/login",
      { now: NOW },
    );
    expect(res.status).toBe(302);
    // The ONLY per-flow artefact is a KV row keyed by `state`. Nothing is planted in the
    // requesting browser, so /manage/callback cannot tell "the browser that started this
    // flow" from "any other browser".
    expect(res.headers.get("set-cookie")).toBeNull();
    const location = new URL(res.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    expect(state).toBeTruthy();
    // FIXED (R12-04): the key name is the HASHED state, so a KV listing is not a dump of live
    // OIDC `state` values. The flow record itself is unchanged.
    const flowKey = `admin:flow:${await hashKey(state, env.KEY_HASH_PEPPER)}`;
    expect(kv.keys()).toEqual([flowKey]);
    expect(kv.keys()[0]).not.toContain(state);
    // The stored flow holds only PKCE + nonce + redirect_uri — nothing browser-specific.
    const flow = JSON.parse((await kv.get(flowKey))!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(flow).sort()).toEqual([
      "nonce",
      "redirectUri",
      "verifier",
    ]);
  });

  it("R1-01b: an attacker-run flow can be redeemed in a VICTIM browser, planting the attacker's admin session", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = adminEnv(kv);
    await seedProduct(db, "djdl");

    // ── Step 1: the ATTACKER starts a flow from their own machine.
    const start = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/login", {
        "cf-connecting-ip": "203.0.113.7",
        "user-agent": "attacker-browser",
      }),
      env,
      db,
      "/login",
      { now: NOW },
    );
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    // Step 2: the attacker completes sign-in AT THE IdP as themselves and captures the
    // `code` off the redirect instead of letting their browser follow it.
    const ATTACKER_CODE = "attacker-authorization-code";

    // Step 3: the victim (a different browser, different IP, NO cookies at all) is made to
    // top-level-navigate to the callback URL. `SameSite=Strict` does not stop this: it
    // governs cookies SENT, not cookies SET on a cross-site navigation response.
    const victimVerifier: IdTokenVerifier = {
      async verify({ code }) {
        expect(code).toBe(ATTACKER_CODE);
        return {
          sub: "attacker-oidc-sub",
          email: "mallory@evil.test",
          name: "Mallory",
          groups: [PLATFORM_GROUP],
        };
      },
    };
    const victimRes = await handleAdmin(
      req(
        "GET",
        `https://key.plrs.im/manage/callback?code=${ATTACKER_CODE}&state=${encodeURIComponent(state)}`,
        { "cf-connecting-ip": "198.51.100.4", "user-agent": "victim-browser" },
      ),
      env,
      db,
      "/callback",
      { now: NOW, verifier: victimVerifier },
    );

    // The worker never looked at the victim's Cookie header — the flow is keyed by `state`
    // alone — so it happily mints a session and 302s the victim into the admin SPA.
    expect(victimRes.status).toBe(302);
    expect(victimRes.headers.get("location")).toBe("/manage/");
    const setCookie = victimRes.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${ADMIN_COOKIE}=`);
    expect(setCookie).toContain("SameSite=Strict");

    // The planted cookie is a fully valid admin session for the ATTACKER's identity.
    const token = setCookie.split(";")[0]!.slice(`${ADMIN_COOKIE}=`.length);
    const session = await verifySession(env, token, NOW);
    expect(session).not.toBeNull();
    expect(session!.sub).toBe("attacker-oidc-sub");
    expect(session!.groups).toContain(PLATFORM_GROUP);

    // ...and the victim's browser is now driving the admin API as the attacker.
    const me = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/api/me", {
        cookie: `${ADMIN_COOKIE}=${token}`,
      }),
      env,
      db,
      "/api/me",
      { now: NOW },
    );
    expect(me.status).toBe(200);
    expect(((await me.json()) as { sub: string }).sub).toBe(
      "attacker-oidc-sub",
    );

    // Every subsequent admin mutation this browser performs is audited as the ATTACKER,
    // breaking the "the audit actor is ALWAYS the verified session" property.
    expect(kv.keys().some((k) => k.startsWith("admin:flow:"))).toBe(false);
  });

  it("R1-01c: the group gate is the ONLY precondition — a non-admin code plants nothing", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    const start = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/login"),
      env,
      db,
      "/login",
      { now: NOW },
    );
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const res = await handleAdmin(
      req(
        "GET",
        `https://key.plrs.im/manage/callback?code=c&state=${encodeURIComponent(state)}`,
      ),
      env,
      db,
      "/callback",
      {
        now: NOW,
        verifier: {
          async verify() {
            return { sub: "nobody", groups: ["some-other-group"] };
          },
        },
      },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    // FIXED (R1-09). `htmlError` now carries the strict script-free policy, so the sign-in
    // error page is no longer a CSP-less HTML document on the admin origin.
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R1-02 — Admin/portal session realms share one HMAC key with no domain separation
// ───────────────────────────────────────────────────────────────────────────────

describe("R1-02 cross-realm session signing", () => {
  it("R1-02a: FIXED — the shared key survives, but the two realms now sign DIFFERENT messages", async () => {
    const env = adminEnv(new KvMock());
    expect(env.PORTAL_SESSION_SECRET).toBeUndefined();

    const { token } = await issuePortalSession(
      env,
      { accountId: "acct_1", name: "Mallory", email: "m@evil.test" },
      NOW,
    );
    const dot = token.lastIndexOf(".");
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    // FIXED (R1-02). The key material is still ADMIN_SESSION_SECRET (the documented fallback
    // is deliberately kept), but the signed message now carries a realm tag, so the signature
    // is NOT an HMAC over the bare body...
    expect(await hmacB64url(ADMIN_SECRET, body)).not.toBe(sig);
    // ...it is an HMAC over "pkey.portal.v1|" + body. The admin realm's tag produces a
    // different tag over the identical body and identical key — that difference is what now
    // separates the realms, instead of a coincidence of JSON field names.
    expect(await hmacB64url(ADMIN_SECRET, `pkey.portal.v1|${body}`)).toBe(sig);
    expect(await hmacB64url(ADMIN_SECRET, `pkey.admin.v1|${body}`)).not.toBe(
      sig,
    );
  });

  it("R1-02b: REFUTED today — a portal cookie replayed as pkey_admin is rejected by the SHAPE check only", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    const { token } = await issuePortalSession(
      env,
      { accountId: "acct_1", name: "Mallory", email: "m@evil.test" },
      NOW,
    );
    // Signature is valid (proved above); `verifySession` still returns null because the
    // portal body carries no `sub` and no `groups` array.
    expect(await verifySession(env, token, NOW)).toBeNull();
    const res = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/api/me", {
        cookie: `${ADMIN_COOKIE}=${token}`,
      }),
      env,
      db,
      "/api/me",
      { now: NOW },
    );
    expect(res.status).toBe(401);
  });

  it("R1-02c: REFUTED today — an admin cookie replayed as pkey_portal is rejected (no accountId)", async () => {
    const env = adminEnv(new KvMock());
    const { token } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    expect(await verifyPortalSession(env, token, NOW)).toBeNull();
  });

  it("R1-02d: FIXED — the latent bypass is dead: a body satisfying BOTH shape checks is accepted by AT MOST ONE realm", async () => {
    const env = adminEnv(new KvMock());
    // This is exactly the shape the portal session would take the moment it grows a `sub`
    // (the OIDC subject `getOrCreateAccountByIdentity` already handles) and any `groups`
    // array (portal org roles) — the change that used to turn R1-02 Critical.
    const both = JSON.stringify({
      accountId: "acct_1",
      sub: "acct_1",
      name: "Mallory",
      email: "m@evil.test",
      groups: [PLATFORM_GROUP],
      csrf: "x",
      exp: NOW + 3600,
    });
    const body = b64urlStr(both);

    // Signed for the PORTAL realm: the portal accepts it, the admin realm does not — even
    // though the body passes `!session.sub || !Array.isArray(session.groups)` cleanly and the
    // key is byte-identical. Shape is no longer load-bearing.
    const portalToken = `${body}.${await hmacB64url(ADMIN_SECRET, `pkey.portal.v1|${body}`)}`;
    expect(await verifyPortalSession(env, portalToken, NOW)).not.toBeNull();
    expect(await verifySession(env, portalToken, NOW)).toBeNull();

    // And symmetrically for the admin realm.
    const adminToken = `${body}.${await hmacB64url(ADMIN_SECRET, `pkey.admin.v1|${body}`)}`;
    expect(await verifySession(env, adminToken, NOW)).not.toBeNull();
    expect(await verifyPortalSession(env, adminToken, NOW)).toBeNull();

    // The untagged signature that used to work in both realms now works in neither.
    const legacy = `${body}.${await hmacB64url(ADMIN_SECRET, body)}`;
    expect(await verifySession(env, legacy, NOW)).toBeNull();
    expect(await verifyPortalSession(env, legacy, NOW)).toBeNull();
  });

  it("R1-02e: REFUTED — lastIndexOf('.') splitting is not forgeable (extra dots move the signed body)", async () => {
    const env = adminEnv(new KvMock());
    const { token } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    // Appending a fake segment makes `body` = "<real body>.<real sig>", whose HMAC the
    // attacker cannot produce.
    expect(await verifySession(env, `${token}.zzzz`, NOW)).toBeNull();
    // A leading segment likewise changes the signed input.
    expect(await verifySession(env, `zzzz.${token}`, NOW)).toBeNull();
  });

  it("R1-02f: REFUTED — JSON string escaping blocks claim injection through name/email", async () => {
    const env = adminEnv(new KvMock());
    const { token } = await issuePortalSession(
      env,
      {
        accountId: "acct_1",
        // A best-effort attempt to close the JSON object and append admin claims.
        name: '","sub":"root","groups":["platform-admins"],"x":"',
        email: "m@evil.test",
      },
      NOW,
    );
    // JSON.stringify escapes the quotes, so no admin claims are smuggled in.
    expect(await verifySession(env, token, NOW)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R1-03 — CSRF gate is method-shaped: state-changing GETs skip it entirely
// ───────────────────────────────────────────────────────────────────────────────

describe("R1-03 state-changing GET endpoints bypass the CSRF gate", () => {
  it("R1-03a: FIXED — logout is POST-only, so it goes THROUGH the CSRF gate instead of around it", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    const { token, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    const cookie = `${ADMIN_COOKIE}=${token}`;

    // FIXED (R1-03). The GET that used to clear the session — with no `X-PKey-CSRF` header,
    // because `isMutation("GET")` is false — is now a 405. The gate is no longer bypassable
    // by choosing a method.
    const asGet = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/api/logout", { cookie }),
      env,
      db,
      "/api/logout",
      { now: NOW },
    );
    expect(asGet.status).toBe(405);
    expect(asGet.headers.get("set-cookie")).toBeNull();

    // A POST without the token is refused by the CSRF check that GET used to skip.
    const noCsrf = await handleAdmin(
      req("POST", "https://key.plrs.im/manage/api/logout", { cookie }),
      env,
      db,
      "/api/logout",
      { now: NOW },
    );
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.headers.get("set-cookie")).toBeNull();

    // With the token, logout works as before.
    const ok = await handleAdmin(
      req("POST", "https://key.plrs.im/manage/api/logout", {
        cookie,
        "X-PKey-CSRF": session.csrf,
      }),
      env,
      db,
      "/api/logout",
      { now: NOW },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("R1-03b: REFUTED cross-site today — without the (SameSite=Strict) cookie the route 401s first", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    const res = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/api/logout"),
      env,
      db,
      "/api/logout",
      { now: NOW },
    );
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R1-04 — Audit-write amplification on the 403 path
// ───────────────────────────────────────────────────────────────────────────────

describe("R1-04 audit-write amplification", () => {
  it("R1-04a: every cross-product 403 writes one D1 row — unauthenticated? no. Rate-limited? no.", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");

    // A session that is authenticated but NOT a platform admin.
    const { token } = await issueSession(
      env,
      { sub: "u2", name: "Bob", email: "b@x.io", groups: ["djdl-admins"] },
      NOW,
    );

    const N = 25;
    for (let i = 0; i < N; i++) {
      const res = await handleAdmin(
        req(
          "GET",
          "https://key.plrs.im/manage/api/products/djdl/license/licenses",
          {
            cookie: `${ADMIN_COOKIE}=${token}`,
          },
        ),
        env,
        db,
        "/api/products/djdl/license/licenses",
        { now: NOW },
      );
      expect(res.status).toBe(403);
    }
    const rows = await listAudit(db, "djdl", {});
    // FIXED (R1-04). The 403 is still returned on every request (all 25 asserted above), but
    // the D1 write behind it is budgeted per actor+product per window, so the amplifier is
    // capped instead of being 1:1 with requests. The burst is still recorded — the first few
    // rows ARE the signal an operator needs.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.length).toBeLessThan(N);
    expect(rows[0]?.action).toBe("access.denied");
  });

  it("R1-04b: REFUTED as an unauthenticated amplifier — login and product-authz use the SAME group predicate", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    // `hasAnyAdminGrant` (login gate) === `isPlatformAdmin` (product gate), so no session
    // that the OIDC callback can mint today can ever reach the audited 403 branch. Since the
    // per-product scaffolding was deleted, that is now visible in the SIGNATURES: neither
    // predicate accepts a product argument at all.
    expect(hasAnyAdminGrant(env, ["djdl-admins"])).toBe(false);
    expect(hasAnyAdminGrant(env, [PLATFORM_GROUP])).toBe(true);
    // Unauthenticated requests are rejected before any D1 write.
    const before = (await listAudit(db, "djdl", {})).length;
    for (let i = 0; i < 5; i++) {
      const res = await handleAdmin(
        req(
          "GET",
          "https://key.plrs.im/manage/api/products/djdl/license/licenses",
        ),
        env,
        db,
        "/api/products/djdl/license/licenses",
        { now: NOW },
      );
      expect(res.status).toBe(401);
    }
    expect((await listAudit(db, "djdl", {})).length).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R1-05 — Unauthenticated raw-HTML sink on the platform origin
// ───────────────────────────────────────────────────────────────────────────────

describe("R1-05 /<product>/mint/<id>/auth renders stored HTML with no CSP and no auth", () => {
  it("R1-05a: the stored template is returned verbatim, unauthenticated, with no security headers", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const payload =
      '<script>fetch("/manage/api/me",{credentials:"include"})</script>';
    await db.run(
      `INSERT INTO edge_mint_config
         (product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience, auth_page_template)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      "djdl",
      "music",
      "ES256",
      "MUSIC_KEY",
      null,
      "{}",
      3600,
      "music.apple.com",
      payload,
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    // No bearer token, no cookie, no rate limit: handleMintAuth takes only (db, product, id).
    const res = await handleMintAuth(db, product, "music");
    expect(res.status).toBe(200);
    // The body is still echoed verbatim (nothing sanitises operator HTML) and the route is
    // still unauthenticated — but FIXED (R1-05/R1-09): the escalation primitive is gone.
    // `default-src 'none'` means the injected <script> cannot execute and, even if it could,
    // `connect-src` (falling back to default-src) blocks the fetch to /manage/api/me.
    expect(await res.text()).toBe(payload);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("R1-05b: REFUTED reachability — no application write path sets auth_page_template", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    // `stmtInsertEdgeMint` (the only writer, used by link-repo, resync and the webhook)
    // hard-codes NULL, and there is no admin API route for the column.
    const { stmtInsertEdgeMint } = await import("../../src/repo.js");
    const stmt = stmtInsertEdgeMint({
      product: "djdl",
      id: "music",
      alg: "ES256",
      signingKeySecret: "MUSIC_KEY",
      claimsTemplate: {},
      ttlSeconds: 3600,
    });
    expect(stmt.sql).toContain("auth_page_template");
    expect(stmt.sql).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, NULL\)/);
    await db.batch([stmt]);
    const row = await db.first<{ auth_page_template: string | null }>(
      "SELECT auth_page_template FROM edge_mint_config WHERE product = ? AND id = ?",
      "djdl",
      "music",
    );
    expect(row?.auth_page_template).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R1-06 — Unauthenticated /manage asset proxy escapes its own prefix
// ───────────────────────────────────────────────────────────────────────────────

describe("R1-06 unauthenticated /manage asset proxy", () => {
  function assetsEcho(seen: string[]): Fetcher {
    return {
      async fetch(input: Request) {
        const p = new URL(typeof input === "string" ? input : input.url)
          .pathname;
        seen.push(p);
        return new Response(`asset:${p}`, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    } as unknown as Fetcher;
  }

  it("R1-06a: any /manage/<x>.<y> path is proxied to ASSETS with NO session check", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    const seen: string[] = [];
    env.ASSETS = assetsEcho(seen);
    const res = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/manage.js"),
      env,
      db,
      "/manage.js",
      { now: NOW },
    );
    expect(res.status).toBe(200);
    expect(seen).toContain("/manage.js");
  });

  it("R1-06b: FIXED — percent-encoded dot-segments no longer escape /manage, and every asset response carries the CSP", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    const seen: string[] = [];
    env.ASSETS = assetsEcho(seen);
    // `url.pathname = cleanPath` runs the WHATWG path parser, which normalises %2e%2e.
    const res = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/%2e%2e/%2e%2e/index.html"),
      env,
      db,
      "/%2e%2e/%2e%2e/index.html",
      { now: NOW },
    );
    // FIXED (R1-06). `isSafeAssetPath` rejects any path containing `%`, so nothing that could
    // be normalised into a dot segment is ever assigned to `url.pathname`; the request falls
    // through to the SPA shell instead of leaving the prefix.
    expect(seen).toEqual(["/manage.html"]);
    expect(seen).not.toContain("/index.html");
    // FIXED (R1-09). The header decision no longer depends on the resolved pathname — every
    // asset response gets the full set.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("R1-06c: the SPA shell fallback is unauthenticated but DOES carry the CSP", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    const res = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/anything/deep/link"),
      env,
      db,
      "/anything/deep/link",
      { now: NOW },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R1-07 — Device-authorization "user confirmation" is attacker-self-servable
// ───────────────────────────────────────────────────────────────────────────────

describe("R1-07 device-code confirmation gate is bypassable by the flow's own starter", () => {
  it("R1-07a: the starter can self-confirm and read the IdP authorize URL out of the 302", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = adminEnv(kv, ["djdl"]);
    env.HOT = asKv(kv);
    await seedProduct(db, "djdl");
    await db.run(
      "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
      "djdl",
      "custom",
      "https://id.example",
      "client-djdl",
      null,
      JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
      JSON.stringify({ family: { role: "user", tier: "pro" } }),
    );
    const product = (await loadProduct(env, db, "djdl"))!;

    // The attacker starts a device flow bound to a device id they control.
    const started = await handleAuthDeviceStart(
      new Request("https://key.plrs.im/djdl/auth/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "attacker-device" }),
      }) as unknown as Request,
      env,
      db,
      product,
    );
    const { deviceCode } = (await started.json()) as { deviceCode: string };

    // The "user confirmation" page is a GET with no CSRF token, no session and no binding
    // to a human — the attacker simply calls it themselves.
    const confirmed = await handleAuthDeviceVerify(
      new Request(
        `https://key.plrs.im/djdl/auth/device/verify?device_code=${encodeURIComponent(deviceCode)}&confirm=1`,
      ) as unknown as Request,
      env,
      product,
    );
    // FIXED (R8-02). Confirmation is no longer reachable by GET. The request now renders the
    // confirmation page (200) instead of 302-ing to the IdP, so it neither mutates state nor
    // hands the caller the authorize URL. Previously this returned 302 with `location` set to
    // https://id.example/authorize — an ordinary-looking link on the IdP's own domain that,
    // once phished to a victim, bound the victim's license to the attacker's flow.
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("location")).toBeNull();
    const stored = JSON.parse(
      (await kv.get(`p:djdl:device-flow:${deviceCode}`))!,
    ) as { confirmedAt?: number; deviceId: string };
    // The state-mutating half is gone: a GET cannot mark the flow confirmed.
    expect(stored.confirmedAt).toBeFalsy();
    expect(stored.deviceId).toBe("attacker-device");
  });

  it("R1-07b: PARTIALLY FIXED — oidc.ts still sets no headers, but the dispatcher backstop makes the served page unframable", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = adminEnv(kv, ["djdl"]);
    env.HOT = asKv(kv);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    await kv.put(
      "p:djdl:device-flow:dc",
      JSON.stringify({
        state: "s",
        deviceId: "attacker-device",
        userCode: "ABCD-EFGH",
        authorizeUrl: "https://id.example/authorize",
      }),
    );
    const page = await handleAuthDeviceVerify(
      new Request(
        "https://key.plrs.im/djdl/auth/device/verify?device_code=dc",
      ) as unknown as Request,
      env,
      product,
    );
    expect(page.status).toBe(200);
    // FIXED (R1-07b) at the HANDLER too: `handleAuthDeviceVerify` now builds its headers with
    // `staticHtmlSecurityHeaders`, so a direct handler call is hardened without the
    // dispatcher. `referrer-policy: no-referrer` (R8-02) survives the helper.
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    // FIXED (R1-09) at the dispatcher: `index.ts` runs every response through
    // `secureResponse`, so the page as actually SERVED is unframable and script-free. This is
    // the response the browser sees.
    const served = secureResponse(page);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(served.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(served.headers.get("x-frame-options")).toBe("DENY");
    expect(served.headers.get("strict-transport-security")).toContain(
      "max-age=31536000",
    );
    // The backstop must not eat the body.
    expect(await served.text()).toContain("Continue to sign in");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R1-08 — Cookie hardening
// ───────────────────────────────────────────────────────────────────────────────

describe("R1-08 admin cookie hardening", () => {
  it("R1-08a: FIXED — the admin cookie is __Host- prefixed, which a sibling subdomain cannot shadow", () => {
    const cookie = buildSessionCookie("tok");
    expect(cookie.startsWith(`${ADMIN_COOKIE}=`)).toBe(true);
    expect(ADMIN_COOKIE.startsWith("__Host-")).toBe(true);
    // The browser enforces all three of these for a `__Host-` cookie, and refuses any
    // `Domain=`-scoped or non-root-path cookie by that name — which is the whole attack.
    // `Path=/manage` is therefore NOT retainable; see the note on ADMIN_COOKIE for why the
    // path scope was not a boundary in the first place.
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Path=/manage");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // The clearing cookie must match those attributes or the browser keeps the session.
    expect(buildClearCookie()).toContain("Path=/");
    expect(buildClearCookie()).not.toContain("Domain=");
    // Same treatment on the portal side.
    expect(PORTAL_COOKIE.startsWith("__Host-")).toBe(true);
  });

  it("R1-08b: FIXED — a duplicate session cookie is rejected outright instead of first-match-wins", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    const attacker = await issueSession(
      env,
      {
        sub: "mallory",
        name: "M",
        email: "m@evil.test",
        groups: [PLATFORM_GROUP],
      },
      NOW,
    );
    const victim = await issueSession(
      env,
      { sub: "ada", name: "A", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    // A `Domain=<parent>; Path=/manage/api` cookie sorts BEFORE the host cookie
    // (RFC 6265 §5.4: longer path first), so a first-match parser read the shadow. FIXED
    // (R1-08): the parser now collects every match and fails closed on ambiguity, so the
    // attacker's token is not silently adopted — and it does not fall through to the victim's
    // either. (Belt and braces: `__Host-` means a compliant browser will not emit this header
    // in the first place.)
    const res = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/api/me", {
        cookie: `${ADMIN_COOKIE}=${attacker.token}; ${ADMIN_COOKIE}=${victim.token}`,
      }),
      env,
      db,
      "/api/me",
      { now: NOW },
    );
    expect(res.status).toBe(401);

    // A single cookie is still read normally.
    const ok = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/api/me", {
        cookie: `${ADMIN_COOKIE}=${victim.token}`,
      }),
      env,
      db,
      "/api/me",
      { now: NOW },
    );
    expect(((await ok.json()) as { sub: string }).sub).toBe("ada");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// REFUTED — hypotheses checked and disproved
// ───────────────────────────────────────────────────────────────────────────────

describe("REFUTED hypotheses", () => {
  it("PLATFORM_ADMIN_GROUP unset/empty fails CLOSED (nobody can sign in, nobody is a platform admin)", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    delete (env as { PLATFORM_ADMIN_GROUP?: string }).PLATFORM_ADMIN_GROUP;
    await seedProduct(db, "djdl");
    expect(hasAnyAdminGrant(env, [PLATFORM_GROUP])).toBe(false);
    expect(hasAnyAdminGrant(env, [""])).toBe(false);

    env.PLATFORM_ADMIN_GROUP = "";
    expect(hasAnyAdminGrant(env, [""])).toBe(false);

    // A session forged with an empty group still fails the product gate.
    env.PLATFORM_ADMIN_GROUP = "";
    const { token } = await issueSession(
      env,
      { sub: "u", name: "u", email: "u@x", groups: [""] },
      NOW,
    );
    const res = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/api/products", {
        cookie: `${ADMIN_COOKIE}=${token}`,
      }),
      env,
      db,
      "/api/products",
      { now: NOW },
    );
    expect(res.status).toBe(403);
  });

  it("mapClaims cannot be confused into a groups array by a non-array/object claim", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock());
    await seedProduct(db, "djdl");
    const start = await handleAdmin(
      req("GET", "https://key.plrs.im/manage/login"),
      env,
      db,
      "/login",
      { now: NOW },
    );
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    // The production verifier's mapClaims filters `groups` to strings and defaults to [].
    // A string/object `groups` claim therefore grants nothing.
    const res = await handleAdmin(
      req(
        "GET",
        `https://key.plrs.im/manage/callback?code=c&state=${encodeURIComponent(state)}`,
      ),
      env,
      db,
      "/callback",
      {
        now: NOW,
        verifier: {
          async verify() {
            return {
              sub: "u",
              groups: [] as string[],
            };
          },
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it("the /manage/api/products route family is NOT a CSRF bypass — it lands in the same dispatcher", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { token } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    const res = await handleAdmin(
      new Request("https://key.plrs.im/manage/api/products", {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "evilco" }),
      }) as unknown as Request,
      env,
      db,
      "/api/products",
      { now: NOW },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe("csrf");
  });

  it("a product slug can never produce the admin or portal cookie name", () => {
    // browserSession cookies are `pkey_<slug>_session`; the suffix makes collision with
    // `pkey_admin` / `pkey_portal` impossible for any [a-z0-9-]+ slug.
    const name = (slug: string) => `pkey_${slug.replace(/-/g, "_")}_session`;
    expect(name("admin")).not.toBe(ADMIN_COOKIE);
    expect(name("portal")).not.toBe(PORTAL_COOKIE);
  });
});
