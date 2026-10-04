/**
 * Package feeds on the registry host (F-02, plans/F-01.md §6): the adapter registry.
 *
 * Every feed is one `FeedAdapter` (`adapter.ts`), exported from its own `registry/<ecosystem>/`
 * directory and listed once in `FEED_ADAPTERS` below. Everything else is derived from that list:
 * `RENDERERS` (the materialiser's), `DISTRIBUTION_REGISTRY_ROUTES` (which `mount.ts` spreads into
 * `REGISTRY_ROUTES`), the console's capabilities and settings validation (`admin/lib/feedModel.ts`)
 * and `routeCoverage`'s registry table. Adding a feed is adding its directory and one line here;
 * `test/feedAdapters.test.ts` is the conformance suite it must pass, and
 * `/docs/contribute/package-feeds/` the checklist.
 */

import type {
  RegistryEcosystem,
  RegistryRoute,
} from "../../../core/registryHost.js";
import type { PackageEcosystem } from "@polaris-key/manifest";
import { rendererOf, type FeedAdapter } from "./adapter.js";
import type { RegistryRenderer } from "./materialise.js";
import { NPM_ADAPTER } from "./npm/index.js";
import { PYPI_ADAPTER } from "./pypi/index.js";
import { SWIFT_ADAPTER } from "./swift/index.js";
import { MAVEN_ADAPTER } from "./maven/index.js";
import { OCI_ADAPTER } from "./oci/index.js";
import { GODOT_ADAPTER } from "./godot/index.js";

/** Every feed this build carries, one adapter per ecosystem, in route order. */
export const FEED_ADAPTERS: readonly FeedAdapter[] = [
  NPM_ADAPTER, // F-04
  PYPI_ADAPTER, // F-05
  SWIFT_ADAPTER, // F-06
  MAVEN_ADAPTER, // F-07
  OCI_ADAPTER, // F-08: OCI pull at /v2/
  GODOT_ADAPTER, // F-09: both editor API shapes and the GodotEnv index
];

const BY_ECOSYSTEM = new Map<string, FeedAdapter>(
  FEED_ADAPTERS.map((a) => [a.ecosystem, a]),
);

/** The adapter of one ecosystem, or `null` when this build carries none (tier 3's names). */
export function feedAdapter(ecosystem: string): FeedAdapter | null {
  return BY_ECOSYSTEM.get(ecosystem) ?? null;
}

/** The adapter of an ecosystem the manifest knows; throws if `FEED_ADAPTERS` lacks it. */
export function requireFeedAdapter(ecosystem: PackageEcosystem): FeedAdapter {
  const a = BY_ECOSYSTEM.get(ecosystem);
  if (!a) throw new Error(`registry: no feed adapter for ${ecosystem}`);
  return a;
}

/** Every renderer this build carries, one per ecosystem (the adapters' renderers). */
export const RENDERERS: ReadonlyMap<RegistryEcosystem, RegistryRenderer> =
  new Map<RegistryEcosystem, RegistryRenderer>(
    FEED_ADAPTERS.map((a) => [a.ecosystem, rendererOf(a)]),
  );

/** Every registry route, in adapter order. */
export const DISTRIBUTION_REGISTRY_ROUTES: readonly RegistryRoute[] =
  FEED_ADAPTERS.flatMap((a) => a.routes);

export type {
  FeedAdapter,
  FeedCapabilities,
  FeedChannels,
  FeedOpenApiRow,
  FeedSetupInput,
} from "./adapter.js";
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
export { feedRoute, serveFeedRead, type FeedRouteDef } from "./serve.js";
