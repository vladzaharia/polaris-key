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
 * inventory of what License and Config can touch, so widening it is a visible edit in a
 * core-owned file rather than an unnoticed new import inside a service. Everything else in
 * `repo.ts` — release, portal, OIDC, admin, sync state — is unreachable from a service by
 * construction.
 *
 * Definitions stay in `repo.ts`; this file adds nothing.
 */

export type {
  AuditRow,
  DeviceRow,
  LicenseRow,
  ProfileRow,
  SchemaRow,
  TierRow,
} from "../repo.js";

export {
  appendAudit,
  claimDeviceSeat,
  countActiveDevices,
  getActiveSchema,
  getKey,
  getLicense,
  getLicenseByEnrollHwid,
  getProfile,
  getTier,
  insertLicense,
  listDevicesByLicense,
  listLicenseProfiles,
  seatActiveSince,
  setDeviceStatus,
  touchKey,
  upsertDevice,
} from "../repo.js";
