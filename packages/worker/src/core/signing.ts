/**
 * Document signing — the one place a Polaris document becomes a compact JWS under a product's
 * active signing key (design spec §5.1: "trust & signing (per-product Ed25519 keys …)" is core).
 *
 * The encoding is FROZEN: `@plrs/jws` is what the conformance corpus pins, and the per-product
 * `kid` + key are what scope a signed document to one tenant. Every service that mints a
 * document (license, config, and the offline bundle later) signs through here rather than
 * reaching for `signJws` itself, so there is exactly one call site to audit when the envelope
 * changes.
 *
 * `typ` is the wire-v3 domain separator (WIRE-CONTRACT-V3 §2). One product key signs the
 * license document, the config document and the trust manifest, so `typ` is the ONLY thing
 * standing between them: without it a config document could be replayed into a call site
 * expecting a license document and verify perfectly. It remains optional in the SIGNATURE only
 * because the browser-session document still mints the fused v2 artifact until identity is
 * carved (P3); every v3 signer passes it, and one that omits it is a bug rather than a
 * compatibility choice.
 *
 * Key MATERIAL is loaded by `core/products.ts` (`loadProduct` opens the sealed `product_keys`
 * row under the KEK; `loadPublicSigningKey(s)` reads the public halves), and published by
 * `core/trust.ts`. This module never touches storage.
 */

import { signJws, type JwsTyp } from "@plrs/jws";

export async function signDoc(
  doc: unknown,
  signingKeyPem: string,
  kid: string,
  typ?: JwsTyp,
): Promise<string> {
  return signJws(doc, signingKeyPem, kid, typ);
}
