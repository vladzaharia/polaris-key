/// <reference types="@cloudflare/workers-types" />
// The mocked identity provider the device-code transcripts sign in through (P1b-08).
//
// The Worker's `/identity/auth/callback` talks to an IdP twice: it POSTs the authorization code
// to `<issuer>/api/oidc/token` (plain `fetch`), and it verifies the returned ID token against
// `<issuer>/.well-known/jwks.json` through jose's `createRemoteJWKSet`, which does NOT go through
// `globalThis.fetch`. `transcripts.test.ts` therefore swaps only jose's JWKS getter for
// `idpKeyResolver` below — exactly as `oidcEdge.test.ts` does — while the REAL `jwtVerify` still
// checks issuer, audience, signature, freshness and nonce, and `answerTokenExchange` stands in
// for the token endpoint while one callback runs.
//
// This module must not import `jose` itself: it is loaded from inside the `vi.mock("jose")`
// factory. It signs with `@polaris-key/jws` (EdDSA, one of `ALLOWED_ID_TOKEN_ALGS`), so an ID
// token is deterministic too, and the key is derived from a fixed seed — nothing here varies
// between two recordings, and none of it appears in a transcript.

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { signJws } from "@polaris-key/jws";
import { vi } from "vitest";

export const IDP_ISSUER = "https://id.example";
export const IDP_CLIENT_ID = "client-transcripts";
const IDP_KID = "transcript-idp";

/** A fixed Ed25519 key in PKCS#8 PEM: the RFC 8410 prefix plus a 32-byte seed. */
export function ed25519Pem(seedLabel: string): string {
  const seed = createHash("sha256").update(seedLabel).digest();
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const body = der.toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

const IDP_PEM = ed25519Pem("pkey-transcripts:idp");

let publicKey: Promise<CryptoKey> | null = null;

/** What the mocked `createRemoteJWKSet` resolves to: the IdP's public key. */
export function idpKeyResolver(): Promise<CryptoKey> {
  publicKey ??= crypto.subtle.importKey(
    "jwk",
    createPublicKey(createPrivateKey(IDP_PEM)).export({
      format: "jwk",
    }) as JsonWebKey,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return publicKey;
}

/** An ID token for `claims`, as the IdP would issue it at `now` for this flow's `nonce`. */
export function signIdToken(
  claims: Record<string, unknown>,
  nonce: string,
  now: number,
): Promise<string> {
  return signJws(
    {
      iss: IDP_ISSUER,
      aud: IDP_CLIENT_ID,
      iat: now,
      exp: now + 300,
      nonce,
      ...claims,
    },
    IDP_PEM,
    IDP_KID,
  );
}

/** Answer the Worker's token exchange with `idToken` while `body` runs, then restore `fetch`.
 *  Any other outbound request is a scenario bug and fails loudly. */
export async function answerTokenExchange<T>(
  idToken: string,
  body: () => Promise<T>,
): Promise<T> {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === `${IDP_ISSUER}/api/oidc/token`)
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      throw new Error(`transcript IdP: unexpected fetch ${url}`);
    });
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}
