/**
 * Native-client publish adapters (F-22, S-12 §10 tier 2): the registry host's write routes.
 *
 *   PUT  /npm/<owner>/<@scope%2fname | @scope/name>     npm publish (and pnpm, Yarn, Bun)   npm.ts
 *   POST /pypi/<owner>/legacy/                          twine upload (the legacy API)       pypi.ts
 *   PUT  /swift/<owner>/<scope>/<name>/<version>        swift package-registry publish      swift.ts
 *   PUT  /maven/<owner>/<group/path>/<artifact>/…       mvn deploy, Gradle maven-publish    maven.ts
 *
 * Each translates its client's request into the release descriptor `pkey release publish` sends
 * and ingests it through F-03's path (`../ingest.ts`), so a natively published version is the
 * same package release, rendered by the same feeds, as a CLI-published one. They are Release's
 * routes (a publish is Release's ingest) on Distribution's host: `mount.ts` adds them to
 * `REGISTRY_ROUTES`, and they read the feed settings only through the `delivery` hook (rule 6).
 *
 * Who may publish: a `pkeyr_` token with the `publish` scope, owner-bound and narrowed to the
 * ecosystem, or the owner's `pkeyci_` with `release:publish` (`core/registry/registryPublish.ts`). CI
 * should present the 30-minute `pkeyci_` `pkey auth github-oidc` exchanges for the job's OIDC
 * token, so no long-lived publish secret is stored in CI at all.
 */

import type { RegistryRoute } from "../../../../core/registry/registryHost.js";
import { MAVEN_DEPLOY_ROUTE } from "./maven.js";
import { NPM_PUBLISH_ROUTE } from "./npm.js";
import { PYPI_UPLOAD_ROUTE } from "./pypi.js";
import { SWIFT_PUBLISH_ROUTE } from "./swift.js";

/** Every native publish route, in feed order (`mount.ts` adds them to `REGISTRY_ROUTES`). */
export const NATIVE_PUBLISH_ROUTES: readonly RegistryRoute[] = [
  NPM_PUBLISH_ROUTE,
  PYPI_UPLOAD_ROUTE,
  SWIFT_PUBLISH_ROUTE,
  MAVEN_DEPLOY_ROUTE,
];

/**
 * The OpenAPI rows of the native publish routes, `[path, methods, route name]`, in the shape of a
 * feed adapter's `openapi` (`routeCoverage`'s `REGISTRY_PATHS` reads both, rule 10). npm, Swift
 * and Maven write to paths their feed also reads; their read methods are the feed's rows.
 */
export const NATIVE_PUBLISH_OPENAPI: readonly (readonly [
  path: string,
  methods: readonly ("put" | "post")[],
  owner: string,
])[] = [
  ["/npm/{owner}/{escapedName}", ["put"], "npm.publish"],
  ["/npm/{owner}/{scope}/{name}", ["put"], "npm.publish"],
  ["/pypi/{owner}/legacy/", ["post"], "pypi.upload"],
  ["/swift/{owner}/{scope}/{name}/{version}", ["put"], "swift.publish"],
  [
    "/maven/{owner}/{groupPath}/{artifactId}/{version}/{file}",
    ["put"],
    "maven.deploy",
  ],
  [
    "/maven/{owner}/{groupPath}/{artifactId}/maven-metadata.xml",
    ["put"],
    "maven.deploy",
  ],
  [
    "/maven/{owner}/{groupPath}/{artifactId}/maven-metadata.xml.{checksum}",
    ["put"],
    "maven.deploy",
  ],
];

export { sweepNativeSessions } from "./sessions.js";
