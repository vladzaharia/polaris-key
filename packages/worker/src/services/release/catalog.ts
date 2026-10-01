/**
 * Release's `releaseCatalog` descriptor hook (P2b-01, `core/hooks.ts`): the read-only view of
 * what exists — deliverables, releases, builds, artifact records, channel policy and yanks —
 * over P2-03's data model (`model.ts`) and the truth store (`store.ts`).
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
import { isVersionSelector, resolveBuild } from "./resolve.js";
import { installScript, openSource, parseLocations } from "./source.js";

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
  };
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
  return {
    async deliverables(): Promise<CatalogDeliverable[]> {
      return (await listDeliverables(db, slug)).map((d) => ({
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

    async builds(releaseId: string): Promise<CatalogBuild[]> {
      return (await listBuilds(db, slug, releaseId)).map(buildRecord);
    },

    async artifacts(
      releaseId: string,
      buildId?: string,
    ): Promise<CatalogArtifact[]> {
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
      return rows.map(artifactRecord);
    },

    async channelPolicies(
      deliverableId?: string,
    ): Promise<CatalogChannelPolicy[]> {
      return (await listChannelPolicies(db, slug, deliverableId)).map((p) => ({
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

    async metadataAccess() {
      const cfg = await getReleaseConfig(db, slug);
      return cfg ? readAccessMode(cfg.metadata_access) : null;
    },

    async accessSelector(selector: string | undefined) {
      const cfg = await getReleaseConfig(db, slug);
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

    resolve: (q: CatalogResolveQuery) => resolveTarget(ctx, q),

    openSource: (ref, req) => openSource(ctx, ref, req),

    installScript: (origin: string) => installScript(db, product, origin),
  };
}

/** `releaseCatalog.resolve`: a byte route's target against the truth store. */
async function resolveTarget(
  { db, product }: HookContext,
  q: CatalogResolveQuery,
): Promise<CatalogResolution | null> {
  const slug = product.slug;
  if (q.kind === "build") {
    const cfg = await getReleaseConfig(db, slug);
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
      `SELECT deliverable_id, release_id, version, channel FROM release_metadata
        WHERE product = ? AND release_id = ?`,
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
      WHERE a.product = ? AND a.sha256 = ?
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
