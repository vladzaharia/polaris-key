/**
 * Package feeds on the registry host (F-02, plans/F-01.md §6): the renderers and the routes.
 *
 * Each ecosystem package (F-04 npm, F-05 PyPI, F-06 Swift, F-07 Maven, F-08 OCI, F-09 Godot)
 * adds one `RegistryRenderer` from its own `registry/<ecosystem>/` directory to `RENDERERS`;
 * its routes reach the host through `DISTRIBUTION_REGISTRY_ROUTES`, which `mount.ts` spreads
 * into `REGISTRY_ROUTES`. F-02 shipped the framework and no ecosystem; each feed package adds
 * its own line below.
 */

import type {
  RegistryEcosystem,
  RegistryRoute,
} from "../../../core/registryHost.js";
import type { RegistryRenderer } from "./materialise.js";
import { NPM_RENDERER } from "./npm/index.js";
import { PYPI_RENDERER } from "./pypi/index.js";
import { SWIFT_RENDERER } from "./swift/index.js";
import { MAVEN_RENDERER } from "./maven/index.js";

/** Every renderer this build carries, one per ecosystem. */
export const RENDERERS: ReadonlyMap<RegistryEcosystem, RegistryRenderer> =
  new Map<RegistryEcosystem, RegistryRenderer>([
    ["npm", NPM_RENDERER], // F-04
    ["pypi", PYPI_RENDERER], // F-05
    ["swift", SWIFT_RENDERER], // F-06
    ["maven", MAVEN_RENDERER], // F-07
  ]);

/** Every registry route, in renderer order. */
export const DISTRIBUTION_REGISTRY_ROUTES: readonly RegistryRoute[] = [
  ...RENDERERS.values(),
].flatMap((r) => r.routes);

export {
  authorizeFeedRead,
  extractFeedCredential,
  feedPrincipal,
  feedRefusal,
  type ChallengeKind,
  type FeedPrincipal,
  type FeedReadDecision,
} from "./authorize.js";
export {
  drainRegistry,
  materialise,
  readRegistryObject,
  selfCheck,
  type PackageSource,
  type RegistryPackage,
  type RegistryQueue,
  type RegistryRenderer,
} from "./materialise.js";
export { feedRoute, serveFeedRead, type FeedRouteDef } from "./serve.js";
