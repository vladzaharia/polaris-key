/// <reference types="@cloudflare/workers-types" />

/**
 * Release's admin surface — `/manage/api/products/<slug>/release/{health,resync,releases}`.
 *
 * `health` and `resync` were already service-shaped under the old admin handler; they move here
 * verbatim (§R1) so the service owns its own console API. `releases` is new: the truth store now
 * has a writer (P2.T2), so an operator can see what Polaris believes GitHub publishes without
 * spending a GitHub subrequest to find out.
 *
 * The session, CSRF, rate-limit and platform-admin gates all run in `admin/api.ts` before this
 * is reached — see `core/adminApi.ts` for why they stay there.
 */

import { ErrorCode } from "../../core/errors.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/adminApi.js";
import { adminJson, adminNotFound, audit, err } from "../../core/adminApi.js";
import { upsertProductSyncState } from "../../core/ingest.js";
import { checkReleaseHealth } from "./health.js";
import { resyncRepo } from "./resync.js";
import {
  listReleaseArtifacts,
  listReleaseChannels,
  listReleaseHealth,
  listReleaseMetadata,
} from "./store.js";

export async function handleReleaseAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, env, db, product, rest, session, now } = ctx;
  if (rest.length !== 1) return null;
  const slug = product.slug;

  if (rest[0] === "health") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({ health: await checkReleaseHealth(env, db, slug, now) });
  }

  if (rest[0] === "releases") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const releases = await listReleaseMetadata(db, slug);
    const health = new Map(
      (await listReleaseHealth(db, slug))
        .filter((h) => h.subject_kind === "release")
        .map((h) => [h.subject_id, h.status]),
    );
    return adminJson({
      releases: await Promise.all(
        releases.map(async (row) => ({
          releaseId: row.release_id,
          version: row.version,
          title: row.title,
          publishedAt: row.published_at,
          sourceUrl: row.source_url,
          status: health.get(row.release_id) ?? "unknown",
          artifacts: (await listReleaseArtifacts(db, slug, row.release_id)).map(
            (a) => ({
              artifactId: a.artifact_id,
              name: a.name,
              kind: a.kind,
              platform: a.platform,
              arch: a.arch,
              sizeBytes: a.size_bytes,
              access: a.access,
            }),
          ),
        })),
      ),
      channels: (await listReleaseChannels(db, slug)).map((c) => ({
        channel: c.channel,
        releaseId: c.release_id,
        modifiedAt: c.modified_at,
      })),
    });
  }

  if (rest[0] !== "resync") return adminNotFound();
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const result = await resyncRepo(env, db, slug, now);
  if (!result.ok) {
    await upsertProductSyncState(db, {
      product: slug,
      source: "manual",
      status: "error",
      last_checked_at: now,
      last_synced_at: null,
      commit_sha: null,
      changed_paths_json: null,
      updated_json: null,
      errors_json: result.errors ? JSON.stringify(result.errors) : null,
      message: result.error,
    });
    return err(
      422,
      ErrorCode.BadRequest,
      result.error,
      result.errors ? { errors: result.errors } : undefined,
    );
  }
  await upsertProductSyncState(db, {
    product: slug,
    source: "manual",
    status: "ok",
    last_checked_at: now,
    last_synced_at: now,
    commit_sha: null,
    changed_paths_json: null,
    updated_json: JSON.stringify(result.updated),
    errors_json: null,
    message: null,
  });
  await audit(
    db,
    slug,
    session,
    now,
    "release.resync",
    { kind: "product", id: slug },
    `Resynced ${slug} from its linked repo`,
  );
  return adminJson({ ok: true, slug, updated: result.updated });
}
