// @plrs/protocol/trust — trust-manifest wire types (wire contract v3 §1, §2.3).
// Semantics are carried unchanged from v2: manifests are verified against PINNED keys
// only; the discovered set is replaced wholesale; absence is revocation.

export type SigningKeyStatus = "staged" | "active" | "retired" | "revoked";

export interface TrustManifestKey {
  kid: string;
  alg: "EdDSA";
  kty: "OKP";
  crv: "Ed25519";
  publicKey: string;
  status: Exclude<SigningKeyStatus, "revoked">;
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
