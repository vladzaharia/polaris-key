/**
 * Compatibility surface for the pre-suite modules that have not been carved yet.
 *
 * Everything this file used to define now lives where the layout puts it:
 *
 *   - the device half (`validateDeviceToken`, `rotateDeviceToken`, `bindDevice`,
 *     `reconcileDeviceHardware`, `licenseUsable`)  →  `core/devices.ts`   (P1.T1)
 *   - the layer walk (`catalogDefaultPayload`, the merge)  →  `core/payload.ts`
 *   - the seat decision (`authorizeDevice`, `tierExpiresAt`, `docProfile`) and the fused
 *     `resolveEffective`                                   →  `core/authz.ts`      (P3)
 *   - the admin policy injection (`injectAdminPolicy`)     →  `core/entitlements.ts`
 *
 * `resolveEffective` was the last definition left here. It moved to Core with the identity
 * carve, because its two remaining callers — identity's browser session and the portal's
 * entitlement view — are now inside `services/identity/`, and a service may not import a
 * top-level legacy module (`test/boundaries.test.ts`). What is left is this shim, for the admin
 * handlers and the behaviour-pin suites that still spell the old address.
 *
 * Nothing new may be added here.
 */

export {
  authorizeDevice,
  docProfile,
  resolveEffective,
  tierExpiresAt,
  type AuthzError,
} from "./core/authz.js";
