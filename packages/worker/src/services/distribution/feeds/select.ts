/**
 * Which releases a storefront feed lists (P2b-05, README §3.8): for outlet O and channel C,
 *
 *   1. the releases C serves, newest first, by Release's own rules (`releaseCatalog.
 *      channelReleases`: membership in C or a channel it includes — beta includes stable — yanks
 *      removed except a pinned pointer, at or below a pinned pointer);
 *   2. that have a build for O: O's artifact-map id when its identity names one, else a build of
 *      the feed's platform (and, for a `direct` outlet with `platforms`, a platform it offers);
 *   3. that are LIVE on O — the answer of `delivery.availability()`, where a self-hosted outlet
 *      is live by derivation and a store outlet (AltStore PAL) once reported — or, for a feed that
 *      tells a third party where OUR bytes are (`liveness: "bytes"`, Flathub's checker), whose
 *      payload we serve;
 *   4. that are not yanked, and not held back on O: these clients cannot bucket installs, so a
 *      release whose rollout on O is paused or halted, or active below 10000 bp, is left out until
 *      it completes — the previous release is listed instead; nor HELD by P4-14's readiness (its
 *      required pack set is not yet available through O's transport, `readiness.ts`);
 *   5. whose payload has an immutable delivery URL (the answer of `delivery.deliveryUrl`, on the
 *      bytes host when `BLOB_ORIGIN` is set).
 *
 * COST. These routes are public and unauthenticated, so the selection reads in bulk rather than
 * through the per-release hooks (`availability()` and `deliveryUrl()` each re-read every release
 * row of every deliverable): the outlet's stored availability rows and its transport ONCE, then
 * per scanned release its builds and its artifact records (with their locations) — two queries,
 * one when no build matches. A store outlet's releases with no live report cost nothing. At most
 * `MAX_FEED_SCAN` releases are scanned, so a selection stays a bounded, small number of D1
 * queries whatever the history (`test/storefrontFeeds.test.ts` holds a ceiling), and the routes
 * cache what they render (`cache.ts`). Steps 3 and 5 apply the hooks' rules (`availability.ts`'s
 * derived records, stored row winning; `delivery.ts`'s build branch); the test suite checks the
 * two agree.
 *
 * ACCESS. None of these clients can authenticate, so a feed exists only while the app
 * deliverable's delivery access (`dist_access`) is `public`; otherwise every feed route is the
 * plain not-found. Release notes appear only when the product's METADATA access is public too.
 *
 * Reads Release only through the catalog hook, and Distribution's own tables directly.
 */

import { parseJsonColumn, type Db, type Env } from "../../../core/platform.js";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import {
  DEFAULT_TRANSPORT,
  type CatalogBuild,
  type CatalogChannelRelease,
  type CatalogSourceArtifact,
  type Delivery,
  type FeedSelectionArtifact,
  type FeedSelectionEntry,
  type ReleaseCatalog,
  type ServiceHooks,
} from "../../../core/hooks.js";
import {
  DERIVED_OUTLET_KINDS,
  DERIVED_TRANSPORTS,
  hasServingLocation,
  outletMatches,
  transportOf,
} from "../availability.js";
import { fileDeliveryUrl } from "../delivery.js";
import { listOutlets, type DistOutletRow } from "../outlets.js";
import { FULL_ROLLOUT_BP, type DistRolloutRow } from "../rollouts.js";
import { readinessReader, type ReadinessReader } from "../readiness.js";
import type { RenderListing } from "./render.js";

/** The most versions a feed lists, and the most releases it reads to find them (newest first). */
export const MAX_FEED_VERSIONS = 20;
export const MAX_FEED_SCAN = 100;

export interface FeedReadContext {
  db: Db;
  product: { slug: string; name: string };
  hooks: ServiceHooks;
  /** The request's origin: a delivery URL minted as a path (no bytes host) is made absolute. */
  origin: string;
  /** For the bytes host (`BLOB_ORIGIN`) delivery URLs are minted on. */
  env: Env;
  /** P4-14's readiness reader, when the caller shares one (`delivery.ts`); else one is made. */
  readiness?: ReadinessReader;
}

/** The outlet a feed is rendered for. */
export interface FeedOutlet {
  id: string;
  kind: string;
  identity: Record<string, unknown>;
  listing: RenderListing | null;
}

export interface FeedSpec {
  /** Outlet kinds that may carry this feed (the first live one wins; see `pickOutlet`). */
  kinds: readonly string[];
  /** `?outlet=<id>`: one specific live outlet of those kinds. */
  outletId?: string | null;
  /** The platform the feed's builds target when the outlet names no artifact. */
  platform: string;
  /** See the file comment, step 3. */
  liveness: "availability" | "bytes";
  /** Stop after this many releases with a matching build (default `MAX_FEED_VERSIONS`). */
  limit?: number;
  /** All matching builds of each release (Scoop, Flathub) rather than the first. */
  allBuilds?: boolean;
  /** An outlet predicate beyond its kind (Scoop: a `direct` outlet covering Windows). */
  accepts?: (o: FeedOutlet) => boolean;
  // ── P3-09's app-updater feeds (`Delivery.feedSelection`) ──
  /** Keep only builds of these arches. */
  arches?: readonly string[];
  /** Keep only these build ids. */
  buildIds?: readonly string[];
  /** Keep only builds whose payload name ends with one of these (ASCII case-insensitive). */
  payloadSuffixes?: readonly string[];
  /** Consider only these releases (the ones with a stored release record). */
  releaseIds?: readonly string[];
  /** See `FeedSelectionQuery.rollouts` (`core/hooks.ts`). Default `hold`. */
  rollouts?: "hold" | "phase";
  /** Also return each listed build's other artifacts, with their delivery URLs. */
  withArtifacts?: boolean;
}

export interface FeedSelection {
  channel: string;
  outlet: FeedOutlet;
  entries: FeedSelectionEntry[];
  /** Release notes are public (the metadata access mode). */
  notesPublic: boolean;
}

function objectOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function feedOutlet(row: DistOutletRow): FeedOutlet {
  const listing = parseJsonColumn(row.listing_json);
  return {
    id: row.outlet_id,
    kind: row.kind,
    identity: objectOf(parseJsonColumn(row.identity_json)),
    listing:
      listing && typeof listing === "object" && !Array.isArray(listing)
        ? (listing as RenderListing)
        : null,
  };
}

/**
 * The live outlet a feed is rendered for: the one `outletId` names (it must be live and of one
 * of `kinds`), else the outlet whose id IS a kind, else the first live one by id. `null` when the
 * product has none.
 */
export async function pickOutlet(
  db: Db,
  product: string,
  spec: Pick<FeedSpec, "kinds" | "outletId" | "accepts">,
): Promise<FeedOutlet | null> {
  const live = (await listOutlets(db, product))
    .filter((o) => o.removed_at === null && spec.kinds.includes(o.kind))
    .map(feedOutlet)
    .filter((o) => !spec.accepts || spec.accepts(o));
  if (spec.outletId) return live.find((o) => o.id === spec.outletId) ?? null;
  return (
    live.find((o) => spec.kinds.includes(o.id)) ??
    live.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ??
    null
  );
}

/** Does `build` belong to `outlet`'s feed? (step 2) */
export function buildMatchesOutlet(
  outlet: FeedOutlet,
  build: CatalogBuild,
  platform: string,
): boolean {
  if (typeof outlet.identity.artifact === "string")
    return build.buildId === outlet.identity.artifact;
  if (build.platform !== platform) return false;
  const platforms = outlet.identity.platforms;
  if (outlet.kind === "direct" && Array.isArray(platforms))
    return platforms.includes(platform);
  return true;
}

/** A release's standing on the outlet's rollouts (step 4). */
interface RolloutStanding {
  held: Set<string>;
  /** `phase` mode: the releases listed while their rollout is active, and that rollout. */
  phased: Map<string, { bp: number; salt: string; startedAt: number }>;
}

/**
 * Releases held back on `outlet` (step 4): under `hold`, any rollout there that is not complete,
 * on any channel; under `phase`, a paused or halted one on any channel, or one of `channel`'s own
 * active at 0 bp — `channel`'s own active rollout above 0 bp lists its release with THAT rollout,
 * for a client that phases itself (Sparkle). Another channel's active rollout never phases or
 * holds this channel's feed: dist_rollouts holds one row per (outlet, channel), and the signed
 * feed reads only the matching one (compose.ts).
 */
async function rolloutStanding(
  db: Db,
  product: string,
  outletId: string,
  mode: "hold" | "phase",
  channel: string,
): Promise<RolloutStanding> {
  const rows = await db.all<
    Pick<
      DistRolloutRow,
      | "release_id"
      | "rollout_bp"
      | "rollout_salt"
      | "state"
      | "started_at"
      | "channel"
    >
  >(
    `SELECT release_id, rollout_bp, rollout_salt, state, started_at, channel FROM dist_rollouts
      WHERE product = ? AND deliverable_id = ? AND outlet_id = ?`,
    product,
    APP_DELIVERABLE_ID,
    outletId,
  );
  const held = new Set<string>();
  const phased = new Map<
    string,
    { bp: number; salt: string; startedAt: number }
  >();
  for (const r of rows) {
    const done =
      r.state === "complete" ||
      (r.state === "active" && r.rollout_bp >= FULL_ROLLOUT_BP);
    if (done) continue;
    if (mode === "phase" && r.state === "active") {
      // Only the rendered channel's own row phases (or, at 0 bp, holds) its release.
      if (r.channel !== channel) continue;
      if (r.rollout_bp > 0) {
        phased.set(r.release_id, {
          bp: r.rollout_bp,
          salt: r.rollout_salt,
          startedAt: r.started_at,
        });
        continue;
      }
    }
    held.add(r.release_id);
  }
  for (const id of held) phased.delete(id);
  return { held, phased };
}

/** The readers a feed needs, or `null` (= not-found) when the product cannot serve one. */
export async function feedReaders(ctx: FeedReadContext): Promise<{
  catalog: ReleaseCatalog;
  delivery: Delivery;
  notesPublic: boolean;
} | null> {
  const catalog = ctx.hooks.releaseCatalog();
  const delivery = ctx.hooks.delivery();
  if (!catalog || !delivery) return null;
  const metadata = await catalog.metadataAccess();
  if (metadata === null) return null;
  // No client of these feeds can authenticate: a non-public deliverable has no feed at all.
  if ((await delivery.accessMode(APP_DELIVERABLE_ID)) !== "public") return null;
  return { catalog, delivery, notesPublic: metadata === "public" };
}

/** What step 3 reads once per selection: the outlet's reports and whether it derives `live`. */
interface OutletLiveness {
  /** Stored availability rows on the outlet, by release: build (`''` = every build) → live. */
  reports: Map<string, { buildId: string; live: boolean }[]>;
  /** A self-hosted outlet kind over a derived transport: live wherever our bytes are. */
  derives: boolean;
}

async function outletLiveness(
  db: Db,
  product: string,
  outlet: FeedOutlet,
  transport: string,
): Promise<OutletLiveness> {
  const rows = await db.all<{
    release_id: string;
    build_id: string;
    state: string;
  }>(
    `SELECT release_id, build_id, state FROM dist_availability
      WHERE product = ? AND outlet_id = ?`,
    product,
    outlet.id,
  );
  const reports = new Map<string, { buildId: string; live: boolean }[]>();
  for (const r of rows) {
    const list = reports.get(r.release_id) ?? [];
    // A state outside the vocabulary reads as `pending` (availability.ts): only `live` counts.
    list.push({ buildId: r.build_id, live: r.state === "live" });
    reports.set(r.release_id, list);
  }
  return {
    reports,
    derives:
      DERIVED_OUTLET_KINDS.includes(outlet.kind) &&
      DERIVED_TRANSPORTS.includes(transport),
  };
}

/**
 * Is `build` of `releaseId` live on the outlet? `availability()`'s answer: a stored report of the
 * build or of the whole release wins (live only if one says `live`); without one, a self-hosted
 * outlet derives `live` for a matching build whose payload has its bytes.
 */
function isLive(
  l: OutletLiveness,
  outlet: FeedOutlet,
  releaseId: string,
  build: CatalogBuild,
  payload: CatalogSourceArtifact,
): boolean {
  const reports = (l.reports.get(releaseId) ?? []).filter(
    (r) => r.buildId === "" || r.buildId === build.buildId,
  );
  if (reports.length) return reports.some((r) => r.live);
  return (
    l.derives &&
    outletMatches(
      outlet.kind,
      outlet.identity,
      build.buildId,
      build.platform,
    ) &&
    hasServingLocation(payload)
  );
}

/**
 * Select the entries of one feed (see the file comment). `null` = the route's not-found: the
 * product cannot serve a public feed, the channel does not exist, or there is no such outlet.
 * An existing feed with nothing to list is an empty selection, not `null`.
 */
export async function selectFeed(
  ctx: FeedReadContext,
  rawChannel: string,
  spec: FeedSpec,
): Promise<FeedSelection | null> {
  const readers = await feedReaders(ctx);
  if (!readers) return null;
  return selectFeedWith(ctx, readers, rawChannel, spec);
}

/**
 * `selectFeed` without the public-access rule: the caller has decided access itself
 * (`Delivery.feedSelection`, P3-09, whose callers run the release gateway's access check).
 */
export async function selectFeedWith(
  ctx: FeedReadContext,
  readers: { catalog: ReleaseCatalog; notesPublic: boolean },
  rawChannel: string,
  spec: FeedSpec,
): Promise<FeedSelection | null> {
  const { catalog, notesPublic } = readers;
  const slug = ctx.product.slug;
  const outlet = await pickOutlet(ctx.db, slug, spec);
  if (!outlet) return null;
  const history = await catalog.channelReleases(APP_DELIVERABLE_ID, rawChannel);
  if (!history) return null;
  const empty = { channel: history.channel, outlet, entries: [], notesPublic };

  // Step 5's transport rule: the outlet must deliver the app by our own CDN, or no build of it
  // has a delivery URL here at all.
  const transport = await transportOf(
    ctx.db,
    slug,
    APP_DELIVERABLE_ID,
    outlet.id,
  );
  if (transport !== DEFAULT_TRANSPORT) return empty;
  const liveness =
    spec.liveness === "availability"
      ? await outletLiveness(ctx.db, slug, outlet, transport)
      : null;
  const standing = await rolloutStanding(
    ctx.db,
    slug,
    outlet.id,
    spec.rollouts ?? "hold",
    history.channel,
  );
  // P4-14: a release whose required pack set is not available on this outlet is held (Polaris Key
  // serves this feed, so it can hold it wherever the outlet's kind is holdable).
  const readiness =
    ctx.readiness ??
    readinessReader({ db: ctx.db, product: slug, hooks: ctx.hooks });
  const only = spec.releaseIds ? new Set(spec.releaseIds) : null;
  const limit = spec.limit ?? MAX_FEED_VERSIONS;
  const entries: FeedSelectionEntry[] = [];
  let releasesListed = 0;
  for (const release of history.releases.slice(0, MAX_FEED_SCAN)) {
    if (releasesListed >= limit) break;
    if (release.yanked || standing.held.has(release.releaseId)) continue;
    if (only && !only.has(release.releaseId)) continue;
    if (await readiness.holdsOn(release.releaseId, outlet.id)) continue;
    // A store outlet is live only where reported: a release with no live report costs nothing.
    if (
      liveness &&
      !liveness.derives &&
      !(liveness.reports.get(release.releaseId) ?? []).some((r) => r.live)
    )
      continue;
    const builds = (await catalog.builds(release.releaseId)).filter(
      (b) =>
        buildMatchesOutlet(outlet, b, spec.platform) &&
        (!spec.arches || spec.arches.includes(b.arch)) &&
        (!spec.buildIds || spec.buildIds.includes(b.buildId)),
    );
    if (!builds.length) continue;
    const artifacts = await catalog.artifacts(release.releaseId);
    let any = false;
    for (const build of builds) {
      const payload = artifacts.find(
        (a) => a.buildId === build.buildId && a.role === "payload",
      );
      if (!payload) continue;
      if (
        spec.payloadSuffixes &&
        !spec.payloadSuffixes.some((x) =>
          payload.name.toLowerCase().endsWith(x.toLowerCase()),
        )
      )
        continue;
      if (
        liveness &&
        !isLive(liveness, outlet, release.releaseId, build, payload)
      )
        continue;
      const url = servedUrl(ctx, release.releaseId, payload, artifacts);
      if (!url) continue;
      const entry = entryFor(release, build, payload, url, notesPublic);
      entry.rollout = standing.phased.get(release.releaseId) ?? null;
      if (spec.withArtifacts)
        entry.artifacts = artifacts
          .filter(
            (a) =>
              a.artifactId !== payload.artifactId &&
              (a.buildId === build.buildId || a.buildId === null),
          )
          .map(
            (a): FeedSelectionArtifact => ({
              ...a,
              url: servedUrl(ctx, release.releaseId, a, artifacts),
            }),
          );
      entries.push(entry);
      any = true;
      if (!spec.allBuilds) break;
    }
    if (any) releasesListed++;
  }
  return { ...empty, entries };
}

/**
 * The payload's immutable delivery URL — `deliveryUrl()`'s build branch, the release and the
 * transport already checked: the `files` route serves the FIRST artifact (by id) with that name
 * in the release, so the URL exists only when that is this payload.
 */
function servedUrl(
  ctx: FeedReadContext,
  releaseId: string,
  payload: CatalogSourceArtifact,
  artifacts: readonly CatalogSourceArtifact[],
): string | null {
  let first: CatalogSourceArtifact | undefined;
  for (const a of artifacts)
    if (a.name === payload.name && (!first || a.artifactId < first.artifactId))
      first = a;
  if (first?.artifactId !== payload.artifactId) return null;
  return new URL(
    fileDeliveryUrl(ctx.env, ctx.product.slug, releaseId, payload.name),
    ctx.origin,
  ).toString();
}

function entryFor(
  release: CatalogChannelRelease,
  build: CatalogBuild,
  payload: CatalogSourceArtifact,
  url: string,
  notesPublic: boolean,
): FeedSelectionEntry {
  return {
    releaseId: release.releaseId,
    version: release.version,
    publishedAt: release.publishedAt,
    title: release.title,
    notes: notesPublic ? release.notes : null,
    buildId: build.buildId,
    platform: build.platform,
    arch: build.arch,
    format: build.format,
    buildNumber: build.buildNumber,
    minOs: build.minOs,
    metadata: build.metadata,
    name: payload.name,
    sha256: payload.sha256,
    size: payload.sizeBytes,
    url,
    payload,
    rollout: null,
    artifacts: [],
  };
}
