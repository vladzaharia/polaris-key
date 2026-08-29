// ID-token verification constants, shared by the PRODUCT OIDC callback (`./oidc.ts`) and
// the PORTAL one (`./portal/auth.ts`) so the two verification surfaces cannot drift — the
// portal callback shipped without the freshness options once, exactly because they were
// module-local to oidc.ts (the audit's A3).

/** The signature algorithms an IdP may use on an ID token. */
export const ALLOWED_ID_TOKEN_ALGS = ["RS256", "ES256", "EdDSA"];

/** Freshness ceiling on the ID token's `iat`. `exp` alone is entirely the IdP's choice, so a
 *  token minted long before this exchange must not be replayable into a sign-in (R8-05d). */
export const ID_TOKEN_MAX_AGE = "5m";
export const ID_TOKEN_CLOCK_TOLERANCE = 300;
