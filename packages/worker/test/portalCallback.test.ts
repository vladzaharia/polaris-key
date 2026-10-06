// The portal OIDC callback's ID-token verification, driven end-to-end against a mock IdP
// (the audit's A3). R8-05d's freshness ceiling must hold here exactly as it does on the
// product OIDC callback: `exp` is entirely the IdP's choice, so a token minted long before
// this exchange must not be replayable into a portal sign-in.
//
// Two transports are stubbed, nothing else: the code-exchange POST goes through global
// fetch, and jose's remote JWKS retrieval — which uses node:https in the Node build, out of
// any fetch stub's reach — is narrowed to `createLocalJWKSet` over the mock IdP's key.
// Signature checks, claim validation, and the freshness options under test all run real.
// jose reads the REAL system clock, so the token's `iat`/`exp` are built from `Date.now()`
// while the handler's `now` parameter (session stamping only) stays the seed constant.

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { makeTestDb } from "./helpers.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import {
  handlePortalCallback,
  portalFlowKey,
} from "../src/services/identity/portal/auth.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { artefacts } from "./singleUseMock.js";
import { hashKey } from "../src/crypto.js";
import {
  PORTAL_SSO_COOKIE,
  clearAccountRealmCookie,
} from "../src/core/accountCookies.js";

const idp = vi.hoisted(() => ({ jwks: { keys: [] as unknown[] } }));

vi.mock("jose", async (importOriginal) => {
  const real = await importOriginal<typeof import("jose")>();
  return {
    ...real,
    createRemoteJWKSet: () => real.createLocalJWKSet(idp.jwks as never),
  };
});

const ISSUER = "https://id.test";
const CLIENT_ID = "portal-client";
const STATE = "state-1";
/** The browser binding `/login` would have set (I-17); the callback requires it. */
const BINDING = "binding-of-this-browser-0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
});

function idClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const real = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "user-1",
    email: "ada@example.com",
    email_verified: true,
    nonce: "nonce-1",
    iat: real,
    exp: real + 3600,
    ...over,
  };
}

/** Run the callback against a mock IdP that signs `claims` into the exchanged ID token. */
async function callbackWith(
  claims: Record<string, unknown>,
  db: SqliteDb = makeTestDb(),
  /** The browser's `__Host-pkey_sso` value; `null` sends none. Default: the flow's own. */
  binding: string | null = BINDING,
  fetched: string[] = [],
): Promise<Response> {
  await seedProduct(db, "djdl");
  const kv = new KvMock();
  const env = makeEnv(kv, ["djdl"]);
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = CLIENT_ID;
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";

  await artefacts(env).put(
    await portalFlowKey(env, STATE),
    JSON.stringify({
      verifier: "v".repeat(43),
      nonce: "nonce-1",
      redirectUri: "https://key.plrs.im/portal/auth/callback",
      bindingHash: await hashKey(BINDING, env.KEY_HASH_PEPPER),
    }),
  );

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  idp.jwks = {
    keys: [
      {
        ...(await exportJWK(publicKey)),
        alg: "ES256",
        kid: "idp-1",
        use: "sig",
      },
    ],
  };
  const idToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "idp-1" })
    .sign(privateKey);

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    fetched.push(u.toString());
    if (u.origin === ISSUER && u.pathname === "/api/oidc/token")
      return new Response(JSON.stringify({ id_token: idToken }), {
        headers: { "content-type": "application/json" },
      });
    return new Response("not found", { status: 404 });
  });

  return handlePortalCallback(
    new Request(
      `https://key.plrs.im/portal/auth/callback?code=abc&state=${STATE}`,
      {
        headers: binding ? { cookie: `${PORTAL_SSO_COOKIE}=${binding}` } : {},
      },
    ),
    env,
    db,
    NOW,
  );
}

describe("portal OIDC callback ID-token hardening (R8-05d)", () => {
  it("control: a fresh, nonce-bound token signs in", async () => {
    const res = await callbackWith(idClaims());
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("pkey_portal");
  });

  it("refuses a stale token — old iat, still-valid exp", async () => {
    const real = Math.floor(Date.now() / 1000);
    const res = await callbackWith(
      idClaims({ iat: real - 3600, exp: real + 3600 }),
    );
    expect(res.status).toBe(401);
  });

  it("refuses a token missing the flow's nonce binding", async () => {
    const res = await callbackWith(idClaims({ nonce: undefined }));
    expect(res.status).toBe(401);
  });
});

describe("the callback is bound to the browser that started it (I-17)", () => {
  it("another browser, or none, is refused before the code is exchanged, and nothing is written", async () => {
    for (const binding of [null, "someone-elses-binding-0123456789abcdef"]) {
      const db = makeTestDb();
      const fetched: string[] = [];
      const res = await callbackWith(idClaims(), db, binding, fetched);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(fetched).toEqual([]);
      expect(await db.all("SELECT id FROM accounts")).toEqual([]);
    }
  });

  it("the starting browser signs in, and its binding is cleared", async () => {
    const res = await callbackWith(idClaims());
    expect(res.status).toBe(302);
    const cookies = (
      res.headers as unknown as { getSetCookie(): string[] }
    ).getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Host-pkey_portal="))).toBe(true);
    expect(cookies).toContain(clearAccountRealmCookie(PORTAL_SSO_COOKIE));
  });
});

describe("portal identities are keyed by issuer (I-01, S-16 G14)", () => {
  it("a first sign-in keys the identity by the configured platform issuer", async () => {
    const db = makeTestDb();
    const res = await callbackWith(idClaims(), db);
    expect(res.status).toBe(302);
    // I-05: the sign-in method is an `account_links` row keyed by (issuer, tenant scope, subject).
    const rows = await db.all<{ issuer_key: string; subject: string }>(
      "SELECT issuer_key, subject FROM account_links WHERE kind = 'oidc'",
    );
    expect(rows).toEqual([{ issuer_key: ISSUER, subject: "user-1" }]);
  });

  it("re-keys a pre-I-01 'oidc' link and signs into the same account", async () => {
    const db = makeTestDb();
    const legacy = await getOrCreateAccountByEmail(
      db,
      "legacy@example.com",
      NOW,
    );
    // A link the 0068 backfill copied verbatim from a pre-0059 portal identity row.
    await db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
         created_at, last_used_at)
       VALUES ('lnk_legacy', ?, 'oidc', '', 'user-1', 'oidc', ?, ?)`,
      legacy.id,
      NOW,
      NOW,
    );

    // email_verified: false, so the account can only be found through the link.
    const res = await callbackWith(idClaims({ email_verified: false }), db);
    expect(res.status).toBe(302);
    const rows = await db.all<{ issuer_key: string; account_id: string }>(
      "SELECT issuer_key, account_id FROM account_links WHERE kind = 'oidc'",
    );
    expect(rows).toEqual([{ issuer_key: ISSUER, account_id: legacy.id }]);
    const accounts = await db.all<{ id: string }>("SELECT id FROM accounts");
    expect(accounts).toEqual([{ id: legacy.id }]);
  });
});

describe("the portal callback ends in signIn (I-05)", () => {
  it("an unknown identity whose verified email another account uses is a join offer: nothing is attached or created", async () => {
    const db = makeTestDb();
    const existing = await getOrCreateAccountByEmail(
      db,
      "ada@example.com",
      NOW,
    );
    const res = await callbackWith(
      idClaims({ email: "ada@example.com", email_verified: true }),
      db,
    );
    expect(res.status).toBe(409);
    // No session: the only cookie is the spent single sign-on binding being cleared (I-17).
    expect(res.headers.get("set-cookie")).toBe(
      clearAccountRealmCookie(PORTAL_SSO_COOKIE),
    );
    expect(await db.all("SELECT id FROM accounts")).toEqual([
      { id: existing.id },
    ]);
    expect(
      await db.all("SELECT id FROM account_links WHERE kind = 'oidc'"),
    ).toEqual([]);
  });
});
