/**
 * Entitlements — the License service's half of the old fused payload (WIRE-CONTRACT-V3 §2.1).
 *
 * Wire v3 makes `entitlements` the ONLY carrier of grant data (D-20). Everything a client is
 * allowed to do arrives here: the catalog's declared `flag` entries, as authored into profiles
 * and overrides, plus the admin/tier policy this module injects — `license.tier`,
 * `license.tierLabel`, `channels`, `app.minVersion`, `app.maxVersion`, `deviceLimit`.
 *
 * ── THE SPLIT ───────────────────────────────────────────────────────────────────────────────
 *
 * `licenseCore.resolveEffective` used to return config, secrets and entitlements together
 * because one document carried all three. Two documents means two owners:
 *
 *     core.resolveMergedPayload   the layer walk, jointly owned (see core/payload.ts)
 *       ├─ this file              + injectAdminPolicy  →  entitlements  →  license document
 *       └─ services/config        + open sealed values →  config/secrets →  config document
 *
 * The merge is not duplicated; only the slice differs. `resolveEffective` survives as a legacy
 * shim over exactly these two steps, so the surfaces that still mint a v2 document (identity's
 * `/identity/session`, the portal's entitlement view) are byte-identical to before the split.
 */

// `injectAdminPolicy` moved to `core/entitlements.ts` in P2.T3 so the `entitled` release/update
// access mode (D-13) computes the SAME entitlement map this document carries, rather than a
// second row-only derivation that would silently ignore channels authored in a profile or an
// override. `resolveEntitlements` followed it into `core/authz.ts` when Identity was carved:
// Identity's seat check reads the same `deviceLimit` this document publishes, and a service may
// not import a sibling. Both are re-exported here so License's own call sites — and the
// `licenseCore.ts` compat shim — are unchanged.
export { injectAdminPolicy } from "../../core/entitlements.js";
export { resolveEntitlements } from "../../core/authz.js";
