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

export { audit } from "../admin/audit.js";

export {
  adminJson,
  err,
  forbidden,
  notFound as adminNotFound,
  readBody,
} from "../admin/lib/respond.js";
