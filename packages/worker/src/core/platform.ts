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
 * bearer-token reader, hashing and id minting, the hot token cache, the response-hygiene
 * helpers — still physically lives in the top-level modules P1.T1 did not relocate
 * (`../env.js`, `../db/types.js`, `../http.js`, `../crypto.js`, `../kv.js`,
 * `../securityHeaders.js`). Relocating those is a mechanical change across ~90 import sites in
 * code no service touches, and it is not what Tasks 1.2–1.4 are.
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

export { bearer } from "../http.js";

export { hashKey, mintDeviceToken, randomId } from "../crypto.js";

export { deleteTokenRecord } from "../kv.js";

export { staticHtmlSecurityHeaders } from "../securityHeaders.js";
