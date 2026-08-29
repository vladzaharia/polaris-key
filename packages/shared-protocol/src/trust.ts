// @polaris-key/protocol/trust — trust-manifest wire types (wire contract v3 §1, §2.3).
// Semantics are carried unchanged from v2: manifests are verified against PINNED keys
// only; the discovered set is replaced wholesale; absence is revocation.

export type SigningKeyStatus = "staged" | "active" | "retired" | "revoked";

export interface TrustManifestKey {
  kid: string;
  alg: "EdDSA";
  kty: "OKP";
  crv: "Ed25519";
  publicKey: string;
  /** `revoked` entries are emitted for at least 2× `cacheSeconds` after revocation (§2.3) —
   *  a positive removal signal for clients that could still hold the key cached. Clients
   *  drop them on merge; absence remains revocation after the window. */
  status: SigningKeyStatus;
}

/** Signed by the currently trusted active product key and used by SDKs to refresh their
 *  verification key set without trusting unsigned JWKS data. */
export interface TrustManifestDoc {
  schemaVersion: 1;
  aud: string;
  iss: string;
  issuedAt: number;
  expiresAt: number;
  jwksUrl: string;
  cacheSeconds: number;
  keys: TrustManifestKey[];
}
