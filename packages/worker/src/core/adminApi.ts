/**
 * The admin-API seam — what a service's `adminHandle` is allowed to speak (design spec §4.2).
 *
 * `ServiceDescriptor.adminHandle` (see `registry.ts`) exists so a service can own its slice of
 * `/manage/api/products/<slug>/…`. To answer at all, that handler needs the console's response
 * envelope, the audit writer and the session type — all of which physically live under
 * `../admin/`, which a service may not import (`test/boundaries.test.ts`).
 *
 * So Core declares the interface and owns where the implementation sits, exactly as
 * `core/platform.ts` does for the Worker substrate and `core/data.ts` does for D1. A service
 * binds to `core/adminApi.js`; if the admin envelope ever moves, this file changes and no
 * service does.
 *
 * Note what is NOT here: session verification, CSRF, the rate limiter and the platform-admin
 * gate. Those run in `admin/api.ts` BEFORE a descriptor is consulted, and they stay there — an
 * access control a service could re-implement is one a service could get wrong.
 */

export type { AdminSession } from "../admin/session.js";

export { audit, auditStatementFor } from "../admin/audit.js";

export {
  adminJson,
  err,
  forbidden,
  notFound as adminNotFound,
  readBody,
} from "../admin/lib/respond.js";

/**
 * ── THE CONSOLE'S SHARED SHAPING + STORAGE, LENT TO A SERVICE ────────────────────────────────
 *
 * P7 moved the product-scoped admin resources under the services that own them (plan §R1:
 * `licenses` → `license/licenses`, `schema` → `config/catalog`, …). Their handlers moved with
 * them, and those handlers still need three things that are the CONSOLE's, not any one
 * service's: the redaction rules that keep a secret's value off the wire, the catalog-validated
 * override applier, and the list/summary projections the SPA's tables are built from.
 *
 * All three must have exactly one implementation. A secret redacted one way by License's
 * override editor and another by Config's profile editor is a leak waiting for the divergence,
 * and it is precisely the divergence a "quick copy into the service directory" produces. So they
 * arrive through this seam, like the response envelope above.
 *
 * The admin repo queries are here for the same reason `core/data.ts` exists for `repo.ts`: the
 * per-service split of `admin/repo.ts` is a later phase, and until it happens the reachable set
 * should be COUNTABLE in one core-owned file rather than spread across new imports inside five
 * service directories.
 */
export {
  countLicensesUsingProfile,
  countLicensesUsingTier,
  deactivateSchemas,
  deleteProfile,
  deleteTier,
  getSchemaVersion,
  listLicenses,
  listProfileReferences,
  listProfiles,
  listSchemaPublishers,
  listSchemaVersions,
  listTiers,
  nextSchemaVersion,
  patchLicense,
  setLicenseStatus,
  upsertProfile,
  upsertTier,
} from "../admin/repo.js";

export { shapeFacts, shapeFingerprint } from "../admin/lib/deviceShape.js";

export { parsePayload, redactPayload } from "../admin/lib/redact.js";

// ST-01b: a catalog publish is one batch with its claim; a profile edit that only sets managed
// secrets does not claim the row (`profiles.ts`).
export { stmtInsertSchema } from "../repo.js";
export { isManagedSecretKey } from "../admin/lib/managedSecrets.js";

export { applyOverrides, type OverrideUpdate } from "../admin/lib/overrides.js";

export {
  WriteChecks,
  catalogRepresentabilityResponse,
  reservedNamesResponse,
} from "../admin/lib/writeChecks.js";

export {
  licenseSummary,
  loadCatalog,
  parseJsonColumn,
  parseJsonList,
} from "../admin/lib/shape.js";
