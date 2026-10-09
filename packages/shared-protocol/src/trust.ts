// @polaris-key/protocol/trust — trust-manifest wire types (WIRE-CONTRACT-V4 §1, §2.3).
// Manifests are verified against the USABLE pins only (the pins minus the ones a verified
// manifest tombstoned); the discovered set is replaced wholesale; absence is revocation.

export type SigningKeyStatus = "staged" | "active" | "retired" | "revoked";

/** The statuses that keep a published key in the trust set (WIRE-CONTRACT-V4 §1). Exact,
 *  case-sensitive strings: `revoked` drops the key (and, for a pinned kid listed by another
 *  pin, tombstones it); any other value, a case variant, a non-string or an absent status
 *  skips the entry and is never fatal. */
export const TRUST_LIVE_STATUSES = ["active", "staged", "retired"] as const;

/** How long a revoked key stays LISTED, with `status: "revoked"`, in the served trust manifest
 *  (WIRE-CONTRACT-V4 §2.3): 400 days, the 365-day grace plus the 30-day bundle import window,
 *  so every client that could still hold the key, or a pin of it, reads a positive removal. */
export const REVOKED_KEY_LISTING_SECONDS = 34_560_000;

export interface TrustManifestKey {
  kid: string;
  alg: "EdDSA";
  kty: "OKP";
  crv: "Ed25519";
  publicKey: string;
  /** `revoked` entries are emitted for `REVOKED_KEY_LISTING_SECONDS` after revocation (§2.3):
   *  a positive removal signal for clients that could still hold the key. Clients drop them,
   *  and a pinned kid listed `revoked` by another pin is tombstoned (§1). */
  status: SigningKeyStatus;
}

/** Signed by a product key (the active one, or the one `?signer=<kid>` names, §2.3) and used
 *  by SDKs to refresh their verification key set without trusting unsigned JWKS data. */
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
