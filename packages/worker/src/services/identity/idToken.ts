// ID-token verification constants, shared by ALL THREE OIDC callbacks — the product one
// (`./oidc.ts`), the portal one (`./portal/auth.ts`) and the admin one
// (`../../admin/auth.ts`) — so the verification surfaces cannot drift. Each of the two
// additions to this list was the same bug found twice: the portal callback shipped without the
// freshness options because they were module-local to oidc.ts (the audit's A3), and the admin
// callback hand-copied the alg array and dropped the freshness options with it (A3-05) — on the
// one realm whose session carries full platform authority. A constant that only two of three
// consumers import is a constant that has already failed at its job.

/** The signature algorithms an IdP may use on an ID token. */
export const ALLOWED_ID_TOKEN_ALGS = ["RS256", "ES256", "EdDSA"];

/** Freshness ceiling on the ID token's `iat`. `exp` alone is entirely the IdP's choice, so a
 *  token minted long before this exchange must not be replayable into a sign-in (R8-05d). */
export const ID_TOKEN_MAX_AGE = "5m";
export const ID_TOKEN_CLOCK_TOLERANCE = 300;
