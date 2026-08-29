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
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { handlePortalCallback } from "../src/services/identity/portal/auth.js";

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
): Promise<Response> {
  const db = makeTestDb();
  await seedProduct(db, "djdl");
  const kv = new KvMock();
  const env = makeEnv(kv, ["djdl"]);
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = CLIENT_ID;
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";

  await kv.put(
    `portal:oidc-flow:${STATE}`,
    JSON.stringify({
      verifier: "v".repeat(43),
      nonce: "nonce-1",
      redirectUri: "https://key.plrs.im/portal/auth/callback",
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
    if (u.origin === ISSUER && u.pathname === "/api/oidc/token")
      return new Response(JSON.stringify({ id_token: idToken }), {
        headers: { "content-type": "application/json" },
      });
    return new Response("not found", { status: 404 });
  });

  return handlePortalCallback(
    new Request(
      `https://key.plrs.im/portal/auth/callback?code=abc&state=${STATE}`,
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
