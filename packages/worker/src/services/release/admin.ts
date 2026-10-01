/// <reference types="@cloudflare/workers-types" />

/**
 * Release's admin surface — `/manage/api/products/<slug>/release/{health,resync,releases}` and
 * `…/release/channels/<channel>/floor` (P0-02, R6-10).
 *
 * `health` and `resync` were already service-shaped under the old admin handler; they move here
 * verbatim (§R1) so the service owns its own console API. `releases` is new: the truth store now
 * has a writer (P2.T2), so an operator can see what Polaris Key believes GitHub publishes without
 * spending a GitHub subrequest to find out.
 *
 * The session, CSRF, rate-limit and platform-admin gates all run in `admin/api.ts` before this
 * is reached — see `core/adminApi.ts` for why they stay there.
 */

import { ErrorCode } from "../../core/errors.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/adminApi.js";
import {
  adminJson,
  adminNotFound,
  audit,
  err,
  readBody,
} from "../../core/adminApi.js";
import { compareSemver, parseSemver } from "../../core/entitlements.js";
import { upsertProductSyncState } from "../../core/ingest.js";
import {
  classifyChannel,
  floorChannelOf,
  parseManualChannels,
} from "./channels.js";
import { getReleaseConfig } from "./config.js";
import { checkReleaseHealth } from "./health.js";
import { resyncRepo } from "./resync.js";
import {
  channelNames,
  clearChannelFloor,
  getChannelFloor,
  listChannelFloors,
  listReleaseArtifacts,
  listReleaseChannels,
  listReleaseHealth,
  listReleaseMetadata,
  lowerChannelFloor,
  releaseIdForVersion,
  type ReleaseChannelFloorRow,
} from "./store.js";

function floorView(f: ReleaseChannelFloorRow) {
  return {
    channel: f.channel,
    version: f.version,
    releaseId: f.release_id,
    raisedAt: f.raised_at,
    loweredBy: f.lowered_by,
    loweredAt: f.lowered_at,
  };
}

export async function handleReleaseAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, env, db, product, rest, session, now } = ctx;
  if (rest.length === 3 && rest[0] === "channels" && rest[2] === "floor")
    return handleChannelFloor(ctx, rest[1] as string);
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
      floors: (await listChannelFloors(db, slug)).map(floorView),
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

/**
 * `POST …/release/channels/<channel>/floor` — lower or clear a channel floor (R6-10).
 *
 * `{ "version": "1.0.0" }` lowers the floor to that version; `{ "clear": true }` removes it.
 * Raising is refused: the floor is the highest version a SYNC has seen, and an operator-raised
 * floor would be a way to 404 a channel by typo. A floor stuck too high (a typo'd `v10.0.0`
 * that was deleted later) is exactly the case this endpoint exists for, and `checkReleaseHealth`
 * names it. A stranded floor — its channel since removed, or no longer floored — can still be
 * cleared, never lowered. Audited as `release.channel.floor`.
 */
async function handleChannelFloor(
  ctx: ServiceContext & { session: AdminSession },
  channel: string,
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const cfg = await getReleaseConfig(db, slug);
  if (!cfg) return adminNotFound();
  // A floor row can outlive the configuration that made it: a manual channel since removed from
  // the manifest, or a `beta` floor recorded before a `channel_workflow` was configured (beta is
  // not floored while one is). Such a STRANDED row is inert today but comes back to life if the
  // configuration does, so it must stay clearable (P2-03, wave-1 sync). Lowering stays limited
  // to channels that are floored now.
  const existing = await getChannelFloor(db, slug, channel);
  const known = channelNames(cfg).includes(channel);
  if (!known && !existing) return adminNotFound();
  const sel = known
    ? classifyChannel(channel, parseManualChannels(cfg.manual_channels_json))
    : null;
  const floored = !!sel && floorChannelOf(sel, cfg) === channel;
  if (!floored && !existing) {
    return err(422, ErrorCode.BadRequest, "this channel is not floored", {
      fields: ["channel"],
    });
  }

  const body = await readBody(req);
  const clear = body.clear === true;
  const version = body.version;
  if (clear === (version !== undefined)) {
    return err(
      422,
      ErrorCode.BadRequest,
      'send exactly one of { "version": "X.Y.Z" } or { "clear": true }',
      { fields: ["version", "clear"] },
    );
  }

  if (!existing) return adminNotFound();

  if (clear) {
    await clearChannelFloor(db, slug, channel);
    await audit(
      db,
      slug,
      session,
      now,
      "release.channel.floor",
      { kind: "channel", id: channel },
      `Cleared the ${channel} floor for ${slug} (was ${existing.version})`,
    );
    return adminJson({ ok: true, channel, floor: null });
  }

  if (!floored) {
    return err(
      422,
      ErrorCode.BadRequest,
      "this channel is no longer floored; its stale floor can only be cleared",
      { fields: ["channel"] },
    );
  }
  if (typeof version !== "string" || !parseSemver(version)) {
    return err(422, ErrorCode.BadRequest, "version must be X.Y.Z semver", {
      fields: ["version"],
    });
  }
  if (
    parseSemver(existing.version) &&
    compareSemver(version, existing.version) > 0
  ) {
    return err(
      422,
      ErrorCode.BadRequest,
      "a floor can only be lowered; the sync raises it",
      { fields: ["version"] },
    );
  }
  await lowerChannelFloor(
    db,
    slug,
    channel,
    { version, releaseId: await releaseIdForVersion(db, slug, version) },
    session.email || session.sub,
    now,
  );
  await audit(
    db,
    slug,
    session,
    now,
    "release.channel.floor",
    { kind: "channel", id: channel },
    `Lowered the ${channel} floor for ${slug} from ${existing.version} to ${version}`,
  );
  const floor = await getChannelFloor(db, slug, channel);
  return adminJson({
    ok: true,
    channel,
    floor: floor ? floorView(floor) : null,
  });
}
