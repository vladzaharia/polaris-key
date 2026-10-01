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
} from "./model.js";
import type { ReleaseArtifactRow, ReleaseMetadataRow } from "./store.js";

type ReleaseRow = Pick<
  ReleaseMetadataRow,
  | "deliverable_id"
  | "release_id"
  | "version"
  | "seq"
  | "channel"
  | "published_at"
> & { yanked: number };

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
export function releaseCatalog({ db, product }: HookContext): ReleaseCatalog {
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
      return (await listBuilds(db, slug, releaseId)).map((b) => ({
        releaseId: b.release_id,
        buildId: b.build_id,
        platform: b.platform,
        arch: b.arch,
        format: b.format,
        buildNumber: b.build_number,
        minOs: b.min_os,
      }));
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
  };
}
