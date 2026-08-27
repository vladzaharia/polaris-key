/**
 * Document signing — the one place a Polaris document becomes a compact JWS under a product's
 * active signing key (design spec §5.1: "trust & signing (per-product Ed25519 keys …)" is core).
 *
 * The encoding is FROZEN: `@plrs/jws` is what the conformance corpus pins, and the per-product
 * `kid` + key are what scope a signed document to one tenant. Every service that mints a
 * document (license, config, and the offline bundle later) signs through here rather than
 * reaching for `signJws` itself, so there is exactly one call site to audit when the envelope
 * changes at wire v3.
 *
 * Only the SIGNING half of `src/configDoc.ts` moved. Document ASSEMBLY — `buildDoc`,
 * `validatePayload`, `computeETag` — is still config-document-shaped (it reads `ManagedConfigDoc`
 * fields by name) and stays in `configDoc.ts` until it lands in `services/config/document.ts`.
 *
 * Key MATERIAL is loaded by `core/products.ts` (`loadProduct` opens the sealed `product_keys`
 * row under the KEK; `loadPublicSigningKey(s)` reads the public halves), and published by
 * `core/trust.ts`. This module never touches storage.
 */

import { signJws } from "@plrs/jws";
import type { ManagedConfigDoc } from "@plrs/protocol";

export async function signDoc(
  doc: ManagedConfigDoc,
  signingKeyPem: string,
  kid: string,
): Promise<string> {
  return signJws(doc, signingKeyPem, kid);
}
