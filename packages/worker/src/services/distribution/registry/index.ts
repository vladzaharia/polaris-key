/**
 * Package feeds on the registry host (F-02, plans/F-01.md §6): the renderers and the routes.
 *
 * Each ecosystem package (F-04 npm, F-05 PyPI, F-06 Swift, F-07 Maven, F-08 OCI, F-09 Godot)
 * adds one `RegistryRenderer` from its own `registry/<ecosystem>/` directory to `RENDERERS`;
 * its routes reach the host through `DISTRIBUTION_REGISTRY_ROUTES`, which `mount.ts` spreads
 * into `REGISTRY_ROUTES`. F-02 ships the framework and no ecosystem, so the host answers its
 * landing page, OCI's `/v2/` root and the not-found.
 */

import type {
  RegistryEcosystem,
  RegistryRoute,
} from "../../../core/registryHost.js";
import type { RegistryRenderer } from "./materialise.js";
import { GODOT_RENDERER } from "./godot/index.js";

/** Every renderer this build carries, one per ecosystem. */
export const RENDERERS: ReadonlyMap<RegistryEcosystem, RegistryRenderer> =
  new Map<RegistryEcosystem, RegistryRenderer>([
    // F-09: the Godot feed (both editor API shapes and the GodotEnv index).
    ["godot", GODOT_RENDERER],
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
  readFreshRegistryObject,
  readRegistryObject,
  selfCheck,
  type PackageSource,
  type RegistryPackage,
  type RegistryQueue,
  type RegistryRenderer,
  type RenderFeed,
} from "./materialise.js";
export { serveFeedRead } from "./serve.js";
