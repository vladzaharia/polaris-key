/// <reference types="@cloudflare/workers-types" />
import type { Product } from "./product.js";

/** GET /<product>/.well-known/jwks.json — the product's Ed25519 public key(s), so SDKs
 *  can optionally discover keys (rotation). Clients still pin a trust set by default. */
export function handleJwks(product: Product): Response {
  const keys = product.signingPub
    ? [
        {
          kty: "OKP",
          crv: "Ed25519",
          use: "sig",
          alg: "EdDSA",
          kid: product.signingKid,
          x: product.signingPub,
        },
      ]
    : [];
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}
