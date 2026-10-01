/**
 * The composition root's service table — which services this worker mounts.
 *
 * ONE map, built once at module scope, shared by the two dispatchers that need it: the public
 * router (`index.ts`) and the admin API (`admin/api.ts`, for `adminHandle`). It lives in its own
 * module rather than in `index.ts` because `admin/` is reachable FROM `index.ts`, so importing
 * the table out of there would close a cycle.
 *
 * This is deliberately NOT in `core/`. Core owns dispatch and knows nothing about which services
 * exist (see `core/registry.ts`); knowing the names is the composition root's job, and this file
 * is the composition root's list. The slugs themselves are declared once, in
 * `tools/services.json` (Core, `router.ts`'s `SERVICE_NAMESPACES` and discovery all iterate the
 * generated `SERVICE_SLUGS`); `test/serviceTable.test.ts` fails until every table row has an
 * entry here. Adding a service is a checklist, not a one-liner:
 * /docs/contribute/layout/#adding-a-service.
 *
 * Descriptors are stateless route tables, so rebuilding the map per request would be work on
 * every cold path for no benefit.
 */

import type { ServiceRegistry } from "./core/registry.js";
import type { ByteRoute } from "./core/bytesHost.js";
import { licenseService } from "./services/license/index.js";
import { configService } from "./services/config/index.js";
import { releaseService } from "./services/release/index.js";
import { updateService } from "./services/update/index.js";
import { identityService } from "./services/identity/index.js";

export const SERVICES: ServiceRegistry = new Map([
  [licenseService.slug, licenseService],
  [configService.slug, configService],
  [releaseService.slug, releaseService],
  [updateService.slug, updateService],
  [identityService.slug, identityService],
]);

/**
 * The bytes-host allowlist (P2-01, `core/bytesHost.ts`): the only routes that can answer on
 * `BLOB_ORIGIN` (`dl.plrs.im`). A route not listed here does not exist on that host.
 *
 * It lives here, beside `SERVICES`, for the same reason: byte routes are service code (P2-05's
 * release byte routes, P2b-04's distribution routes), and Core must not import services. Each
 * entry names its `service`, and the bytes-host dispatcher runs it only while that service is
 * enabled for the product. EMPTY in P2-01 by design.
 */
export const BYTE_ROUTES: readonly ByteRoute[] = [];
