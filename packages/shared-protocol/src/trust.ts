// @polaris-key/protocol/trust — trust-manifest wire types (wire contract v3 §1, §2.3).
// Semantics are carried unchanged from v2: manifests are verified against PINNED keys
// only; the discovered set is replaced wholesale; absence is revocation.

export type SigningKeyStatus = "staged" | "active" | "retired" | "revoked";

/**
 * Which key CLASS an entry belongs to (§1.1). The `anchor` signs `pkey-trust+jws` and nothing
 * else and is what a host application PINS; `document` keys sign license/config/bundle documents
 * and rotate underneath the anchor, which is what makes rotation an operation rather than an
 * application release (B3-01).
 */
export type SigningKeyRole = "anchor" | "document";

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
  /**
   * ADVISORY (§1.1, §2.3). Optional: a manifest from a server that predates the anchor split
   * omits it, and that is not an error.
   *
   * **No verifier may read this in a verification decision.** Not to decide what may sign a
   * manifest, not to decide what may sign a document, not to prune. A manifest that could name
   * its own signer's authority would be introducing the key that verifies it — R2-01. What
   * actually constrains manifest signing is that clients pin the anchor and manifests verify
   * against pins only. This field exists so an operator or a provisioning tool can answer
   * "which of these do I pin?" from the artifact instead of out of band.
   */
  role?: SigningKeyRole;
}

/** Signed by the product's TRUST ANCHOR (§1.1) and used by SDKs to refresh their verification
 *  key set without trusting unsigned JWKS data. */
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
