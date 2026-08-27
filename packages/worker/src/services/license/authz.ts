/**
 * Compatibility re-export. The seat decision moved to `core/authz.ts` when Identity was carved.
 *
 * `licenses` and `tiers` stay License-owned (spec §5.2) — but the CODE that claims a seat and
 * mints a device token is now run by two services: License's activation/enrolment, and
 * Identity's OIDC sign-in and browser-session exchange. A service may not import a sibling
 * (`test/boundaries.test.ts`), and a duplicated seat check is how two services end up admitting
 * a different number of machines to one licence, so Core owns the computation and both bind to
 * it. See `core/authz.ts` for the full argument.
 *
 * Nothing may be defined here.
 */

export {
  authorizeDevice,
  docProfile,
  resolveEntitlements,
  tierExpiresAt,
  type AuthzError,
} from "../../core/authz.js";
