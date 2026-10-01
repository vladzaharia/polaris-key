/**
 * Which releases a storefront feed lists (P2b-05, README §3.8): for outlet O and channel C,
 *
 *   1. the releases C serves, newest first, by Release's own rules (`releaseCatalog.
 *      channelReleases`: membership in C or a channel it includes — beta includes stable — yanks
 *      removed except a pinned pointer, at or below a pinned pointer);
 *   2. that have a build for O: O's artifact-map id when its identity names one, else a build of
 *      the feed's platform (and, for a `direct` outlet with `platforms`, a platform it offers);
 *   3. that are LIVE on O — `delivery.availability()`, where a self-hosted outlet is live by
 *      derivation and a store outlet (AltStore PAL) once reported — or, for a feed that tells a
 *      third party where OUR bytes are (`liveness: "bytes"`, Flathub's checker), whose payload we
 *      serve;
 *   4. that are not yanked, and not held back on O: these clients cannot bucket installs, so a
 *      release whose rollout on O is paused or halted, or active below 10000 bp, is left out until
 *      it completes — the previous release is listed instead;
 *   5. whose payload has an immutable delivery URL (`delivery.deliveryUrl`, on the bytes host when
 *      `BLOB_ORIGIN` is set).
 *
 * ACCESS. None of these clients can authenticate, so a feed exists only while the app
 * deliverable's delivery access (`dist_access`) is `public`; otherwise every feed route is the
 * plain not-found. Release notes appear only when the product's METADATA access is public too.
 *
 * Reads Release only through the catalog hook, and Distribution's own tables directly.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db } from "../../../core/platform.js";
import type {
  CatalogArtifact,
  CatalogBuild,
  CatalogChannelRelease,
  Delivery,
  ReleaseCatalog,
  ServiceHooks,
} from "../../../core/hooks.js";
import {
  listOutlets,
  parseJsonColumn,
  type DistOutletRow,
} from "../outlets.js";
import { FULL_ROLLOUT_BP, type DistRolloutRow } from "../rollouts.js";
import type { RenderEntry, RenderListing } from "./render.js";

/** The most versions a feed lists, and the most releases it reads to find them. */
export const MAX_FEED_VERSIONS = 20;
export const MAX_FEED_SCAN = 200;

export interface FeedReadContext {
  db: Db;
  product: { slug: string; name: string };
  hooks: ServiceHooks;
  /** The request's origin: a delivery URL minted as a path (no bytes host) is made absolute. */
  origin: string;
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
}

export interface FeedSelection {
  channel: string;
  outlet: FeedOutlet;
  entries: RenderEntry[];
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

/** Releases held back on `outlet` (step 4): any rollout there that is not complete. */
async function heldReleases(
  db: Db,
  product: string,
  outletId: string,
): Promise<Set<string>> {
  const rows = await db.all<
    Pick<DistRolloutRow, "release_id" | "rollout_bp" | "state">
  >(
    `SELECT release_id, rollout_bp, state FROM dist_rollouts
      WHERE product = ? AND deliverable_id = ? AND outlet_id = ?`,
    product,
    APP_DELIVERABLE_ID,
    outletId,
  );
  const held = new Set<string>();
  for (const r of rows) {
    const done =
      r.state === "complete" ||
      (r.state === "active" && r.rollout_bp >= FULL_ROLLOUT_BP);
    if (!done) held.add(r.release_id);
  }
  return held;
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
  const { catalog, delivery, notesPublic } = readers;
  const outlet = await pickOutlet(ctx.db, ctx.product.slug, spec);
  if (!outlet) return null;
  const history = await catalog.channelReleases(APP_DELIVERABLE_ID, rawChannel);
  if (!history) return null;

  const held = await heldReleases(ctx.db, ctx.product.slug, outlet.id);
  const limit = spec.limit ?? MAX_FEED_VERSIONS;
  const entries: RenderEntry[] = [];
  let releasesListed = 0;
  for (const release of history.releases.slice(0, MAX_FEED_SCAN)) {
    if (releasesListed >= limit) break;
    if (release.yanked || held.has(release.releaseId)) continue;
    const builds = (await catalog.builds(release.releaseId)).filter((b) =>
      buildMatchesOutlet(outlet, b, spec.platform),
    );
    if (!builds.length) continue;
    const live =
      spec.liveness === "availability"
        ? (await delivery.availability(release.releaseId)).filter(
            (a) => a.outletId === outlet.id && a.state === "live",
          )
        : null;
    let any = false;
    for (const build of builds) {
      if (
        live &&
        !live.some((a) => a.buildId === "" || a.buildId === build.buildId)
      )
        continue;
      const entry = await entryFor(
        catalog,
        delivery,
        ctx.origin,
        outlet.id,
        release,
        build,
        notesPublic,
      );
      if (!entry) continue;
      entries.push(entry);
      any = true;
      if (!spec.allBuilds) break;
    }
    if (any) releasesListed++;
  }
  return { channel: history.channel, outlet, entries, notesPublic };
}

async function entryFor(
  catalog: ReleaseCatalog,
  delivery: Delivery,
  origin: string,
  outletId: string,
  release: CatalogChannelRelease,
  build: CatalogBuild,
  notesPublic: boolean,
): Promise<RenderEntry | null> {
  const payload: CatalogArtifact | undefined = (
    await catalog.artifacts(release.releaseId, build.buildId)
  ).find((a) => a.role === "payload");
  if (!payload) return null;
  const url = await delivery.deliveryUrl({
    releaseId: release.releaseId,
    buildId: build.buildId,
    outlet: outletId,
  });
  if (!url) return null;
  return {
    releaseId: release.releaseId,
    version: release.version,
    publishedAt: release.publishedAt,
    title: release.title,
    notes: notesPublic ? release.notes : null,
    buildId: build.buildId,
    platform: build.platform,
    arch: build.arch,
    buildNumber: build.buildNumber,
    minOs: build.minOs,
    metadata: build.metadata,
    name: payload.name,
    sha256: payload.sha256,
    size: payload.sizeBytes,
    url: new URL(url, origin).toString(),
  };
}
