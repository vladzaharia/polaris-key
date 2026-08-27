/**
 * Trust distribution: the two public surfaces an SDK reads a product's Ed25519 key set from
 * (design spec §5.1 — "trust & signing" is a core capability, always on).
 *
 * Moved verbatim from `src/jwks.ts`. Signing itself — turning a document into a compact JWS
 * under the product's active key — is `core/signing.ts`; this module only PUBLISHES keys.
 */

/// <reference types="@cloudflare/workers-types" />
import type { Product } from "./products.js";
import type { Db } from "../db/types.js";
import { signJws } from "@plrs/jws";
import { ISSUER, type TrustManifestDoc } from "@plrs/protocol";
import { loadPublicSigningKeys } from "./products.js";

const TRUST_CACHE_SECONDS = 300;

/** GET /<product>/.well-known/jwks.json — the product's Ed25519 public key(s), so SDKs
 *  can optionally discover keys (rotation). Clients still pin a trust set by default. */
export async function handleJwks(db: Db, product: Product): Promise<Response> {
  const keyRows = await loadPublicSigningKeys(db, product.slug);
  const keys = keyRows.map((key) => ({
    kty: "OKP",
    crv: "Ed25519",
    use: "sig",
    alg: "EdDSA",
    kid: key.kid,
    x: key.publicKey,
  }));
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}

export async function handleTrustManifest(
  req: Request,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const base = `${url.origin}/${product.slug}`;
  const keyRows = await loadPublicSigningKeys(db, product.slug);
  const doc: TrustManifestDoc = {
    schemaVersion: 1,
    aud: product.slug,
    iss: ISSUER,
    issuedAt: now,
    expiresAt: now + TRUST_CACHE_SECONDS,
    jwksUrl: `${base}/.well-known/jwks.json`,
    cacheSeconds: TRUST_CACHE_SECONDS,
    keys: keyRows.map((key) => ({
      kid: key.kid,
      alg: "EdDSA",
      kty: "OKP",
      crv: "Ed25519",
      publicKey: key.publicKey,
      status:
        key.status === "active" || key.status === "staged"
          ? key.status
          : "retired",
    })),
  };
  return new Response(
    await signJws(doc, product.signingKeyPem, product.signingKid),
    {
      status: 200,
      headers: {
        "content-type": "application/jose",
        "cache-control": `public, max-age=${TRUST_CACHE_SECONDS}`,
      },
    },
  );
}
