/**
 * The platform primitives Core lends to a service (design spec §5.1).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * `src/services/<slug>/` may import `core/`, its own directory, and declared packages — and
 * nothing else (`test/boundaries.test.ts`). That rule is what stops a "moved" service from
 * quietly keeping a wire back into the pre-suite layout, and it is worth keeping strict.
 *
 * But the substrate a service genuinely needs — the Worker bindings, the database handle, the
 * bearer-token reader, hashing and id minting, the hot token cache, the KEK-sealing vault, the
 * response-hygiene helpers — still physically lives in the top-level modules P1.T1 did not
 * relocate (`../env.js`, `../db/types.js`, `../http.js`, `../crypto.js`, `../kv.js`,
 * `../keyvault.js`, `../securityHeaders.js`, `../platformOidc.js`). Relocating those is a
 * mechanical change across ~90 import sites in code no service touches, and it is not what the
 * service carves are.
 *
 * So Core DECLARES the interface here and owns where the implementation sits. A service binds
 * to `core/platform.js`; the day the implementations physically move under `core/`, this file
 * changes and no service does. That is the same "cross-domain access goes through a
 * core-mediated interface" rule the layout is built on, applied to the platform layer.
 *
 * The byte, digest, comparison, randomness, PKCE, JSON-column, signed-cookie, HTML-escaping,
 * return-to and email primitives already live in their final home, `src/platform/` (P0-15): leaf
 * modules that import nothing else in `src/`. They are re-exported below so a service reaches
 * them through this one seam like everything else.
 *
 * Nothing new is defined here on purpose: adding behaviour to a re-export module is how a
 * façade turns into a second implementation.
 */

export type { Env } from "../env.js";
export { secret } from "../env.js";

export type { Db, DbParam, DbStatement } from "../db/types.js";

export {
  bearer,
  isAllowedStorageHost,
  isSafeAssetPath,
  isSameOriginNavigation,
} from "../http.js";

export { isAllowedDownloadRedirectHost } from "./bytesHostname.js";

export {
  hashKey,
  mintDeviceToken,
  mintLicenseKey,
  mintOpaqueToken,
  productFromKey,
  randomId,
} from "../crypto.js";

export {
  deleteTokenRecord,
  ghInstallationTokenKey,
  pk as kvKey,
} from "../kv.js";

/**
 * The platform's OWN identity provider — a Worker secret, not repo-supplied config.
 *
 * Identity reads it twice: a product whose `oidc_config.provider` is `platform` signs in against
 * it, and the root customer portal has no other issuer at all. It is a binding reader like every
 * other export here, which is why it arrives through the platform seam rather than through a
 * service.
 */
export {
  platformOidcConfig,
  type PlatformOidcConfig,
} from "../platformOidc.js";

export {
  generateEd25519,
  open,
  seal,
  type SealContext,
  type Sealed,
} from "../keyvault.js";

export {
  appSecurityHeaders,
  brandedHtmlSecurityHeaders,
  cspImageOrigin,
  staticHtmlSecurityHeaders,
} from "../securityHeaders.js";

/**
 * The platform primitives (P0-15): one implementation each of the byte encodings, digests,
 * constant-time compares, random tokens, PKCE, JSON-column readers, realm-tagged HMAC tokens,
 * HTML escaping, the sign-in `returnTo` check and the email matching key, so no service needs a
 * local copy; `test/platformPrimitives.test.ts` refuses one.
 */
export {
  b64urlDecode,
  b64urlDecodeBinary,
  b64urlDecodeBinaryUnpadded,
  b64urlDecodeStrict,
  b64urlDecodeUtf8,
  b64urlEncode,
  b64urlEncodeBinary,
  b64urlEncodeUtf8,
  base64Decode,
  base64DecodeEitherAlphabet,
  base64Encode,
  hexDecode,
  hexEncode,
  toArrayBuffer,
  utf8Encode,
} from "../platform/bytes.js";

export {
  hmacSha256,
  importHmacKey,
  sha256,
  sha256B64url,
  sha256Base64,
  sha256Hex,
  type DigestInput,
} from "../platform/hash.js";

export {
  constantTimeEqual,
  constantTimeEqualBytes,
} from "../platform/compare.js";

export {
  randomBytes,
  randomHex,
  randomToken,
  randomUint32,
} from "../platform/random.js";

export { pkceChallenge, pkcePair } from "../platform/pkce.js";

export {
  isJsonObject,
  parseJsonArray,
  parseJsonColumn,
  parseJsonObject,
  parseJsonOr,
  parseJsonStringList,
  toJsonColumn,
  tryParseJson,
} from "../platform/json.js";

export { signHmacToken, verifyHmacToken } from "../platform/hmacToken.js";

export {
  escapeHtml,
  escapeHtmlDecimalApostrophe,
  escapeHtmlKeepApostrophe,
} from "../platform/html.js";

export {
  CARD_RETURN_TO,
  PORTAL_SIGNIN_RETURN_TO,
  PRODUCT_SIGNIN_RETURN_TO,
  safeReturnTo,
  type ReturnToPolicy,
} from "../platform/returnTo.js";

export { normalizeEmail } from "../platform/email.js";
