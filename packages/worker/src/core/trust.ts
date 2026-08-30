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
import { signJws } from "@polaris-key/jws";
import type { TrustManifestDoc } from "@polaris-key/protocol";
// The issuer is `key.plrs.im` (Amendment A1 withdrew the host-neutral `plrs.im` spelling), and
// `@polaris-key/protocol/core` is where that constant lives — the barrel re-exports the SAME
// string, so this deep import is a provenance choice, not a different value. The trust manifest
// is the third artifact the client verifies alongside the two signed documents, and all three
// have to name one `iss` or an SDK that pins it cannot accept all three.
import { ISSUER } from "@polaris-key/protocol/core";
import { loadPublicSigningKeys } from "./products.js";
import { notFound } from "./errors.js";

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

/**
 * The product's current trust manifest, signed and ready to hand out.
 *
 * Extracted from `handleTrustManifest` because the manifest is no longer served only from its
 * own route: an offline bundle (`core/bundles.ts`, wire v3 §7) carries one INSIDE it so an
 * air-gapped device can build the effective key set with no network at all. Both callers must
 * emit the same artifact — a bundle whose inner manifest differed in shape from the served one
 * would verify on the mint side and be the only manifest a client ever sees that the served
 * corpus never covered.
 *
 * `origin` is the scheme+host the `jwksUrl` should point at; callers pass their own request's
 * origin so the manifest advertises the host it was fetched from.
 *
 * `null` when the product's sealed signing key cannot be opened (B5-12). Both callers turn that
 * into the 404 the whole product used to return when `loadProduct` did the unseal itself — an
 * unsigned or partially-signed manifest is never an option, because a manifest IS the key set a
 * client pins against.
 */
export async function signTrustManifest(
  db: Db,
  product: Product,
  now: number,
  origin: string,
): Promise<string | null> {
  // §2.3 — keys revoked within 2× the cache window are still LISTED, with status
  // "revoked": every client that could hold the key cached reads a positive removal
  // instead of inferring it from absence. Older revocations age out and absence takes
  // over, exactly as the merge semantics already handle.
  const keyRows = await loadPublicSigningKeys(
    db,
    product.slug,
    now - 2 * TRUST_CACHE_SECONDS,
  );
  const doc: TrustManifestDoc = {
    schemaVersion: 1,
    aud: product.slug,
    iss: ISSUER,
    issuedAt: now,
    expiresAt: now + TRUST_CACHE_SECONDS,
    jwksUrl: `${origin}/${product.slug}/.well-known/jwks.json`,
    cacheSeconds: TRUST_CACHE_SECONDS,
    keys: keyRows.map((key) => ({
      kid: key.kid,
      alg: "EdDSA",
      kty: "OKP",
      crv: "Ed25519",
      publicKey: key.publicKey,
      status:
        key.status === "active" ||
        key.status === "staged" ||
        key.status === "revoked"
          ? key.status
          : "retired",
      // §1.1 / §2.3 — ADVISORY. It answers "which of these do I pin?" for an operator or a
      // provisioning tool and is explicitly NOT an input to any verification decision: a
      // verifier that let this field decide which key may sign a manifest would be letting the
      // manifest introduce the key that verifies it, which is R2-01 through a new door. The
      // property is enforced structurally instead — only the anchor is pinned, and manifests
      // verify against pins only.
      role: key.role,
    })),
  };
  // §1.1 — the ANCHOR signs the manifest, never the rotating document key. This one line is
  // B3-01: signing with `product.signingKey()` meant the manifest signer moved on every
  // rotation, while clients verify a manifest against PINNED keys only, so every installed
  // client refused every manifest issued after the first rotation — and stopped learning about
  // revocations at exactly the moment revocation matters.
  const pem = await product.trustAnchorKey();
  if (!pem) return null;
  // `typ` is the domain separator, and wire v3 §2 makes it MANDATORY — an untyped manifest is
  // rejected outright now, so the v2 tolerance window (sign without a typ, verify without
  // requiring one) has to close on the signing side too or nothing verifies.
  return signJws(doc, pem, product.trustAnchorKid, "pkey-trust+jws");
}

export async function handleTrustManifest(
  req: Request,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const jws = await signTrustManifest(db, product, now, url.origin);
  // Fail closed, and closed means INVISIBLE: an unopenable signing key used to take the whole
  // product to 404 from `loadProduct`, and this route keeps that answer rather than inventing a
  // new one that would tell a stranger the product exists but its custody is broken.
  if (jws === null) return notFound();
  return new Response(jws, {
    status: 200,
    headers: {
      "content-type": "application/jose",
      "cache-control": `public, max-age=${TRUST_CACHE_SECONDS}`,
    },
  });
}
