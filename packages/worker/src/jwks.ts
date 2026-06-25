/// <reference types="@cloudflare/workers-types" />
import type { Product } from "./product.js";
import type { Db } from "./db/types.js";
import { loadPublicSigningKeys } from "./product.js";

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
