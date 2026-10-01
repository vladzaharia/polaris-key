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
  staticHtmlSecurityHeaders,
} from "../securityHeaders.js";
