/**
 * Descriptor hooks — how one service reads another's state without importing it (P2b-01,
 * README §3.2 "Sharing data without importing").
 *
 * The chain is release ← distribution ← update: truth, then delivery, then decision. A service
 * may import only `core/` and itself (AGENTS.md rule 6, `test/boundaries.test.ts`), with the one
 * historical exception `update → release`. So when Distribution needs to know what Release says
 * exists, or Update needs to know what Distribution has delivered, it asks CORE, and Core asks
 * the registry. That is the pattern `ServiceDescriptor.authorizeRegistration` set
 * (`registry.ts`), generalised to three read-only views:
 *
 *   - `releaseCatalog`      (implemented by Release): deliverables, releases, builds, artifact
 *                            records, channel policy, yanks;
 *   - `delivery`            (implemented by Distribution): transports, availability and, later,
 *                            rollout, halts and delivery URLs per outlet;
 *   - `outletCapabilities`  (implemented by Distribution): what one outlet permits.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────────────────────
 *
 * 1. **Fail closed.** The accessor checks the PROVIDING service's enablement first, for this
 *    product, and returns `null` when it is off — before the provider's hook code runs at all
 *    (the same rule `dispatchService` and `authorizeRegistration` follow). A consumer degrades
 *    explicitly on `null`: Update without a delivery hook serves no per-outlet state.
 * 2. **Read-only.** A hook never writes. A cross-service write would be an import in disguise —
 *    it would let one service change another's tables behind its back, which is precisely what
 *    the boundary exists to stop. Every shape below is a plain data record or a reader returning
 *    plain records, and nothing here takes a `DbStatement`.
 * 3. **Types live here.** Core may not import a service, so the contract is declared in Core and
 *    the services implement it. Keep the surfaces small and keyed by DELIVERABLE, never by "is a
 *    pack" (README §11 guardrails): the app and every pack go through the same three services
 *    the same way.
 * 4. **One provider per hook.** Exactly one mounted descriptor may implement each hook. Zero or
 *    more than one makes the accessor answer `null` (fail closed), and `test/hooks.test.ts`
 *    asserts the composition root has exactly one of each.
 *
 * ── WHO EXTENDS WHAT ────────────────────────────────────────────────────────────────────────
 *
 * P2b-04 adds resolution and source access to `ReleaseCatalog`; P2b-02 implements
 * `outletCapabilities`; P2b-03 and P2b-04 fill `Delivery`. P3-03, P4-05, P4-14 and P6-03 consume.
 */

/// <reference types="@cloudflare/workers-types" />

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product } from "./products.js";
import type { ServiceSlug, ServicesMap } from "./services.js";

// ── releaseCatalog (Release) ────────────────────────────────────────────────────────────────

/** One thing a product releases: its `app`, or a pack. */
export interface CatalogDeliverable {
  /** `app`, or a pack id. */
  id: string;
  /** `app` | `pack` (`DELIVERABLE_KINDS` in @polaris-key/manifest). */
  kind: string;
  /** The pack type (`godot.pck`, …); `null` for the app. */
  packType: string | null;
}

/** One release of one deliverable. */
export interface CatalogRelease {
  deliverableId: string;
  releaseId: string;
  version: string;
  /** Publication order within the deliverable; `null` only on a pre-P2-03 row. */
  seq: number | null;
  /** The channel it was published to; `null` = derived from GitHub, as today. */
  channel: string | null;
  /** Epoch seconds; `null` when the source never said. */
  publishedAt: number | null;
  /** Whether the release is yanked (unservable except by pin). */
  yanked: boolean;
}

/** One compiled build of a release, or one variant of a pack release. */
export interface CatalogBuild {
  releaseId: string;
  buildId: string;
  /** `null` = platform-independent (a pack variant). */
  platform: string | null;
  arch: string;
  format: string | null;
  buildNumber: string | null;
  minOs: string | null;
}

/** One file of a build (or of a release, for rows the GitHub sync wrote). A RECORD, not bytes. */
export interface CatalogArtifact {
  releaseId: string;
  artifactId: string;
  name: string;
  /** `null` for rows the GitHub sync wrote before a descriptor named the build. */
  buildId: string | null;
  /** `ARTIFACT_ROLES` in @polaris-key/manifest; `null` only on an unbackfilled row. */
  role: string | null;
  platform: string | null;
  arch: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
}

/** The operator-owned channel policy for one deliverable on one channel. */
export interface CatalogChannelPolicy {
  deliverableId: string;
  channel: string;
  pointerReleaseId: string | null;
  pinned: boolean;
  includes: string[] | null;
  minSupported: string | null;
  critical: boolean;
}

/** One yank. */
export interface CatalogYank {
  releaseId: string;
  reason: string;
  /** Epoch seconds. */
  at: number;
}

/**
 * Release's read-only view of what exists (README §3.2). Every method reads; none writes.
 * Results are ordered deterministically so a consumer's output is stable.
 */
export interface ReleaseCatalog {
  /** Every deliverable, `app` first, then packs by id. */
  deliverables(): Promise<CatalogDeliverable[]>;
  /** A deliverable's releases, newest publication first. */
  releases(deliverableId: string): Promise<CatalogRelease[]>;
  /** A release's builds, by build id. */
  builds(releaseId: string): Promise<CatalogBuild[]>;
  /** A release's artifact records; narrowed to one build when `buildId` is given. */
  artifacts(releaseId: string, buildId?: string): Promise<CatalogArtifact[]>;
  /** Channel policy, for one deliverable or (omitted) all of them. */
  channelPolicies(deliverableId?: string): Promise<CatalogChannelPolicy[]>;
  /** Every yank, newest first. */
  yanks(): Promise<CatalogYank[]>;
}

// ── delivery (Distribution) ─────────────────────────────────────────────────────────────────

/**
 * How bytes arrive (README §3.1 "transport"). Open-ended on purpose: the list grows with each
 * outlet package, and a closed union here would make every addition a Core change.
 */
export type TransportId = string;

/** The transport every deliverable uses when no outlet says otherwise: our own CDN. */
export const DEFAULT_TRANSPORT: TransportId = "pkey-cdn";

/** "Version V of deliverable D is live on outlet O since T" (README §3.1 "availability"). */
export interface AvailabilityRecord {
  deliverableId: string;
  releaseId: string;
  outletId: string;
  transport: TransportId;
  /** The outlet-side state, e.g. `live`, `in-review`. Vocabulary set by P2b-03. */
  state: string;
  /** Epoch seconds the record entered `state`. */
  since: number;
}

/**
 * Distribution's read-only view of how releases reach devices and outlets (README §3.2).
 * P2b-01 ships it with no outlets: the default transport is `pkey-cdn` and availability is
 * empty. P2b-03 and P2b-04 fill it in.
 */
export interface Delivery {
  /** The transport a deliverable uses on an outlet that names none. */
  defaultTransport: TransportId;
  /** Availability records for one deliverable, optionally narrowed to one release. */
  availability(
    deliverableId: string,
    releaseId?: string,
  ): Promise<AvailabilityRecord[]>;
}

// ── outletCapabilities (Distribution) ───────────────────────────────────────────────────────

/**
 * What an outlet permits (README §3.1 "outlet capabilities"). The security-relevant bits are
 * operator-owned and never manifest-writable — P2b-02 decides which, and implements the hook.
 */
export interface OutletCapabilities {
  outletId: string;
  binaryUpdates: "self" | "store" | "none";
  codeUpdates: boolean;
  dataUpdates: boolean;
  channelSwitch: boolean;
  commerce: "own" | "store-iap" | "steam" | "none";
  downloadedScripts: boolean;
}

// ── The contract ────────────────────────────────────────────────────────────────────────────

/**
 * What a hook implementation is given: the request-independent facts about this product. No
 * `Request`, no `rest` — a hook answers a question about state, never a route — and `hooks`, so
 * a provider can itself consume another hook through the same gate (Distribution reading
 * Release's catalog) rather than reaching around it.
 */
export interface HookContext {
  env: Env;
  db: Db;
  product: Product;
  /** Epoch seconds — the same value as the request this is answering. */
  now: number;
  hooks: ServiceHooks;
}

/**
 * The three hooks a descriptor may implement. Each is a SYNCHRONOUS factory returning a reader:
 * the gate (enablement) is decided before it is called, and the reader does its own I/O lazily.
 */
export interface DescriptorHooks {
  releaseCatalog?(ctx: HookContext): ReleaseCatalog;
  delivery?(ctx: HookContext): Delivery;
  outletCapabilities?(
    ctx: HookContext,
    outletId: string,
  ): Promise<OutletCapabilities | null>;
}

export type HookName = keyof DescriptorHooks;

/** The accessors a service is handed. `null` = the providing service is off for this product. */
export interface ServiceHooks {
  releaseCatalog(): ReleaseCatalog | null;
  delivery(): Delivery | null;
  outletCapabilities(outletId: string): Promise<OutletCapabilities | null>;
}

/** The registry, as far as hooks need it — structural, so this file never imports `registry.ts`. */
type HookRegistry = ReadonlyMap<
  ServiceSlug,
  { slug: ServiceSlug } & DescriptorHooks
>;

/**
 * The ONE descriptor implementing `name`, or `null` when none or several do. Several is a
 * composition error that must not be resolved by "first wins": that would make which service
 * answers depend on `mount.ts` order.
 */
export function hookProvider(
  registry: HookRegistry,
  name: HookName,
): ({ slug: ServiceSlug } & DescriptorHooks) | null {
  let found: ({ slug: ServiceSlug } & DescriptorHooks) | null = null;
  for (const descriptor of registry.values()) {
    if (typeof descriptor[name] !== "function") continue;
    if (found) return null;
    found = descriptor;
  }
  return found;
}

/**
 * Build the hooks for one product, from the registry and that product's enablement.
 *
 * `services` is passed explicitly rather than read off `base.product`, so the gate is the SAME
 * map the caller dispatched on (`dispatchService`'s `services` argument). Every accessor checks
 * `services[provider.slug].enabled` and returns `null` BEFORE calling into the provider, so a
 * disabled service's hook code never runs. `releaseCatalog()` and `delivery()` are memoised per
 * hooks object (one request): a reader is cheap, but a consumer that asks twice should get the
 * same one.
 */
export function buildHooks(
  registry: HookRegistry,
  services: ServicesMap,
  base: Omit<HookContext, "hooks">,
): ServiceHooks {
  const enabled = (slug: ServiceSlug): boolean =>
    services[slug]?.enabled === true;
  const providers = {
    releaseCatalog: hookProvider(registry, "releaseCatalog"),
    delivery: hookProvider(registry, "delivery"),
    outletCapabilities: hookProvider(registry, "outletCapabilities"),
  };
  let catalog: ReleaseCatalog | null | undefined;
  let delivery: Delivery | null | undefined;

  const hooks: ServiceHooks = {
    releaseCatalog() {
      if (catalog !== undefined) return catalog;
      const p = providers.releaseCatalog;
      catalog =
        p?.releaseCatalog && enabled(p.slug) ? p.releaseCatalog(ctx) : null;
      return catalog;
    },
    delivery() {
      if (delivery !== undefined) return delivery;
      const p = providers.delivery;
      delivery = p?.delivery && enabled(p.slug) ? p.delivery(ctx) : null;
      return delivery;
    },
    async outletCapabilities(outletId: string) {
      const p = providers.outletCapabilities;
      if (!p?.outletCapabilities || !enabled(p.slug)) return null;
      return p.outletCapabilities(ctx, outletId);
    },
  };
  const ctx: HookContext = { ...base, hooks };
  return hooks;
}
