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
 * The ONLY surface that takes Core's unqualified answer is `GET /<p>/config/document`, which is
 * the whole point (§2.2).
 */

export { requireLicensedDevice } from "../../core/authz.js";
export type { LicensedDeviceToken } from "../../core/devices.js";
