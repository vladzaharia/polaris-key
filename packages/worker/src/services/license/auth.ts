/**
 * `requireLicensedDevice` — the licence-side half of the device-token check.
 *
 * ── WHAT MOVED, AND WHY ─────────────────────────────────────────────────────────────────────
 *
 * Core's `validateDeviceToken` answers only "does this token name a live device row", because a
 * product may run Config with License disabled (D-08): its devices are registered and hold real
 * tokens but have no licence, and a Core that refused them could never serve
 * `GET /<p>/config/document`. The licence-usability half is applied by `requireLicensedDevice`,
 * in exactly the position the fused version applied it.
 *
 * The DEFINITION now lives in `core/authz.ts`. It had to: Identity's `GET /<p>/identity/session`
 * applies the same check, Release and Update apply it through `core/entitledAccess.ts`, and a
 * service may not import a sibling (`test/boundaries.test.ts`). This module keeps License's own
 * call sites — `/license/{token,deauthorize,document}` — pointed at one definition.
 *
 * `GET /<p>/config/document` takes Core's unqualified answer only for a product with License
 * off, which is the whole point (§2.2). For a licensed product it applies Core's
 * `licenseUsable` itself and answers `403 license_unusable` (R1), so a disabled or expired
 * licence stops receiving the document's secrets.
 */

export { requireLicensedDevice } from "../../core/authz.js";
export type { LicensedDeviceToken } from "../../core/devices.js";
