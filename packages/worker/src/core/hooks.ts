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
 *   - `delivery`            (implemented by Distribution): transports, availability and
 *                            submissions (P2b-03), outlet rollouts and halts, delivery access and
 *                            delivery URLs (P2b-04), and the signing-key inventory (P2b-03);
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
 * delivery URLs to `Delivery`; P2b-02 implements `outletCapabilities`; P2b-03 added availability,
 * submissions and the key inventory; P4-02 added the pack functions to `ReleaseCatalog` and the
 * delivery gate (`entitlement`) to `Delivery`; P4-14 added `rollouts` and `reportedAvailability` to
 * `Delivery` and the optional `packChunks` hook point to `ReleaseCatalog` (P4-22 implements it);
 * P4-18 added the optional `packPayload` (Distribution's payload URL).
 * P2b-05, P2b-06, P3-03, P4-02 (Release's publish routes read `delivery.entitlement`), P4-05,
 * P4-09, P4-14 (Core's blob collector reads both hooks) and P6-03 consume.
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

/** A release as a channel's history lists it (`ReleaseCatalog.channelReleases`, P2b-05). */
export interface CatalogChannelRelease extends CatalogRelease {
  title: string | null;
  /** The release notes, as stored (Markdown or plain text); `null` when there are none. */
  notes: string | null;
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
  /**
   * The descriptor's `builds[].metadata` (P2b-05): an IPA's bundle identifier, versions and
   * permissions, or an APK's package name, version code, ABIs and signer — what CI extracted, in
   * `@polaris-key/manifest`'s `IosBuildMetadata` / `AndroidBuildMetadata` shape. `null` when the
   * descriptor carried none (and on every row it did not write).
   */
  metadata: Record<string, unknown> | null;
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
  /**
   * The descriptor's per-artifact facts that the release record does not carry
   * (`release_artifacts.metadata_json`): today a `delta`'s `deltaFrom` (P3-09). `null` when there
   * are none.
   */
  metadata: Record<string, unknown> | null;
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

// ── Packs (P4-02, plans/P4-01.md §6) ─────────────────────────────────────────────────────────

/** A declared pack deliverable (the persisted `.pkey/release` declaration, defaults filled). */
export interface CatalogPackDeliverable {
  id: string;
  /** `godot.pck` | `files.tree` in v1. */
  packType: string;
  /** `pinned` in v1. */
  binding: string;
  /** `embedded` | `none`. */
  baseline: string;
  required: boolean;
  /** `essential` | `prefetch` | `on-demand`. */
  delivery: string;
  /** Every variant key the declaration allows (`""` for an unvaried pack). */
  variantKeys: string[];
  /** The licence flag `.pkey/release` ASSERTS, or null. Never the gate (that is
   *  `Delivery.entitlement`, operator-owned). */
  assertedEntitlement: string | null;
}

/** One object of a pack release's variant, as its signed record names it. */
export interface CatalogPackObject {
  /** `PACK_OBJECT_ROLES`: `payload` (the `full` object), `files-index`, `files-gaps`, `delta`,
   *  `patch`, `patch-data`, `chunk-index` (P4-22). */
  role: string;
  /** SHA-256 and length of the STORED bytes (the blob route's ETag and Repr-Digest). */
  sha256: string;
  bytes: number;
  /** The blob-store key (`gated/` for a gated pack). */
  key: string;
  /** The decoded size and codec, when the ref carries them; a delta's base and memory. */
  meta: Record<string, unknown>;
}

/** One variant of a pack release. */
export interface CatalogPackVariant {
  /** The variant key; `""` for none. */
  variantKey: string;
  /** Its `release_builds.build_id`: the variant key, `default` for none. */
  buildId: string;
  variant: Record<string, string>;
  payload: { size: number; sha256: string };
  /** `requires.engine`, or null. */
  engine: string | null;
  objects: CatalogPackObject[];
}

/** A pack release, from its stored signed record. */
export interface CatalogPackRelease {
  release: CatalogRelease;
  /** The record's hash: what an app release pins. */
  recordSha256: string;
  /** P4-19: the hash of the delegation a content key signed the record under, or null when a
   *  release key signed it (plans/P4-19.md §6.1). */
  delegation: string | null;
  type: string;
  formatVersion: number;
  /** The record's `entitlement` (the gate CI signed at publish), or null. */
  entitlement: string | null;
  handler: {
    mountOrder?: number;
    prefixes?: string[];
    activation?: string;
  } | null;
  variants: CatalogPackVariant[];
}

/** One file of a pack variant, from its files index. */
export interface CatalogPackFile {
  path: string;
  size: number;
  sha256: string;
  /** Container layout only. */
  offset: number | null;
  blob: { sha256: string; bytes: number; codec: string; key: string };
}

/** One build of an app release with its `embeds` (`ReleaseCatalog.embedsOf`, P4-05). */
export interface CatalogBuildEmbeds {
  releaseId: string;
  buildId: string;
  platform: string | null;
  /** The packs the build embeds, or null when its descriptor said nothing. */
  embeds: string[] | null;
}

/** One pin: app release → the exact pack release it pins (a mirror of the signed `content`). */
export interface CatalogPin {
  appReleaseId: string;
  pack: string;
  packReleaseId: string;
  /** The pinned pack record's hash. */
  recordSha256: string;
  /** The app release's `expects` entry for the pack. */
  required: boolean;
  delivery: string;
}

/** One live contentApi level of an app deliverable on a channel (P4-12). */
export interface CatalogLiveLevel {
  contentApi: number;
  /** The live app releases at this level, newest first. */
  appReleases: string[];
}

/** One resolved pack set (P4-12, `release_sets`): a selector and the releases it resolves. */
export interface CatalogPackSet {
  channel: string;
  appDeliverable: string;
  contentApi: number;
  platform: string;
  /** The engine of the live builds it serves; `""` for builds that declare none. */
  engine: string;
  /** The variant key over this row's group's axes; `""` for a group without axes. A device's
   *  set is one row per group: the row its own variant projects onto. */
  variant: string;
  /** client-core's `packSetId` over the members: identical sets share it. */
  packSetId: string;
  packs: {
    pack: string;
    releaseId: string;
    version: string;
    seq: number;
    /** The pack record's hash. */
    sha256: string;
  }[];
  /** Packs no release satisfies at this selector (`content-floor`, `dependency`, …). P4-13
   *  freezes the wire form. */
  unsatisfied: { pack: string; reason: string; detail: string }[];
  resolvedAt: number;
}

/** A pack floor for one contentApi line (P4-12, `release_pack_floors`). */
export interface CatalogPackFloor {
  deliverableId: string;
  channel: string;
  contentApi: number;
  /** The lowest version that resolves for this line. */
  minSupported: string;
  modifiedAt: number;
}

/** One hold: an app release keeping a compatible pack at one release (P4-12, a mirror of the
 *  signed `content.holds`). */
export interface CatalogHold {
  appReleaseId: string;
  pack: string;
  packReleaseId: string;
  recordSha256: string;
  reason: string | null;
}

/**
 * One revocation in force (P4-13, `release_revocations`): the CURRENT CI-signed `kind: revocation`
 * record of one revoked pack release, with the target's version and `seq` (the record's own) and
 * the replacement it names. A superseding revocation replaces it in place; none is ever removed.
 */
export interface CatalogRevocation {
  /**
   * `record` (absent: P4-13's revocation of one pack release) or, from P4-19, `delegation` (whose
   * target is a delegation hash, not a release). A consumer that reads `targetReleaseId` as a
   * release must ignore every other kind.
   */
  kind?: "record" | "delegation";
  /** The revoked pack's id. */
  deliverableId: string;
  targetReleaseId: string;
  /** The revoked pack record's hash. */
  targetSha256: string;
  /** The revocation record's hash (served on the record route). */
  recordSha256: string;
  /** The target's version and `seq`. */
  version: string;
  seq: number;
  kid: string;
  replacement: { releaseId: string; sha256: string } | null;
  reason: string;
  issuedAt: number;
  ingestedAt: number;
  /** P4-19, `kind: "delegation"` only: the pack releases signed under the revoked delegation
   *  (yanked by its ingest, reason `delegation-revoked`); never live for the blob collector. */
  delegatedReleaseIds?: string[];
}

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
  /** One release by id, whatever its deliverable, or null (one read; P4-05). */
  release(releaseId: string): Promise<CatalogRelease | null>;
  /** A release's builds, by build id. */
  builds(releaseId: string): Promise<CatalogBuild[]>;
  /** A release's artifact records, with where their bytes live; narrowed to one build when
   *  `buildId` is given. */
  artifacts(
    releaseId: string,
    buildId?: string,
  ): Promise<CatalogSourceArtifact[]>;
  /** Channel policy, for one deliverable or (omitted) all of them. */
  channelPolicies(deliverableId?: string): Promise<CatalogChannelPolicy[]>;
  /** Every yank, newest first. */
  yanks(): Promise<CatalogYank[]>;
  /**
   * Every release of `deliverableId` that `channel` may serve, NEWEST FIRST in the channel's own
   * order (P2b-05): Release's resolution rules — membership in the channel or a channel it
   * includes, yanks removed except a pinned pointer, at or below a pinned pointer — with no
   * per-platform filter. `null` when the deliverable or the channel name does not exist; `[]`
   * when it exists and serves nothing. The storefront feeds list this history.
   */
  channelReleases(
    deliverableId: string,
    channel: string,
  ): Promise<{ channel: string; releases: CatalogChannelRelease[] } | null>;
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
  /**
   * The channels the product can serve (P6-03): the built-ins, its manual rules and any channel
   * an `app` release was published to — Release's one definition (`knownChannels`). Read-only;
   * Core's report path bounds update telemetry with it.
   */
  knownChannels(): Promise<string[]>;

  // ── Packs (P4-02): what P4-05 serves, P4-09 shows and update reads ──
  /** The declared pack deliverables, by id. */
  packDeliverables(): Promise<CatalogPackDeliverable[]>;
  /** One pack release with its variants and the objects its record names, or null. */
  packRelease(
    deliverableId: string,
    releaseId: string,
  ): Promise<CatalogPackRelease | null>;
  /**
   * The files of one variant of a pack release, read from its files index in the blob store and
   * decoded (one index per call, at most `MAX_PUBLISHED_INDEX_BYTES`; a caller walking many
   * releases drops each before the next). Null when the release, the variant or its readable
   * index does not exist.
   */
  packFiles(
    releaseId: string,
    variantKey: string,
  ): Promise<CatalogPackFile[] | null>;
  /** What app release `appReleaseId` pins, by pack id. */
  pins(appReleaseId: string): Promise<CatalogPin[]>;
  /** Which app releases pin pack release `packReleaseId`, by app release id. */
  pinnedBy(packReleaseId: string): Promise<CatalogPin[]>;
  /** The packs build `buildId` of app release `appReleaseId` embeds, or null when its
   *  descriptor said nothing (or there is no such build). */
  embeds(appReleaseId: string, buildId: string): Promise<string[] | null>;

  // ── Pack sets (P4-12): what P4-13 composes the feed from, P4-14 checks and P4-15 shows ──
  /** The live contentApi levels of `appDeliverable` on `channel` (every non-yanked app release
   *  the channel serves at or above its floor), ascending. `[]` for an unknown channel. */
  liveLevels(
    appDeliverable: string,
    channel: string,
  ): Promise<CatalogLiveLevel[]>;
  /** The stored resolved sets of `channel` (canonicalised: `staging` is `beta`), by selector.
   *  Empty after a failed resolution, which clears them (fail closed). */
  packSets(channel: string): Promise<CatalogPackSet[]>;
  /** The pack floors per contentApi line on `channel` (canonicalised), by pack then level. A level-free floor is
   *  the pack's `channelPolicies` `minSupported`. */
  packFloors(channel: string): Promise<CatalogPackFloor[]>;
  /** What app release `appReleaseId` holds, by pack id. */
  holdsFor(appReleaseId: string): Promise<CatalogHold[]>;
  /** Which app releases hold pack release `packReleaseId` (live references for GC). */
  heldBy(packReleaseId: string): Promise<CatalogHold[]>;
  /**
   * The pins of every pack release in `packReleaseIds`, in bulk (P4-05: availability reads them
   * for a page of pack releases in a bounded number of queries). By pack release, then app release.
   */
  pinnedByMany(packReleaseIds: readonly string[]): Promise<CatalogPin[]>;
  /**
   * Every build of every app release in `appReleaseIds`, with its `embeds`, in bulk (P4-05). By
   * release, then build.
   */
  embedsOf(appReleaseIds: readonly string[]): Promise<CatalogBuildEmbeds[]>;
  /**
   * Every revocation in force (P4-13), by revoked pack, then target `seq`: what the channel feed
   * lists, P4-14 excludes from GC's live references and P4-15 shows.
   */
  revocations(): Promise<CatalogRevocation[]>;

  // ── Chunk bundles (P4-10 decision 16; P4-22 implements it) ──
  /**
   * The chunks one variant of a pack release reads from chunk bundles, decoded from its stored
   * chunk index (one index per call, at most `MAX_PUBLISHED_INDEX_BYTES`; a caller walking many
   * releases drops each before the next): one entry per stored location, duplicate ids sharing
   * one. Null when the release, the variant, its `chunks` or its readable index does not exist.
   *
   * Release implements it (`services/release/packs/catalog.ts`, P4-22). It stays optional in the
   * type so the collector (`core/blobGc.ts`) still fails closed against a catalog without it: it
   * then KEEPS every ref to a key under `bundles/` and the bundle live-data ratio reads `null`.
   */
  packChunks?(
    releaseId: string,
    variantKey: string,
  ): Promise<CatalogPackChunk[] | null>;

  // ── The payload URL (P4-18) ──
  /**
   * The newest pack release of `deliverableId` whose variant `buildId` is a `container` payload
   * with SHA-256 `payloadSha256` (the DECODED payload), with its `full` object and the
   * `zstd-patch-from` payload deltas TO it, by base. Null when no such release is among the
   * pack's newest `MAX_PAYLOAD_SCAN` releases, or the payload is a tree (a tree's
   * `payload.sha256` is its `treeDigest`, never the hash of a response body).
   *
   * Distribution's payload URL (`/<p>/distribution/packs/<pack>/<variant>/payload/<sha256>`)
   * reads it. Optional so a catalog without it answers the payload URL's plain not-found, and
   * the SDK takes the blob route.
   */
  packPayload?(
    deliverableId: string,
    buildId: string,
    payloadSha256: string,
  ): Promise<CatalogPackPayload | null>;
}

/** One container payload of a pack release, by its decoded SHA-256 (`packPayload`, P4-18). */
export interface CatalogPackPayload {
  releaseId: string;
  /** The record's `entitlement` is set: its objects are under `gated/`. */
  gated: boolean;
  payload: { size: number; sha256: string };
  /** The `full` object ref: one zstd frame (`codec: zstd`) or the payload raw (`none`). */
  full: { sha256: string; bytes: number; size: number; codec: string };
  /** The variant's `scope: payload` deltas whose method is `zstd-patch-from`, in record order. */
  deltas: { from: string; artifact: { sha256: string; bytes: number } }[];
}

/** One chunk a pack variant reads from a chunk bundle (`ReleaseCatalog.packChunks`, P4-22). */
export interface CatalogPackChunk {
  /**
   * The bundle's blob-store key. A pack's bundles are blobs (plans/P4-10.md decision 4):
   * `blobs/sha256/<hex>`, or under `gated/`; P2-01's `bundles/` keys stay unused by packs.
   */
  bundleKey: string;
  /** The chunk's byte offset in the bundle (a chunk is identified by bundle and offset). */
  offset: number;
  /** The chunk's stored length in the bundle. */
  bytes: number;
}

// ── delivery (Distribution) ─────────────────────────────────────────────────────────────────

/**
 * How bytes arrive (README §3.1 "transport"). Open-ended on purpose: the list grows with each
 * outlet package, and a closed union here would make every addition a Core change.
 */
export type TransportId = string;

/** The transport every deliverable uses when no outlet says otherwise: our own CDN. */
export const DEFAULT_TRANSPORT: TransportId = "pkey-cdn";

/**
 * "Release R (build B) of deliverable D is <state> on outlet O since T" (README §3.1
 * "availability"). P2b-03 sets the vocabulary (`AVAILABILITY_STATES` in
 * `services/distribution/availability.ts`): `pending`, `processing`, `in-review`, `approved`,
 * `live`, `rejected`, `removed`. A stored value outside it reads as `pending` (never `live`).
 */
export interface AvailabilityRecord {
  deliverableId: string;
  releaseId: string;
  /** The build the record is about; `''` when it is per release. */
  buildId: string;
  outletId: string;
  transport: TransportId;
  state: string;
  /** Epoch seconds the record entered `state`; `null` for a derived record whose release never
   *  said when it was published. */
  since: number | null;
  /** Store-assigned ids (ASC build id, Play version code, Steam depot manifest); never in Release. */
  platformRef: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
  /** `ci`, `admin`, a connector kind (`asc`, `play`, `ms-store`), or `derived`. */
  source: string;
  /**
   * True when no row says so and the answer is DERIVED from Release's truth: a self-hosted outlet
   * delivering the deliverable by `pkey-cdn`, `embedded` or `web`, with a matching build whose
   * bytes have a stored or GitHub location, is `live` without a report.
   */
  derived: boolean;
  /** Epoch seconds of the last write; `null` for a derived record. */
  updatedAt: number | null;
}

/**
 * Where release R stands in outlet O's submission (review) lifecycle (P2b-03). States:
 * `prepared`, `submitted`, `in-review`, `approved`, `rejected`, `pending-developer-release`,
 * `released`, `cancelled` (`SUBMISSION_STATES`); P5's connectors map store states onto them.
 */
export interface SubmissionRecord {
  deliverableId: string;
  releaseId: string;
  outletId: string;
  state: string;
  /** Epoch seconds the submission last entered `submitted`, or `null`. */
  submittedAt: number | null;
  /** Epoch seconds it last entered `approved` or `rejected`, or `null`. */
  reviewedAt: number | null;
  detail: Record<string, unknown> | null;
  source: string;
  updatedAt: number;
}

/**
 * One OPERATOR-owned signing-key inventory entry (P2b-03, `dist_keys`): what players, the download
 * page, F-Droid clients and AppVerifier check a download against. A CI report can never create
 * or change one; a CI-observed fingerprint that is not in the inventory is an observation, never
 * an entry, and only raises `flagged` on the entries of its purpose.
 */
export interface KeyRecord {
  /** `KEY_PURPOSES`: `android-app-signing`, `android-upload`, `android-sideload`,
   *  `fdroid-repo`, `sparkle-ed25519`, `release`, `msix-publisher`. */
  purpose: string;
  /** Lower-case hex SHA-256 of the certificate (or of the raw public key for Ed25519). */
  sha256: string;
  /** The outlet the key is for, when it is outlet-specific. */
  outletId: string | null;
  notes: string | null;
  /** The operator's record that it is registered for Android developer verification. */
  registered: boolean;
  registeredAt: number | null;
  /** The last time CI reported signing with this exact key, or `null`. */
  observed: KeyObservation | null;
  /** True when CI has reported a DIFFERENT fingerprint for this purpose that is not in the
   *  inventory: an operator should look. */
  flagged: boolean;
}

/** One CI observation of a fingerprint (`dist_keys.observed_json`). */
export interface KeyObservation {
  /** Epoch seconds. */
  at: number;
  /** The audit actor, `ci:<subject>`. */
  by: string;
  outletId: string | null;
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
 * One of the product's LIVE outlets as the signed feed composes it (P3-03): its product outlet
 * id, its kind, the identity fields `.pkey/distribution` declared (P2b-02's normalised identity:
 * `appleId`, `packageName`, `platforms`, …) and whether an operator narrowed its capabilities.
 */
export interface DeliveryOutlet {
  outletId: string;
  kind: string;
  identity: Record<string, unknown>;
  /** True when an operator owns a capability narrowing (`outletCapabilities` answers it). */
  narrowed: boolean;
}

/**
 * What one feed lists (P2b-05's selection, `services/distribution/feeds/select.ts`, offered to
 * Update's app-updater feeds through `Delivery.feedSelection`, P3-09). Declarative on purpose: a
 * hook answers questions about state with plain data, so the filters are values, not callbacks.
 */
export interface FeedSelectionQuery {
  /** The REQUESTED channel name; the answer carries the canonical one. */
  channel: string;
  /** The request's origin: a delivery URL minted as a path (no bytes host) is made absolute. */
  origin: string;
  /** Outlet kinds that may carry the feed (the outlet whose id is a kind wins, else the first). */
  kinds: readonly string[];
  /** `?outlet=<id>`: one specific live outlet of those kinds. */
  outletId?: string | null;
  /** The platform the feed's builds target. */
  platform: string;
  /** Keep only builds of these arches; omitted keeps every arch. */
  arches?: readonly string[];
  /** Keep only these build ids (artifact-map ids); omitted keeps every build. */
  buildIds?: readonly string[];
  /** Keep only builds whose payload name ends with one of these (ASCII case-insensitive). */
  payloadSuffixes?: readonly string[];
  /** Consider only these releases (P3-09: the ones with a stored release record). */
  releaseIds?: readonly string[];
  /** `availability`: live on the outlet; `bytes`: our payload exists (P2b-05 step 3). */
  liveness: "availability" | "bytes";
  /** The most releases listed (default 20). */
  limit?: number;
  /** Every matching build of a release rather than the first. */
  allBuilds?: boolean;
  /**
   * `hold` (the default, P2b-05 step 4): a release whose rollout on the outlet is not complete is
   * held back and the previous release listed. `phase` (Sparkle, which phases on the client): a
   * release in an ACTIVE rollout above 0 bp is listed and carries its rollout; paused, halted and
   * 0 bp still hold.
   */
  rollouts?: "hold" | "phase";
  /** Also return each listed build's other artifacts (deltas, signatures, sidecars). */
  withArtifacts?: boolean;
}

/** One artifact of a listed build, with its immutable delivery URL (`null` when it has none). */
export interface FeedSelectionArtifact extends CatalogSourceArtifact {
  url: string | null;
}

/** One listed release: the release, the outlet's build of it, and that build's payload. */
export interface FeedSelectionEntry {
  releaseId: string;
  version: string;
  publishedAt: number | null;
  title: string | null;
  /** `null` also when the product's metadata is not public. */
  notes: string | null;
  buildId: string;
  platform: string | null;
  arch: string;
  format: string | null;
  buildNumber: string | null;
  minOs: string | null;
  metadata: Record<string, unknown> | null;
  /** The payload's file name, digest, size and absolute immutable URL. */
  name: string;
  sha256: string | null;
  size: number | null;
  url: string;
  payload: CatalogSourceArtifact;
  /** The rollout this release is listed under (`rollouts: "phase"` only), else `null`. */
  rollout: { bp: number; salt: string; startedAt: number } | null;
  /** The build's other artifacts (`withArtifacts` only), else empty. */
  artifacts: FeedSelectionArtifact[];
}

/** A feed's selection: the canonical channel, the outlet it is rendered for, its entries. */
export interface FeedSelection {
  channel: string;
  outlet: {
    id: string;
    kind: string;
    identity: Record<string, unknown>;
    listing: Record<string, unknown> | null;
  };
  entries: FeedSelectionEntry[];
  notesPublic: boolean;
}

/**
 * Distribution's read-only view of how releases reach devices and outlets (README §3.2).
 * P2b-01 shipped it with no outlets (the default transport, empty availability); P2b-04 added
 * rollouts, delivery access and delivery URLs; P2b-03 added availability, submissions and the key
 * inventory; P3-03 added the outlet list.
 */
export interface Delivery {
  /** The transport a deliverable uses on an outlet that names none. */
  defaultTransport: TransportId;
  /**
   * Availability of one release on each of the product's LIVE outlets: the stored records (CI
   * reports, later connectors), plus the derived `live` records of self-hosted outlets (see
   * `AvailabilityRecord.derived`). A stored record for (release, build, outlet) — or a per-release
   * one for (release, outlet) — wins over the derived answer. Ordered by outlet, then build.
   * Empty for a release Release does not know.
   */
  availability(releaseId: string): Promise<AvailabilityRecord[]>;
  /** The submission records of one release on the product's live outlets, by outlet. */
  submissions(releaseId: string): Promise<SubmissionRecord[]>;
  /** The key inventory (operator entries only), optionally narrowed to one purpose. */
  keys(q?: { purpose?: string }): Promise<KeyRecord[]>;
  /** The product's live outlets, by id (P3-03, the signed feed's outlet entries). */
  outlets(): Promise<DeliveryOutlet[]>;
  /** The rollout on one outlet's channel for a deliverable, or `null` when there is none. */
  rollout(q: {
    deliverable: string;
    outlet: string;
    channel: string;
  }): Promise<RolloutRecord | null>;
  /**
   * Who may download a deliverable (`dist_access`): its own row, else the `app` row, else
   * `entitled` (fail-closed: no row never reads as open). The ONE answer the byte routes, the
   * appcast and the portal all read (README §3.5).
   */
  accessMode(deliverable: string): Promise<ReleaseAccess>;
  /**
   * The delivery GATE of one deliverable (P4-02, plans/P4-01.md decision 35): the licence flag in
   * the `entitlement` of the deliverable's OWN `dist_access` row, never the `app` row's (a pack
   * row is operator-owned from the start, P2b-04), or `null` when the deliverable is ungated.
   * Release's publish routes read it: the uploads preflight reports it to CI, the stage round
   * holds every staged object's `gated` flag to it, and pack ingest refuses a record whose
   * `entitlement` differs. Reads `dist_access` alone, never `releaseCatalog`, so the two hooks
   * never call each other.
   */
  entitlement(deliverable: string): Promise<string | null>;
  /**
   * The canonical, immutable URL of one release file (`name`) or of a build's payload
   * (`buildId`), both minted as `…/files/<releaseId>/<name>` — pinned to the release by id, never
   * to its stored version, which can be a channel-like tag (`latest`) a `builds/<selector>` URL
   * would re-read as moving (P2-05's fixedVersion rule). On the bytes host when `BLOB_ORIGIN` is
   * set, else a path on this origin. `null` when the release, file, build or build payload does
   * not exist, when the payload's name is not the one the `files` route serves for that name, when
   * the release is not the app's (`files` serves the app deliverable only; a pack's objects are
   * reached by SHA-256 on the blob route, P4-05), or when `outlet` delivers the deliverable by a
   * transport other than `pkey-cdn` (the bytes are not ours to serve there).
   */
  deliveryUrl(q: {
    releaseId: string;
    buildId?: string;
    name?: string;
    outlet?: string;
  }): Promise<string | null>;
  /**
   * P3-09: the releases one feed lists (`FeedSelectionQuery`), by P2b-05's rules: the channel's
   * history from Release, a build for the outlet, live on it, not yanked, not held by a rollout,
   * with an immutable delivery URL. ACCESS IS NOT CHECKED: the caller has enforced the delivery
   * access first (Update's feed routes, through the release gateway's access rule). `null` = no
   * such channel or outlet, or nothing to read; an existing feed with nothing to list is empty.
   */
  feedSelection(q: FeedSelectionQuery): Promise<FeedSelection | null>;
  /**
   * P3-09: a stamp of the delivery state a feed must follow at once (P2b-05's `feedStateStamp`:
   * rollouts, yanks, availability, outlets, registered feed files, whether notes are public), for
   * a feed cache key. `null` when Release is off.
   */
  feedStamp(): Promise<string | null>;
  /**
   * P4-13: every stored transport row (`dist_transports`) of a LIVE outlet — which transport
   * carries each deliverable on each outlet — by deliverable, then outlet. A (deliverable, outlet)
   * with no row uses `defaultTransport`. Update narrows a pack whose transport cannot float
   * (`TRANSPORT_FLOATS`) to pinned on that outlet.
   */
  transports(): Promise<
    { deliverable: string; outlet: string; transport: TransportId }[]
  >;
  /**
   * P4-14: every outlet rollout of the product (`dist_rollouts`), any deliverable and any state, by
   * deliverable, then outlet, then channel. Update composes a pack's per-outlet gates from it, and
   * Core's blob collector keeps every release a rollout names (and its fallback).
   */
  rollouts(): Promise<RolloutRecord[]>;
  /**
   * P4-14: every STORED availability record (CI reports, store connectors) of the product, on live
   * and removed outlets alike, as (release, outlet, state). Derived records are not included: they
   * are computed from the blob store, so counting them would let an object keep itself alive.
   * Core's blob collector keeps every pack release an outlet lists in a state other than
   * `rejected` or `removed`.
   */
  reportedAvailability(): Promise<
    { releaseId: string; outletId: string; state: string }[]
  >;
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
