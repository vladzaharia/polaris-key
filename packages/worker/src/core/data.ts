/**
 * The storage seam — the only door a service has onto D1 (design spec §5.2).
 *
 * Tables are logically owned (`licenses`/`tiers` are License's, `product_schema`/`profiles`
 * are Config's, `devices`/`products`/`audit` are Core's) but they still live in one database
 * behind one `repo.ts`. Splitting that file per service is a later phase; until then a service
 * must not reach `../../repo.js` directly, because that is precisely the import a hurried move
 * leaves behind and the boundary test refuses.
 *
 * Re-exporting the reachable set HERE makes the seam countable: this list is the complete
 * inventory of what License, Config and Identity can touch, so widening it is a visible edit in
 * a core-owned file rather than an unnoticed new import inside a service. Everything else in
 * `repo.ts` — release, admin, sync state — is unreachable from a service by construction.
 *
 * ── WHY IDENTITY READS AND WRITES LICENCE ROWS ──────────────────────────────────────────────
 *
 * Spec §5.2 makes `licenses` License-owned, and the P3 carve put OIDC sign-in inside Identity —
 * a flow whose whole purpose is to turn a verified subject into a licence (mint it, claim an
 * anonymous enrolment into it, migrate devices onto it). That is a declared cross-domain SEAM,
 * not a second implementation: the row writers below are the same ones License itself uses, and
 * they arrive through Core exactly so the two services bind to one definition rather than to
 * each other.
 *
 * Definitions stay in `repo.ts`; this file adds nothing.
 */

export type {
  AuditRow,
  DeviceRow,
  KeyRow,
  LicenseRow,
  ProductRow,
  ProfileRow,
  SchemaRow,
  TierRow,
} from "../repo.js";

export {
  appendAudit,
  claimDeviceSeat,
  claimEnrolledLicense,
  countActiveDevices,
  getActiveSchema,
  getDevice,
  getKey,
  getLicense,
  getLicenseByEnrollHwid,
  getLicenseBySub,
  getProduct,
  getProfile,
  getTier,
  insertLicense,
  listDevicesByLicense,
  listLicenseProfiles,
  moveDevices,
  seatActiveSince,
  setDeviceStatus,
  touchKey,
  upsertDevice,
} from "../repo.js";
