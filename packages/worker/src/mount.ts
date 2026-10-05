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
import {
  buildSettingsRegistry,
  type SettingsRegistry,
} from "./core/settings/registry.js";
import type { ByteRoute } from "./core/bytesHost.js";
import type {
  OwnerlessRegistryRoute,
  RegistryRoute,
} from "./core/registryHost.js";
import { licenseService } from "./services/license/index.js";
import { configService } from "./services/config/index.js";
import {
  RELEASE_PUBLISH_ROUTES,
  releaseService,
} from "./services/release/index.js";
import {
  DISTRIBUTION_BYTE_ROUTES,
  DISTRIBUTION_OWNERLESS_ROUTES,
  DISTRIBUTION_REGISTRY_ROUTES,
  DOWNLOAD_PAGE_ROUTE,
  distributionService,
} from "./services/distribution/index.js";
import { updateService } from "./services/update/index.js";
import { identityService } from "./services/identity/index.js";

export const SERVICES: ServiceRegistry = new Map([
  [licenseService.slug, licenseService],
  [configService.slug, configService],
  [releaseService.slug, releaseService],
  [distributionService.slug, distributionService],
  [updateService.slug, updateService],
  [identityService.slug, identityService],
]);

/**
 * The settings registry (ST-03, `core/settings/`): the platform slice, Core's product slice and
 * every mounted service's `settings` slice, assembled once from `SERVICES` so Core never names a
 * service. `test/settings-registry.test.ts` runs the registry rules over exactly this value.
 */
export const SETTINGS: SettingsRegistry = buildSettingsRegistry(
  SERVICES.values(),
);

/**
 * The bytes-host allowlist (P2-01, `core/bytesHost.ts`): the only routes that can answer on
 * `BLOB_ORIGIN` (`dl.plrs.im`). A route not listed here does not exist on that host.
 *
 * It lives here, beside `SERVICES`, for the same reason: byte routes are service code, and Core
 * must not import services. Each entry names its `service`, and the bytes-host dispatcher runs it
 * only while that service is enabled for the product. P2-01 registered none; P2-05 added
 * Release's three; P2b-04 moved them into Distribution (all byte delivery is Distribution's,
 * README §3.5): `/<p>/distribution/{builds,files,blobs}/…`, each also matching its
 * `/<p>/release/…` spelling, so the URLs discovery advertised on `dl.plrs.im` keep answering.
 * They name `service: "distribution"`: with Distribution off they answer the host's flat
 * not-found, whatever Release says.
 *
 * P2b-06 added the one DOCUMENT route, the public download page (`/<p>/distribution/download`
 * and `/<p>`): HTML, admitted by the dispatcher only under the sandboxed, script-free policy it
 * checks (`core/bytesHost.ts` `inertDocumentPolicy`).
 */
export const BYTE_ROUTES: readonly ByteRoute[] = [
  ...DISTRIBUTION_BYTE_ROUTES,
  DOWNLOAD_PAGE_ROUTE,
];

/**
 * The registry-host allowlist (F-02, `core/registryHost.ts`, plans/F-01.md §6.1): the only routes
 * that can answer on `PKG_ORIGIN` (`pkg.plrs.im`), beside the host's landing page and OCI's
 * `/v2/` root. A route not listed here does not exist on that host. Each belongs to one
 * ecosystem. The reads and credential routes are Distribution's (`service: "distribution"`;
 * F-04 to F-09 add theirs to `DISTRIBUTION_REGISTRY_ROUTES`); the native publish routes (F-22:
 * `npm publish`, twine, `swift package-registry publish`, Maven `PUT`s) are Release's
 * (`service: "release"`), because a publish is Release's ingest. `test/routeCoverage.test.ts`
 * checks this list against its `REGISTRY_PATHS` table in both directions (rule 10).
 */
export const REGISTRY_ROUTES: readonly RegistryRoute[] = [
  ...DISTRIBUTION_REGISTRY_ROUTES,
  ...RELEASE_PUBLISH_ROUTES,
];

/**
 * The registry host's owner-less routes (F-21, plans/F-20.md §6.4): OCI's token service
 * `GET /v2/token`, whose owners are named in its `scope` parameters. GET and HEAD only;
 * `routeCoverage` checks it against `REGISTRY_PATHS` with `REGISTRY_ROUTES`.
 */
export const REGISTRY_OWNERLESS_ROUTES: readonly OwnerlessRegistryRoute[] = [
  ...DISTRIBUTION_OWNERLESS_ROUTES,
];
