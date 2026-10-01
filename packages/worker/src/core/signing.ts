/**
 * Document signing — the one place a Polaris Key document becomes a compact JWS under a product's
 * active signing key (design spec §5.1: "trust & signing (per-product Ed25519 keys …)" is core).
 *
 * The encoding is FROZEN: `@polaris-key/jws` is what the conformance corpus pins, and the per-product
 * `kid` + key are what scope a signed document to one tenant. Every service that mints a
 * document (license, config, and the offline bundle later) signs through here rather than
 * reaching for `signJws` itself, so there is exactly one call site to audit when the envelope
 * changes.
 *
 * `typ` is the wire-v3 domain separator (WIRE-CONTRACT-V3 §2). One product key signs the
 * license document, the config document and the trust manifest, so `typ` is the ONLY thing
 * standing between them: without it a config document could be replayed into a call site
 * expecting a license document and verify perfectly. Every call site here passes one — the
 * license and config documents, and all three artifacts `core/bundles.ts` mints — so the
 * optionality is inherited from `signJws`, not exercised: a signer that omits `typ` is a bug
 * rather than a compatibility choice. The one Polaris Key document with no `typ` is the FUSED
 * browser-session artifact (`services/identity/doc.ts`), and it never reaches this function:
 * `/identity/session` serves it as plain JSON to a page, unsigned, so there is nothing to
 * domain-separate. It gets a `typ` if and when it is ever signed.
 *
 * Key MATERIAL is loaded by `core/products.ts` (`loadProduct` opens the sealed `product_keys`
 * row under the KEK; `loadPublicSigningKey(s)` reads the public halves), and published by
 * `core/trust.ts`. This module never touches storage.
 *
 * ── THE SIGNER GUARDS (plans/P3-01.md §2.2, "Keeping the signer total") ─────────────────────
 *
 * Two guards make the Worker unable to sign what a wire-v4 verifier refuses. `signJws` throws
 * `StrictJsonError` on a header or payload that breaks V4 §1.2's strict-JSON rules, and this
 * function throws it first when an integer claim of a v3 `typ` is not a safe integer of at least
 * the claim's minimum (V4 §3, "Minimums": 0 for every timestamp, 1 for `schemaVersion`). Every
 * route that signs catches `StrictJsonError` and answers `500 document_not_representable` in its
 * own body shape (`isStrictJsonError`); none lets it escape as an unhandled throw.
 */

import { signJws, StrictJsonError, type JwsTyp } from "@polaris-key/jws";

export { StrictJsonError };

/**
 * The integer claims of each v3 `typ` with their minimums (WIRE-CONTRACT-V4 §3, the "Minimums"
 * table). The feed's claims are checked by P3-03's composer (`feedClaims`) before it calls this
 * function, and no Worker signs a release record.
 */
const INTEGER_CLAIMS: Partial<
  Record<JwsTyp, readonly (readonly [string, number])[]>
> = {
  "pkey-license+jws": [
    ["issuedAt", 0],
    ["expiresAt", 0],
    ["graceUntil", 0],
  ],
  "pkey-config+jws": [
    ["issuedAt", 0],
    ["expiresAt", 0],
    ["graceUntil", 0],
    ["schemaVersion", 1],
  ],
  "pkey-trust+jws": [
    ["schemaVersion", 1],
    ["issuedAt", 0],
    ["expiresAt", 0],
  ],
  "pkey-bundle+jws": [
    ["issuedAt", 0],
    ["expiresAt", 0],
  ],
};

/**
 * Throw `StrictJsonError` when an integer claim of a v3 `typ` is missing, is not a safe integer
 * (a fraction, `NaN`, beyond 2^53 − 1, or not a number at all), or is below its minimum.
 * `JSON.stringify` writes a safe integer as a plain integer token, so a claim that passes here
 * is one every v4 verifier reads as a wire integer.
 */
export function assertIntegerClaims(
  doc: unknown,
  typ: JwsTyp | undefined,
): void {
  const claims = typ === undefined ? undefined : INTEGER_CLAIMS[typ];
  if (!claims) return;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new StrictJsonError("payload", `a ${typ} document must be an object`);
  }
  for (const [name, min] of claims) {
    const value = (doc as Record<string, unknown>)[name];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min
    ) {
      throw new StrictJsonError(
        "payload",
        `${typ} claim ${name} must be a safe integer of at least ${min} (WIRE-CONTRACT-V4 §3)`,
      );
    }
  }
}

/** True for the guards' refusal, which a signing route answers as `500 document_not_representable`. */
export function isStrictJsonError(e: unknown): e is StrictJsonError {
  return e instanceof StrictJsonError;
}

/**
 * Log a guard refusal with the product and `typ` (plans/P3-01.md §2.2), never the document: the
 * value that tripped the guard may be a secret. The operator finds it with
 * `check:representable` or in the console.
 */
export function logNotRepresentable(
  product: string,
  typ: string,
  e: StrictJsonError,
): void {
  console.error(
    JSON.stringify({
      event: "document_not_representable",
      product,
      typ,
      part: e.part,
      message: e.message,
    }),
  );
}

export async function signDoc(
  doc: unknown,
  signingKeyPem: string,
  kid: string,
  typ?: JwsTyp,
): Promise<string> {
  assertIntegerClaims(doc, typ);
  return signJws(doc, signingKeyPem, kid, typ);
}
