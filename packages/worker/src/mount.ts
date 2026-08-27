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
 * is the composition root's list. Adding a service is one entry here plus one slug in
 * `router.ts`'s `SERVICE_NAMESPACES` — nothing in Core learns the name.
 *
 * Descriptors are stateless route tables, so rebuilding the map per request would be work on
 * every cold path for no benefit.
 */

import type { ServiceRegistry } from "./core/registry.js";
import { licenseService } from "./services/license/index.js";
import { configService } from "./services/config/index.js";
import { releaseService } from "./services/release/index.js";
import { updateService } from "./services/update/index.js";

export const SERVICES: ServiceRegistry = new Map([
  [licenseService.slug, licenseService],
  [configService.slug, configService],
  [releaseService.slug, releaseService],
  [updateService.slug, updateService],
]);
