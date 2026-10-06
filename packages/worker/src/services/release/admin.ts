/// <reference types="@cloudflare/workers-types" />

/**
 * Release's admin surface — `/manage/api/products/<slug>/release/{health,resync,releases}` and
 * `…/release/channels/<channel>/floor` (P0-02, R6-10), plus the channel policy operations
 * (P2-05, `policy.ts`):
 *
 *     GET    …/release/channels                         the policy per deliverable, with source
 *     PUT    …/release/channels/<channel>               pointer, pinned, minSupported, critical
 *     POST   …/release/channels/<channel>/revert        hand the row back to the manifest
 *     POST   …/release/releases/<releaseId>/yank        { "reason": "…" }
 *     DELETE …/release/releases/<releaseId>/yank
 *     POST   …/release/releases/<releaseId>/deprecate   { "message": "…" } (F-03, a package version)
 *     DELETE …/release/releases/<releaseId>/deprecate
 *
 * and the pack read model (P4-09, `packs/adminView.ts`):
 *
 *     GET    …/release/deliverables                     the app and every pack, with latest release
 *     GET    …/release/deliverables/<id>/releases       a pack's releases and who pins each
 *     GET    …/release/deliverables/<id>/releases/<releaseId>/files?variant=<key>
 *                                                        one variant's files, from its index
 *     GET    …/release/delegations                      the content keys (P4-19), read-only
 *
 * and Link repository for a product that exists already (UX-23, `linkExisting.ts`):
 *
 *     POST   …/release/link?dryRun=1                    { "repoUrl" } → the checks and the plan
 *     POST   …/release/link                             { "repoUrl", "manifestDigest" } → link
 *                                                        and apply (the digest is the check's)
 *
 * and the compatibility matrix (P4-15, `packs/compat.ts`):
 *
 *     GET    …/release/compat[?limit=N&offset=M]        app releases × pack releases, a cell
 *                                                        state per pair, the live levels
 *
 * All of them are narrative-only (the console's API is not in the wire spec), audited with the
 * session's subject, and invalidate the product's cached resolutions.
 *
 * `health` and `resync` were already service-shaped under the old admin handler; they move here
 * verbatim (§R1) so the service owns its own console API. `releases` is new: the truth store now
 * has a writer (P2.T2), so an operator can see what Polaris Key believes GitHub publishes without
 * spending a GitHub subrequest to find out. Each app release carries its signed record's `signer`
 * (the CI release key's `kid` and the record hash; `null` for a legacy release with no record).
 *
 * The session, CSRF, rate-limit and platform-admin gates all run in `admin/api.ts` before this
 * is reached — see `core/adminApi.ts` for why they stay there.
 */

import { platformFromFileName } from "@polaris-key/manifest";
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
import {
  getProduct,
  systemResyncRefusal,
  upsertProductSyncState,
} from "../../core/ingest.js";
import {
  classifyChannel,
  floorChannelOf,
  parseManualChannels,
} from "./channels.js";
import { getReleaseConfig } from "./config.js";
import { checkReleaseHealth } from "./health.js";
import { bumpReleaseGeneration } from "./ghCache.js";
import {
  listBuilds,
  listChannelPolicies,
  listDeliverables,
  listYanks,
} from "./model.js";
import {
  knownChannels,
  policyView,
  revertChannelPolicy,
  setPackageDeprecation,
  unyank,
  updateChannelPolicy,
  yank,
  type PolicyActor,
  type PolicyRefusal,
} from "./policy.js";
import {
  loadDeliverableState,
  resolveInState,
  type DeliverableState,
} from "./resolve.js";
import { resyncNotes, resyncRepo } from "./resync.js";
import {
  linkExistingProduct,
  planResync,
  prepareLink,
  type LinkRefusal,
} from "./linkExisting.js";
import {
  appPinsByRelease,
  delegationsView,
  deliverablesView,
  embedsOf,
  packFilesView,
  packReleasesView,
} from "./packs/adminView.js";
import {
  COMPAT_MAX_LIMIT,
  COMPAT_MAX_OFFSET,
  compatView,
  parseCompatLimit,
  parseCompatOffset,
} from "./packs/compat.js";
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

/** A link refusal. `reason` names the check it failed (`app`, `manifest`, `slug`…), so the
 *  console can mark the checks before it as passed. */
function linkRefusal(r: LinkRefusal): Response {
  return err(r.status, ErrorCode.BadRequest, r.error, {
    reason: r.check,
    ...(r.errors ? { errors: r.errors } : {}),
  });
}

/**
 * `POST …/release/link[?dryRun=1]`: Link repository (UX-23). The dry run checks and plans and
 * writes nothing; the link re-checks against the manifest GitHub serves now, refuses (409) when
 * it is not the one the operator checked, then links and applies it through `resyncRepo`.
 */
async function handleLink(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response> {
  const { req, env, db, product, session, now } = ctx;
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const slug = product.slug;
  const body = await readBody(req);
  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl.trim() : "";
  if (!repoUrl)
    return err(422, ErrorCode.BadRequest, "repoUrl is required", {
      fields: ["repoUrl"],
    });
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  if (dryRun) {
    const prepared = await prepareLink(env, db, slug, repoUrl, now, fetch);
    if (!prepared.ok) return linkRefusal(prepared);
    return adminJson({
      ok: true,
      dryRun: true,
      slug,
      repository: prepared.repository,
      commit: prepared.commit,
      manifestDigest: prepared.manifestDigest,
      plan: prepared.plan,
      remainingSecrets: prepared.remainingSecrets,
    });
  }

  const digest =
    typeof body.manifestDigest === "string" ? body.manifestDigest : "";
  if (!digest)
    return err(
      422,
      ErrorCode.BadRequest,
      "manifestDigest is required: check the repository first (?dryRun=1)",
      { fields: ["manifestDigest"] },
    );
  // A refusal or a throw after the coordinates were written is put back by
  // `linkExistingProduct`, and audited here: a link that half-ran must leave a trace.
  const refusedAfterWrite = (why: string) =>
    audit(
      db,
      slug,
      session,
      now,
      "product.link.refused",
      { kind: "product", id: slug },
      `Link of ${slug} to ${repoUrl} refused while applying, put back to manual: ${why}`,
    );
  let result: Awaited<ReturnType<typeof linkExistingProduct>>;
  try {
    result = await linkExistingProduct(
      env,
      db,
      slug,
      repoUrl,
      digest,
      now,
      fetch,
      ctx.ingest,
    );
  } catch (e) {
    await refusedAfterWrite(e instanceof Error ? e.message : "apply failed");
    throw e;
  }
  if (!result.ok) {
    if (result.afterWrite) await refusedAfterWrite(result.error);
    return linkRefusal(result);
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
    errors_json: result.refused ? JSON.stringify(result.refused) : null,
    message: result.refused
      ? result.refused.map((r) => `${r.code}: ${r.message}`).join("; ")
      : null,
  });
  await audit(
    db,
    slug,
    session,
    now,
    "product.link",
    { kind: "product", id: slug },
    `Linked ${slug} to ${result.repository}`,
  );
  return adminJson({
    ok: true,
    slug,
    repository: result.repository,
    plan: result.plan,
    updated: result.updated,
    remainingSecrets: result.remainingSecrets,
    ...(result.refused ? { refused: result.refused } : {}),
    ...(result.packSets ? { packSets: result.packSets } : {}),
  });
}

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
  const policyRoute = await handlePolicyRoutes(ctx);
  if (policyRoute) return policyRoute;
  const packRoute = await handlePackViews(ctx);
  if (packRoute) return packRoute;
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
    const yanks = new Map(
      (await listYanks(db, slug)).map((y) => [y.release_id, y]),
    );
    // P4-09: what each app release pins (one query for the product), beside its contentApi.
    const pins = await appPinsByRelease(
      db,
      slug,
      releases.map((r) => r.release_id),
      yanks,
    );
    // Who signed each app release record (the CI release key, AGENTS rule 2): one read for the
    // product. A legacy GitHub-synced release has no record and reads `signer: null`.
    const signers = new Map(
      (
        await db.all<{
          release_id: string;
          kid: string;
          record_sha256: string;
        }>(
          `SELECT release_id, kid, record_sha256 FROM release_records
            WHERE product = ? AND kind = 'app'`,
          slug,
        )
      ).map((r) => [r.release_id, r]),
    );
    return adminJson({
      releases: await Promise.all(
        releases.map(async (row) => {
          const yanked = yanks.get(row.release_id);
          const builds = await listBuilds(db, slug, row.release_id);
          const buildPlatform = new Map(
            builds.map((b) => [b.build_id, b.platform]),
          );
          return {
            releaseId: row.release_id,
            deliverable: row.deliverable_id,
            version: row.version,
            seq: row.seq,
            channel: row.channel,
            title: row.title,
            publishedAt: row.published_at,
            sourceUrl: row.source_url,
            status: health.get(row.release_id) ?? "unknown",
            yank: yanked
              ? { reason: yanked.reason, at: yanked.at, by: yanked.by }
              : null,
            contentApi: row.content_api ?? null,
            pins: pins.get(row.release_id) ?? [],
            signer: signers.has(row.release_id)
              ? {
                  kind: "release" as const,
                  kid: signers.get(row.release_id)!.kid,
                  recordSha256: signers.get(row.release_id)!.record_sha256,
                }
              : null,
            // P2-05: the builds a descriptor declared (P2-04); empty for a legacy release.
            builds: builds.map((b) => ({
              buildId: b.build_id,
              platform: b.platform,
              arch: b.arch,
              format: b.format,
              buildNumber: b.build_number,
              minOs: b.min_os,
              // P4-09: the packs this build ships embedded; null when its descriptor said nothing.
              embeds: embedsOf(b.embeds_json),
            })),
            artifacts: (
              await listReleaseArtifacts(db, slug, row.release_id)
            ).map((a) => ({
              artifactId: a.artifact_id,
              name: a.name,
              kind: a.kind,
              // Read-time inference, display only: a file with no platform of its own takes
              // its build's (null for a platform-independent pack build); a file tied to no
              // build takes the one its name declares (`djdl-arm64.app.zip` is macOS).
              platform:
                a.platform ??
                (a.build_id !== null && buildPlatform.has(a.build_id)
                  ? (buildPlatform.get(a.build_id) ?? null)
                  : platformFromFileName(a.name)),
              arch: a.arch,
              sizeBytes: a.size_bytes,
              access: a.access,
              buildId: a.build_id,
              role: a.role,
              sha256: a.sha256,
              locations: parseLocationsView(a.locations_json),
            })),
          };
        }),
      ),
      channels: (await listReleaseChannels(db, slug)).map((c) => ({
        channel: c.channel,
        releaseId: c.release_id,
        modifiedAt: c.modified_at,
      })),
      floors: (await listChannelFloors(db, slug)).map(floorView),
    });
  }

  if (rest.length === 1 && rest[0] === "compat") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const params = new URL(req.url).searchParams;
    const limit = parseCompatLimit(params.get("limit"));
    if (limit === null)
      return err(
        400,
        ErrorCode.BadRequest,
        `limit must be an integer from 1 to ${COMPAT_MAX_LIMIT}`,
      );
    const offset = parseCompatOffset(params.get("offset"));
    if (offset === null)
      return err(
        400,
        ErrorCode.BadRequest,
        `offset must be an integer from 0 to ${COMPAT_MAX_OFFSET}`,
      );
    return adminJson(
      await compatView(
        db,
        slug,
        await getReleaseConfig(db, slug),
        limit,
        offset,
      ),
    );
  }

  if (rest[0] === "link") return handleLink(ctx);

  if (rest[0] !== "resync") return adminNotFound();
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  // ST-20 (S-18 §4.5 item 8): the system product's only writer is the deploy hook. Refused here,
  // before the dry run or the apply, without a sync-state row (nothing failed to sync).
  const row = await getProduct(db, slug);
  const systemRefusal = row ? systemResyncRefusal(row) : null;
  if (systemRefusal)
    return err(409, ErrorCode.BadRequest, systemRefusal, {
      reason: "system_product",
    });
  // `?dryRun=1` (S-18 §4.5 item 4, UX-78): the plan the console's Resync confirm renders. It
  // reads the manifest as the resync would and writes nothing: no sync state, no audit row.
  if (new URL(req.url).searchParams.get("dryRun") === "1") {
    const planned = await planResync(env, db, slug, now, fetch);
    if (!planned.ok) return linkRefusal(planned);
    return adminJson({
      ok: true,
      dryRun: true,
      slug,
      repository: planned.repository,
      commit: planned.commit,
      plan: planned.plan,
      // ST-20: the break-glass claims the resync would keep (ST-17's dry run shows them).
      ...(planned.breakGlass.length > 0
        ? { breakGlass: planned.breakGlass }
        : {}),
    });
  }
  const result = await resyncRepo(env, db, slug, now, fetch, ctx.ingest);
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
    // P3-03: parts the sync refused while applying the rest (`release_key_is_product_key`);
    // ST-01b: the console-row conflicts it kept.
    ...resyncNotes(result),
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
  return adminJson({
    ok: true,
    slug,
    updated: result.updated,
    ...(result.refused ? { refused: result.refused } : {}),
    // ST-01b: what it left alone because the console claimed it.
    ...(result.claimed ? { claimed: result.claimed } : {}),
    // ST-20: the live break-glass claims, and the ones this resync ended.
    ...(result.breakGlass ? { breakGlass: result.breakGlass } : {}),
    ...(result.breakGlassEnded
      ? { breakGlassEnded: result.breakGlassEnded }
      : {}),
    ...(result.conflicts ? { conflicts: result.conflicts } : {}),
    ...(result.packSets ? { packSets: result.packSets } : {}),
  });
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
    await bumpReleaseGeneration(ctx.env, slug, now);
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
  await bumpReleaseGeneration(ctx.env, slug, now);
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

// ── Pack views (P4-09) ──────────────────────────────────────────────────────────────────────

/**
 * The read-only pack routes, or `null` when the path is not one of them. Both read Release's own
 * `releaseCatalog` hook (null only while Release is off, which never reaches here) and the
 * delivery gate through Distribution's `delivery` hook (null while Distribution is off).
 */
async function handlePackViews(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, db, product, rest, hooks } = ctx;
  // P4-19 (decision 11): the delegated content keys, read-only.
  if (rest.length === 1 && rest[0] === "delegations") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({
      delegations: await delegationsView(db, product.slug, ctx.now),
    });
  }
  if (rest[0] !== "deliverables") return null;
  const isList = rest.length === 1;
  const isReleases = rest.length === 3 && rest[2] === "releases";
  const isFiles =
    rest.length === 5 && rest[2] === "releases" && rest[4] === "files";
  if (!isList && !isReleases && !isFiles) return null;
  if (req.method !== "GET")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const catalog = hooks.releaseCatalog();
  if (!catalog) return adminNotFound();
  const slug = product.slug;
  if (isList)
    return adminJson(
      await deliverablesView(db, slug, catalog, hooks.delivery()),
    );
  const deliverable = segment(rest[1] as string);
  if (deliverable === null) return adminNotFound();
  if (isFiles) {
    const releaseId = segment(rest[3] as string);
    // The variant key (`""` for an unvaried pack) rides in the query: it is not a path segment.
    const variant = new URL(req.url).searchParams.get("variant");
    if (releaseId === null || variant === null) return adminNotFound();
    const files = await packFilesView(catalog, deliverable, releaseId, variant);
    if (!files) return adminNotFound();
    return adminJson({ deliverable, releaseId, variant, ...files });
  }
  const releases = await packReleasesView(db, slug, catalog, deliverable);
  if (!releases) return adminNotFound();
  return adminJson({ deliverable, releases });
}

// ── Channel policy (P2-05) ───────────────────────────────────────────────────────────────────

/** `locations_json` for the console, as stored (an array) or `null`. */
function parseLocationsView(json: string | null): unknown[] | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The platforms any build of the deliverable declares, sorted; a platform-independent build
 *  (`platform` null, a pack variant) names none. */
function platformsOf(state: DeliverableState): string[] {
  const out = new Set<string>();
  for (const builds of state.buildsByRelease.values())
    for (const b of builds) if (b.platform) out.add(b.platform);
  return [...out].sort();
}

function policyRefusal(r: PolicyRefusal): Response {
  return err(
    r.status,
    r.code,
    r.message,
    r.fields ? { reason: r.reason, fields: r.fields } : { reason: r.reason },
  );
}

function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * The policy routes, or `null` when the path is not one of them. GET `channels` returns, per
 * deliverable, every channel the product can serve with its policy (defaults where no row
 * exists), its `source`, what it resolves to right now with no platform filter (`resolved`), and
 * what it resolves to on each platform the deliverable has a build for (`byPlatform`).
 */
async function handlePolicyRoutes(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, env, db, product, rest, session, now } = ctx;
  const slug = product.slug;
  const actor: PolicyActor = { kind: "admin", session };

  if (rest.length === 1 && rest[0] === "channels") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const cfg = await getReleaseConfig(db, slug);
    const channels = await knownChannels(db, slug, cfg);
    const deliverables = await listDeliverables(db, slug);
    const out = [];
    for (const d of deliverables) {
      const rows = await listChannelPolicies(db, slug, d.deliverable_id);
      const names = [...new Set([...channels, ...rows.map((r) => r.channel)])];
      // One read of the deliverable, resolved many times: per channel with no platform filter
      // (`resolved`), and per platform any build of the deliverable declares (`byPlatform`),
      // because "stable" is not one release — a release missing the iOS build leaves iOS on
      // the newest release that has one (README §3.4, `resolve.ts` rule 5). The console renders
      // these as they are; it never recomputes resolution (P2-07).
      const state = await loadDeliverableState(db, slug, d.deliverable_id, cfg);
      const platforms = state ? platformsOf(state) : [];
      const views = [];
      for (const channel of names) {
        const row = rows.find((r) => r.channel === channel) ?? null;
        const resolved = state
          ? resolveInState(state, { selector: channel })
          : null;
        const byPlatform: Record<string, string | null> = {};
        for (const platform of platforms) {
          byPlatform[platform] = state
            ? (resolveInState(state, { selector: channel, platform })?.release
                .release_id ?? null)
            : null;
        }
        views.push({
          ...policyView(row, d.deliverable_id, channel),
          resolved: resolved ? resolved.release.release_id : null,
          byPlatform,
        });
      }
      out.push({
        deliverable: d.deliverable_id,
        kind: d.kind,
        platforms,
        channels: views,
      });
    }
    return adminJson({ deliverables: out });
  }

  if (rest.length === 2 && rest[0] === "channels") {
    if (req.method !== "PUT")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const channel = segment(rest[1] as string);
    if (channel === null) return adminNotFound();
    const body = await readBody(req);
    const result = await updateChannelPolicy(
      env,
      db,
      slug,
      await getReleaseConfig(db, slug),
      channel,
      body,
      actor,
      now,
    );
    return result.ok
      ? adminJson({
          ok: true,
          policy: result.policy,
          packSets: result.packSets,
        })
      : policyRefusal(result);
  }

  if (rest.length === 3 && rest[0] === "channels" && rest[2] === "revert") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const channel = segment(rest[1] as string);
    if (channel === null) return adminNotFound();
    const body = await readBody(req);
    const result = await revertChannelPolicy(
      env,
      db,
      slug,
      await getReleaseConfig(db, slug),
      channel,
      body,
      actor,
      now,
    );
    return result.ok
      ? adminJson({
          ok: true,
          policy: result.policy,
          packSets: result.packSets,
        })
      : policyRefusal(result);
  }

  if (rest.length === 3 && rest[0] === "releases" && rest[2] === "yank") {
    const releaseId = segment(rest[1] as string);
    if (releaseId === null) return adminNotFound();
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await yank(
        env,
        db,
        slug,
        releaseId,
        body.reason,
        actor,
        now,
      );
      return result.ok
        ? adminJson({ ok: true, yank: result.yank, packSets: result.packSets })
        : policyRefusal(result);
    }
    if (req.method === "DELETE") {
      const result = await unyank(env, db, slug, releaseId, actor, now);
      return result.ok
        ? adminJson({ ok: true, yank: result.yank, packSets: result.packSets })
        : policyRefusal(result);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  // F-03: a package version's deprecation (npm `deprecated`), package versions only.
  if (rest.length === 3 && rest[0] === "releases" && rest[2] === "deprecate") {
    const releaseId = segment(rest[1] as string);
    if (releaseId === null) return adminNotFound();
    if (req.method !== "POST" && req.method !== "DELETE")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const message =
      req.method === "POST" ? (await readBody(req)).message : null;
    const result = await setPackageDeprecation(
      env,
      db,
      slug,
      releaseId,
      req.method === "POST" ? (message ?? "") : null,
      actor,
      now,
    );
    return result.ok
      ? adminJson({ ok: true, deprecation: result.deprecation })
      : policyRefusal(result);
  }

  return null;
}
