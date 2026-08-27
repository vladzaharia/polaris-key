/**
 * Compatibility re-export. The build gate now lives with the service that owns it:
 * `services/license/gate.ts`.
 *
 * D-20 makes channel/version enforcement a LICENSE concern — the window and the channel set
 * arrive as enforced entitlements on the license document, and `GET /<p>/license/document` is
 * where a blocked build is refused (WIRE-CONTRACT-V3 §5). The predicate itself is pure semver
 * and channel arithmetic, and three surfaces outside the license service still evaluate it:
 * identity's `/session` (which mints its own document), the portal's entitlement view, and the
 * legacy `licenseCore` merge. Those are pre-suite modules that move in P3; pointing them at
 * this file keeps them untouched by the carve.
 *
 * New code inside a service imports `services/license/gate.js` directly — a service may not
 * import this module at all (`test/boundaries.test.ts`).
 */

export * from "./services/license/gate.js";
