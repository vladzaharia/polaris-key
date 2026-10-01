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
 *                            records, channel policy, yanks, resolution, and the GitHub-located
 *                            bytes only Release can reach (P2b-04);
 *   - `delivery`            (implemented by Distribution): transports, availability, outlet
 *                            rollouts and halts, delivery access and delivery URLs (P2b-04);
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
 * P2b-04 added resolution and source access to `ReleaseCatalog` and rollouts, delivery access and
 * delivery URLs to `Delivery`; P2b-02 implements `outletCapabilities`; P2b-03 fills availability.
 * P3-03, P4-05, P4-14 and P6-03 consume.
 */

/// <reference types="@cloudflare/workers-types" />

import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { ProductPublic } from "./products.js";
import type { ServiceSlug, ServicesMap } from "./services.js";
import type { EntitledSelector } from "./entitledAccess.js";

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
 * One place an artifact's bytes live (P2-04's `locations_json`). No order is implied: the
 * consumer ranks them (R2, then GitHub, then an external URL; README §3.5). A `store` location
 * carries no bytes.
 */
export interface CatalogLocation {
  provider: "r2" | "github" | "external" | "store";
  /** R2: the content-addressed key. */
  key?: string;
  /** GitHub: an asset id, or a file name in the same release. */
  asset?: number | string;
  /** External: the `https://` URL. */
  url?: string;
}

/** An artifact record plus where its bytes live: what a byte route serves from. */
export interface CatalogSourceArtifact extends CatalogArtifact {
  /** Parsed `locations_json`; a legacy row with no locations reads as its GitHub asset. */
  locations: CatalogLocation[];
}

/** What a byte route asks Release to resolve (P2-05's `resolveBuild`, generalised). */
export type CatalogResolveQuery =
  | { kind: "build"; deliverable: string; selector: string; buildId: string }
  | { kind: "file"; releaseId: string; name: string }
  | { kind: "blob"; sha256: string };

/** A build selector resolved against the truth store. */
export interface CatalogBuildResolution {
  kind: "build";
  release: CatalogRelease;
  build: CatalogBuild;
  /** The build's `payload` artifact, or `null` when it declares none. */
  payload: CatalogSourceArtifact | null;
  /** True when the selector was a channel (its answer moves), false for a version. */
  moving: boolean;
}

/** One exact file of one release. `release` is `null` when the release row does not exist. */
export interface CatalogFileResolution {
  kind: "file";
  release: Pick<
    CatalogRelease,
    "deliverableId" | "releaseId" | "version" | "channel"
  > | null;
  /** `null` when the release has no file of that name (or the release does not exist). */
  artifact: CatalogSourceArtifact | null;
}

/** The releases of this product whose artifacts carry one digest (at most 16, by version). */
export interface CatalogBlobResolution {
  kind: "blob";
  releases: Array<
    Pick<CatalogRelease, "deliverableId" | "releaseId" | "version" | "channel">
  >;
}

export type CatalogResolution =
  | CatalogBuildResolution
  | CatalogFileResolution
  | CatalogBlobResolution;

/**
 * Bytes only Release can reach: the ones on GitHub, behind its installation token and its SSRF
 * guard. Distribution never holds a GitHub token (README §3.5); it hands Release a reference
 * and gets a streamed `Response` back.
 *
 *   - `github`: one artifact's GitHub location. `redirect` asks for P2-05's opt-in 302 to
 *     GitHub's own download URL; Release honours it only for a public repository, and the
 *     caller passes it only for a public deliverable.
 *   - `dl`: the legacy `/dl/<selector>/<binary>-<arch>[.dmg]` route, which resolves a selector
 *     LIVE against GitHub and matches the asset by name. `checksum` serves the `.sha256` sidecar.
 */
export type CatalogSourceRef =
  | {
      kind: "github";
      releaseId: string;
      artifactId: string;
      asset?: number | string;
      redirect: boolean;
    }
  | {
      kind: "dl";
      selector: string | undefined;
      arch: string;
      format: "cli" | "dmg";
      checksum: boolean;
    };

/**
 * Release's read-only view of what exists (README §3.2). Every method reads; none writes.
 * Results are ordered deterministically so a consumer's output is stable.
 *
 * P2b-04 added the five methods byte delivery needs: `metadataAccess`, `accessSelector`,
 * `resolve`, `openSource` and `installScript`. `openSource` is the one method that answers with
 * bytes rather than records — still read-only, and the only way bytes behind Release's GitHub
 * token leave Release.
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
  /**
   * The product's METADATA access mode (`release_config.metadata_access`, which Release keeps:
   * the changelog, the version check, the installer), or `null` when the product has no release
   * configuration at all — every byte route answers not-found then, as it always has.
   */
  metadataAccess(): Promise<ReleaseAccess | null>;
  /**
   * Classify a route selector (`latest`, `beta`, `pr-5`, `1.2.3`, a manual channel; `undefined`
   * = the default) into the canonical channel and pinned version Core's `entitled` check reads.
   * Channel classification is Release's model, so it lives here, not in the consumer.
   */
  accessSelector(selector: string | undefined): Promise<EntitledSelector>;
  /** Resolve a byte route's target against the truth store; `null` = nothing there. */
  resolve(q: CatalogResolveQuery): Promise<CatalogResolution | null>;
  /**
   * Stream bytes from GitHub (see `CatalogSourceRef`). `null` means "not at this location": the
   * caller tries its next one or answers not-found. Release maps its own upstream failures — a
   * withdrawn release is `null` (or a 404 for `dl`), an exhausted GitHub quota is a 503 with
   * `Retry-After` — so the caller never sees a Release error type. The answer is not hardened;
   * the caller's pipeline does that.
   */
  openSource(ref: CatalogSourceRef, req: Request): Promise<Response | null>;
  /**
   * The rendered `install.sh` for this product, pointed at `origin` (scheme + host), or `null`
   * when there is no configuration or a value falls outside the renderer's safe character
   * classes (R6-01). The template and the binary name are Release's data.
   */
  installScript(origin: string): Promise<string | null>;
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

/** The states an outlet rollout can be in (P2b-04, README §3.9). */
export type RolloutState = "active" | "paused" | "halted" | "complete";

/**
 * One outlet rollout: release R of deliverable D on outlet O's channel C, offered to
 * `rolloutBp / 10000` of the fleet. The device evaluates its own bucket,
 * `u32(sha256(salt ‖ installId)[0..4]) mod 10000` (README §3.6); the Worker never does.
 */
export interface RolloutRecord {
  deliverableId: string;
  outletId: string;
  channel: string;
  releaseId: string;
  /** 0–10000. */
  rolloutBp: number;
  /** 16 random bytes, hex; fresh for every new release. */
  rolloutSalt: string;
  state: RolloutState;
  /** True when a store connector owns the row (P5-02/P5-03); direct edits are refused. */
  mirrored: boolean;
  /** `admin`, `ci`, a connector kind (`asc`, `play`, `ms-store`) or `auto-halt`. */
  source: string;
  startedAt: number;
  updatedAt: number;
  updatedBy: string;
}

/**
 * Distribution's read-only view of how releases reach devices and outlets (README §3.2).
 * P2b-01 shipped it with no outlets (the default transport, empty availability); P2b-04 adds
 * rollouts, delivery access and delivery URLs. P2b-03 fills availability.
 */
export interface Delivery {
  /** The transport a deliverable uses on an outlet that names none. */
  defaultTransport: TransportId;
  /** Availability records for one deliverable, optionally narrowed to one release. */
  availability(
    deliverableId: string,
    releaseId?: string,
  ): Promise<AvailabilityRecord[]>;
  /** The rollout on one outlet's channel for a deliverable, or `null` when there is none. */
  rollout(q: {
    deliverable: string;
    outlet: string;
    channel: string;
  }): Promise<RolloutRecord | null>;
  /**
   * Who may download a deliverable (`dist_access`): its own row, else the `app` row, else
   * `public`. The ONE answer the byte routes, the appcast and the portal all read (README §3.5).
   */
  accessMode(deliverable: string): Promise<ReleaseAccess>;
  /**
   * The canonical, immutable URL of one release file (`name`) or of a build's payload
   * (`buildId`), both minted as `…/files/<releaseId>/<name>` — pinned to the release by id, never
   * to its stored version, which can be a channel-like tag (`latest`) a `builds/<selector>` URL
   * would re-read as moving (P2-05's fixedVersion rule). On the bytes host when `BLOB_ORIGIN` is
   * set, else a path on this origin. `null` when the release, file, build or build payload does
   * not exist, when the payload's name is not the one the `files` route serves for that name, or
   * when `outlet` delivers the deliverable by a transport other than `pkey-cdn` (the bytes are
   * not ours to serve there).
   */
  deliveryUrl(q: {
    releaseId: string;
    buildId?: string;
    name?: string;
    outlet?: string;
  }): Promise<string | null>;
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
  /** Without its signing key (least privilege): no hook signs anything, and the bytes host and
   *  the portal build hooks from the key-free loader. */
  product: ProductPublic;
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
