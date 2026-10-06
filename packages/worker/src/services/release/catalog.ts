/**
 * Release's `releaseCatalog` descriptor hook (P2b-01, `core/hooks.ts`): the read-only view of
 * what exists — deliverables, releases, builds, artifact records, channel policy and yanks —
 * over P2-03's data model (`model.ts`) and the truth store (`store.ts`); and (P4-02) packs:
 * declarations, pack releases, a variant's files, pins and embeds (`packs/catalog.ts`).
 *
 * This is how Distribution (and, later, anything else) reads Release without importing it: Core
 * hands a consumer `hooks.releaseCatalog()`, which is `null` while Release is off for the
 * product and this reader otherwise. Every method READS. Nothing here takes or returns a
 * `DbStatement`, because a hook that wrote would be a cross-service import in disguise.
 *
 * The records are plain data in Core's shapes (`Catalog*`), not this service's row types: a
 * consumer must not learn Release's column names, or a column rename here would become a change
 * in every service that reads through the hook.
 */

import type {
  CatalogArtifact,
  CatalogBuild,
  CatalogChannelPolicy,
  CatalogDeliverable,
  CatalogRelease,
  CatalogResolution,
  CatalogResolveQuery,
  CatalogSourceArtifact,
  CatalogYank,
  HookContext,
  ReleaseCatalog,
} from "../../core/hooks.js";
import {
  listArtifactsForBuild,
  listBuilds,
  listChannelPolicies,
  listDeliverables,
  listYanks,
  type ReleaseBuildRow,
} from "./model.js";
import type { ReleaseArtifactRow, ReleaseMetadataRow } from "./store.js";
import { getReleaseConfig, readAccessMode } from "./config.js";
import { entitledSelectorFor } from "./access.js";
import {
  isVersionSelector,
  knownChannels,
  resolveBuild,
  resolveChannelReleases,
} from "./resolve.js";
import {
  installScript,
  openSource,
  parseLocations,
  repositoryPublic,
} from "./source.js";
import { packCatalog } from "./packs/catalog.js";
import { packageCatalog } from "./packages/catalog.js";
import { notPackageReleaseSql } from "./model.js";

type ReleaseRow = Pick<
  ReleaseMetadataRow,
  | "deliverable_id"
  | "release_id"
  | "version"
  | "seq"
  | "channel"
  | "published_at"
> & { yanked: number };

/** The most releases one digest is reported for (identical bytes reused across releases). */
const BLOB_RELEASES_CHECKED = 16;

function buildRecord(b: ReleaseBuildRow): CatalogBuild {
  return {
    releaseId: b.release_id,
    buildId: b.build_id,
    platform: b.platform,
    arch: b.arch,
    format: b.format,
    buildNumber: b.build_number,
    minOs: b.min_os,
    metadata: parseObject(b.metadata_json),
  };
}

/** A JSON object column; anything unreadable or not an object reads as `null`. */
function parseObject(
  json: string | null | undefined,
): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sourceRecord(a: ReleaseArtifactRow): CatalogSourceArtifact {
  return { ...artifactRecord(a), locations: parseLocations(a) };
}

function artifactRecord(a: ReleaseArtifactRow): CatalogArtifact {
  return {
    releaseId: a.release_id,
    artifactId: a.artifact_id,
    name: a.name,
    buildId: a.build_id,
    role: a.role,
    platform: a.platform,
    arch: a.arch,
    contentType: a.content_type,
    sizeBytes: a.size_bytes,
    sha256: a.sha256,
    metadata: parseObject(a.metadata_json),
  };
}

/** `includes_json` as written by `stmtSetChannelPolicy`; anything unreadable reads as unset. */
function parseIncludes(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) &&
      value.every((v): v is string => typeof v === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Build the reader for one product. Called by Core only while Release is enabled for it. */
export function releaseCatalog(ctx: HookContext): ReleaseCatalog {
  const { db, product } = ctx;
  const slug = product.slug;
  // One read of `release_config` per reader (a reader lives for one request): a byte route asks
  // for the metadata mode, the selector classification and the resolution in turn.
  let cfgRead: ReturnType<typeof getReleaseConfig> | undefined;
  const config = () => (cfgRead ??= getReleaseConfig(db, slug));
  return {
    ...packCatalog({ db, env: ctx.env, slug, now: ctx.now }),
    ...packageCatalog({ db, slug }),
    async deliverables(): Promise<CatalogDeliverable[]> {
      // Never a package (F-03): every consumer of this list is device-facing (readiness,
      // rollouts, the matrix, the download page, the storefront feeds) or a pack walk.
      return (await listDeliverables(db, slug))
        .filter((d) => d.kind !== "package")
        .map((d) => ({
          id: d.deliverable_id,
          kind: d.kind,
          packType: d.pack_type,
        }));
    },

    async releases(deliverableId: string): Promise<CatalogRelease[]> {
      const rows = await db.all<ReleaseRow>(
        `SELECT m.deliverable_id, m.release_id, m.version, m.seq, m.channel, m.published_at,
                EXISTS (SELECT 1 FROM release_yanks y
                         WHERE y.product = m.product AND y.release_id = m.release_id) AS yanked
           FROM release_metadata m
          WHERE m.product = ? AND m.deliverable_id = ?
          ORDER BY COALESCE(m.seq, 0) DESC, COALESCE(m.published_at, 0) DESC,
                   m.release_id ASC`,
        slug,
        deliverableId,
      );
      return rows.map((r) => ({
        deliverableId: r.deliverable_id,
        releaseId: r.release_id,
        version: r.version,
        seq: r.seq,
        channel: r.channel,
        publishedAt: r.published_at,
        yanked: Boolean(r.yanked),
      }));
    },

    async release(releaseId: string): Promise<CatalogRelease | null> {
      const r = await db.first<ReleaseRow>(
        `SELECT m.deliverable_id, m.release_id, m.version, m.seq, m.channel, m.published_at,
                EXISTS (SELECT 1 FROM release_yanks y
                         WHERE y.product = m.product AND y.release_id = m.release_id) AS yanked
           FROM release_metadata m
          WHERE m.product = ? AND m.release_id = ? AND ${notPackageReleaseSql("m")}`,
        slug,
        releaseId,
      );
      return r
        ? {
            deliverableId: r.deliverable_id,
            releaseId: r.release_id,
            version: r.version,
            seq: r.seq,
            channel: r.channel,
            publishedAt: r.published_at,
            yanked: Boolean(r.yanked),
          }
        : null;
    },

    async releaseNotes(releaseId: string) {
      const r = await db.first<{
        release_id: string;
        version: string;
        title: string | null;
        notes: string | null;
      }>(
        `SELECT m.release_id, m.version, m.title, m.notes
           FROM release_metadata m
          WHERE m.product = ? AND m.release_id = ? AND ${notPackageReleaseSql("m")}`,
        slug,
        releaseId,
      );
      return r
        ? {
            releaseId: r.release_id,
            version: r.version,
            title: r.title,
            notes: r.notes,
          }
        : null;
    },

    async builds(releaseId: string): Promise<CatalogBuild[]> {
      return (await listBuilds(db, slug, releaseId)).map(buildRecord);
    },

    async artifacts(
      releaseId: string,
      buildId?: string,
    ): Promise<CatalogSourceArtifact[]> {
      const rows =
        buildId === undefined
          ? await db.all<ReleaseArtifactRow>(
              `SELECT * FROM release_artifacts WHERE product = ? AND release_id = ?
                ORDER BY COALESCE(build_id, '') ASC,
                         CASE role WHEN 'payload' THEN 0 ELSE 1 END, role ASC, name ASC`,
              slug,
              releaseId,
            )
          : await listArtifactsForBuild(db, slug, releaseId, buildId);
      return rows.map(sourceRecord);
    },

    async channelPolicies(
      deliverableId?: string,
    ): Promise<CatalogChannelPolicy[]> {
      // All of them: never a package's (F-03), unless that package is asked for by id.
      const packages =
        deliverableId === undefined
          ? new Set(
              (await listDeliverables(db, slug))
                .filter((d) => d.kind === "package")
                .map((d) => d.deliverable_id),
            )
          : new Set<string>();
      return (await listChannelPolicies(db, slug, deliverableId))
        .filter((p) => !packages.has(p.deliverable_id))
        .map((p) => ({
          deliverableId: p.deliverable_id,
          channel: p.channel,
          pointerReleaseId: p.pointer_release_id,
          pinned: p.pinned === 1,
          includes: parseIncludes(p.includes_json),
          minSupported: p.min_supported,
          critical: p.critical === 1,
        }));
    },

    async yanks(): Promise<CatalogYank[]> {
      return (await listYanks(db, slug)).map((y) => ({
        releaseId: y.release_id,
        reason: y.reason,
        at: y.at,
      }));
    },

    async channelReleases(deliverableId: string, channel: string) {
      const yanked = new Set(
        (await listYanks(db, slug)).map((y) => y.release_id),
      );
      const res = await resolveChannelReleases(
        db,
        slug,
        deliverableId,
        channel,
        await config(),
      );
      if (!res) return null;
      return {
        channel: res.channel,
        releases: res.releases.map((r) => ({
          deliverableId: r.deliverable_id,
          releaseId: r.release_id,
          version: r.version,
          seq: r.seq,
          channel: r.channel,
          publishedAt: r.published_at,
          yanked: yanked.has(r.release_id),
          title: r.title,
          notes: r.notes,
        })),
      };
    },

    async metadataAccess() {
      const cfg = await config();
      return cfg ? readAccessMode(cfg.metadata_access) : null;
    },

    async accessSelector(selector: string | undefined) {
      const cfg = await config();
      // Only the manual channels matter to the classification; a product with no configuration
      // has none (and every byte route 404s it before this answer is used).
      return entitledSelectorFor(
        {
          product: slug,
          manual_channels_json: cfg?.manual_channels_json ?? null,
        } as Parameters<typeof entitledSelectorFor>[0],
        "build",
        selector === undefined ? {} : { version: selector },
      );
    },

    async knownChannels() {
      return knownChannels(db, slug, await config());
    },

    resolve: (q: CatalogResolveQuery) => resolveTarget(ctx, q, config),

    openSource: (ref, req) => openSource(ctx, ref, req),

    installScript: (origin: string) => installScript(db, product, origin),

    repositoryPublic: () => repositoryPublic(ctx),
  };
}

/** `releaseCatalog.resolve`: a byte route's target against the truth store. */
async function resolveTarget(
  { db, product }: HookContext,
  q: CatalogResolveQuery,
  config: () => ReturnType<typeof getReleaseConfig>,
): Promise<CatalogResolution | null> {
  const slug = product.slug;
  if (q.kind === "build") {
    const cfg = await config();
    const resolved = await resolveBuild(
      db,
      slug,
      { deliverable: q.deliverable, selector: q.selector, buildId: q.buildId },
      cfg,
    );
    if (!resolved?.build) return null;
    const r = resolved.release;
    const yanked = await db.first<{ n: number }>(
      "SELECT 1 AS n FROM release_yanks WHERE product = ? AND release_id = ?",
      slug,
      r.release_id,
    );
    const payload = (
      await listArtifactsForBuild(
        db,
        slug,
        r.release_id,
        resolved.build.build_id,
      )
    ).find((a) => a.role === "payload");
    return {
      kind: "build",
      release: {
        deliverableId: r.deliverable_id,
        releaseId: r.release_id,
        version: r.version,
        seq: r.seq,
        channel: r.channel,
        publishedAt: r.published_at,
        yanked: Boolean(yanked),
      },
      build: buildRecord(resolved.build),
      payload: payload ? sourceRecord(payload) : null,
      moving: !isVersionSelector(q.selector),
    };
  }

  if (q.kind === "file") {
    const release = await db.first<
      Pick<
        ReleaseMetadataRow,
        "deliverable_id" | "release_id" | "version" | "channel"
      >
    >(
      `SELECT deliverable_id, release_id, version, channel FROM release_metadata m
        WHERE product = ? AND release_id = ? AND ${notPackageReleaseSql("m")}`,
      slug,
      q.releaseId,
    );
    // Joined to its release row: an artifact whose release row is missing is not served on the
    // strength of an access check that saw no version.
    const artifact = release
      ? await db.first<ReleaseArtifactRow>(
          `SELECT * FROM release_artifacts
            WHERE product = ? AND release_id = ? AND name = ?
            ORDER BY artifact_id ASC LIMIT 1`,
          slug,
          q.releaseId,
          q.name,
        )
      : null;
    return {
      kind: "file",
      release: release
        ? {
            deliverableId: release.deliverable_id,
            releaseId: release.release_id,
            version: release.version,
            channel: release.channel,
          }
        : null,
      artifact: artifact ? sourceRecord(artifact) : null,
    };
  }

  const releases = await db.all<
    Pick<
      ReleaseMetadataRow,
      "deliverable_id" | "release_id" | "version" | "channel"
    >
  >(
    `SELECT DISTINCT m.deliverable_id, m.release_id, m.version, m.channel
       FROM release_artifacts a
       JOIN release_metadata m
         ON m.product = a.product AND m.release_id = a.release_id
      WHERE a.product = ? AND a.sha256 = ? AND ${notPackageReleaseSql("m")}
      ORDER BY m.version ASC, m.release_id ASC
      LIMIT ${BLOB_RELEASES_CHECKED}`,
    slug,
    q.sha256,
  );
  return {
    kind: "blob",
    releases: releases.map((r) => ({
      deliverableId: r.deliverable_id,
      releaseId: r.release_id,
      version: r.version,
      channel: r.channel,
    })),
  };
}
