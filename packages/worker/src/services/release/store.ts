/// <reference types="@cloudflare/workers-types" />

/**
 * The release truth store — `release_metadata` / `release_artifacts` / `release_channels` /
 * `release_health` (design spec §5.2, "Release truth store goes live").
 *
 * ── WHAT THESE TABLES WERE ──────────────────────────────────────────────────────────────────
 *
 * Scaffolding, since `0007_backend_contracts.sql`: four tables, six indexes, a fully-wired READ
 * path in the customer portal — and, in `packages/worker/src/`, not one INSERT. Every row the
 * portal ever listed came from a test fixture. P2.T2 makes resync the writer, which is what the
 * portal's releases view, the console's releases list and the `entitled` mode all read.
 *
 * ── ARMING R6-12 ────────────────────────────────────────────────────────────────────────────
 *
 * That is not a neutral change. R6-12 is an open redirect on `/download/<token>` that was rated
 * **dormant** for exactly one reason: `release_artifacts.source_url` had no writer, so it was
 * not attacker-controllable. This module gives it one. The redirect is therefore host-validated
 * in the same change (`portal/api.ts`), and the values written here are the second half of that
 * defence: `source_url` comes from GitHub's own `browser_download_url` and nothing else, and
 * `content_type` is the gateway's choice, never the uploader's (R6-04).
 *
 * ── IDEMPOTENCE ─────────────────────────────────────────────────────────────────────────────
 *
 * Every write is an upsert keyed on the row's natural identity, so a resync of an unchanged repo
 * is a no-op in content and re-runs cleanly. Nothing is DELETEd: `release_download_tokens` holds
 * foreign keys into both `release_metadata` and `release_artifacts`, so a delete-then-reinsert
 * pass would fail under D1's foreign-key enforcement the moment one live download URL existed.
 * A release withdrawn upstream therefore leaves its row behind — stale, but inert: the portal
 * still gates every download on a live licence, and the artifact URL it holds is GitHub's, which
 * will 404 on its own. What the sync does record is that it is gone: its `release_health` row
 * turns `degraded` with `{"absentUpstream": true}` once a complete list no longer carries it.
 */

import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Db, DbStatement } from "../../core/platform.js";
import { archOf } from "./assets.js";
import type { Release, ReleaseAsset } from "./github.js";
import { compareSemver, parseSemver } from "../../core/entitlements.js";
import {
  classifyChannel,
  floorChannelOf,
  parseManualChannels,
  resolutionPolicy,
  resolveChannel,
  semverOfTag,
  versionFromTag,
  type ManualChannel,
} from "./channels.js";
import { artifactPolicy, type ReleaseConfigRow } from "./config.js";

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface ReleaseMetadataRow {
  product: string;
  release_id: string;
  version: string;
  title: string | null;
  notes: string | null;
  commit_sha: string | null;
  source_url: string | null;
  metadata_access: string;
  artifacts_access: string;
  published_at: number | null;
  metadata_json: string | null;
  created_at: number;
  modified_at: number;
}

export interface ReleaseArtifactRow {
  product: string;
  release_id: string;
  artifact_id: string;
  name: string;
  kind: string | null;
  platform: string | null;
  arch: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  source_url: string | null;
  storage_key: string | null;
  sparkle_signature: string | null;
  access: string;
  metadata_json: string | null;
  created_at: number;
}

export interface ReleaseChannelRow {
  product: string;
  channel: string;
  release_id: string | null;
  policy_json: string | null;
  created_at: number;
  modified_at: number;
}

/**
 * `release_channel_floors` (0023, R6-10): the highest version a moving channel has resolved to
 * during a truth-store sync. `release_id` is that release's tag (NULL when an operator lowered
 * the floor to a version the store never recorded).
 */
export interface ReleaseChannelFloorRow {
  product: string;
  channel: string;
  version: string;
  release_id: string | null;
  raised_at: number;
  lowered_by: string | null;
  lowered_at: number | null;
}

export interface ReleaseHealthRow {
  product: string;
  subject_kind: string;
  subject_id: string;
  status: string;
  checked_at: number;
  details_json: string | null;
}

// ── Readers ──────────────────────────────────────────────────────────────────

export async function listReleaseMetadata(
  db: Db,
  product: string,
  limit = 100,
): Promise<ReleaseMetadataRow[]> {
  return db.all<ReleaseMetadataRow>(
    `SELECT * FROM release_metadata WHERE product = ?
      ORDER BY COALESCE(published_at, 0) DESC, version DESC
      LIMIT ?`,
    product,
    limit,
  );
}

export async function listReleaseArtifacts(
  db: Db,
  product: string,
  releaseId: string,
): Promise<ReleaseArtifactRow[]> {
  return db.all<ReleaseArtifactRow>(
    `SELECT * FROM release_artifacts WHERE product = ? AND release_id = ?
      ORDER BY kind ASC, platform ASC, arch ASC, name ASC`,
    product,
    releaseId,
  );
}

export async function listReleaseChannels(
  db: Db,
  product: string,
): Promise<ReleaseChannelRow[]> {
  return db.all<ReleaseChannelRow>(
    "SELECT * FROM release_channels WHERE product = ? ORDER BY channel ASC",
    product,
  );
}

export async function listReleaseHealth(
  db: Db,
  product: string,
): Promise<ReleaseHealthRow[]> {
  return db.all<ReleaseHealthRow>(
    `SELECT * FROM release_health WHERE product = ?
      ORDER BY subject_kind ASC, subject_id ASC`,
    product,
  );
}

/**
 * Every release id the store holds for a product. The truth-store sync hands these to
 * `releaseStoreStatements` so it can mark a release that has gone from upstream (P0-03) without
 * the statement builder touching the database.
 */
export async function listStoredReleaseIds(
  db: Db,
  product: string,
): Promise<string[]> {
  const rows = await db.all<{ release_id: string }>(
    "SELECT release_id FROM release_metadata WHERE product = ? ORDER BY release_id ASC",
    product,
  );
  return rows.map((r) => r.release_id);
}

export async function listChannelFloors(
  db: Db,
  product: string,
): Promise<ReleaseChannelFloorRow[]> {
  return db.all<ReleaseChannelFloorRow>(
    "SELECT * FROM release_channel_floors WHERE product = ? ORDER BY channel ASC",
    product,
  );
}

export async function getChannelFloor(
  db: Db,
  product: string,
  channel: string,
): Promise<ReleaseChannelFloorRow | null> {
  return db.first<ReleaseChannelFloorRow>(
    "SELECT * FROM release_channel_floors WHERE product = ? AND channel = ?",
    product,
    channel,
  );
}

/**
 * True when `offered` sits below `floor` — including when nothing is offered at all. A floor or
 * an offer that is not semver cannot be ordered, so it never counts as below (a manual channel
 * over date tags is simply not floored in practice: `floorStatement` only records semver).
 */
export function isBelowFloor(
  offered: Release | null,
  floor: Pick<ReleaseChannelFloorRow, "version">,
): boolean {
  if (!parseSemver(floor.version)) return false;
  if (!offered) return true;
  const v = semverOfTag(offered.tag_name);
  return v !== null && compareSemver(v, floor.version) < 0;
}

/**
 * The tag the store recorded for a version, newest first, when there is one. Only the operator
 * floor endpoint uses it (to give a lowered floor a tag to look up); resolution never looks a
 * release up by version.
 */
export async function releaseIdForVersion(
  db: Db,
  product: string,
  version: string,
): Promise<string | null> {
  const row = await db.first<{ release_id: string }>(
    `SELECT release_id FROM release_metadata WHERE product = ? AND version = ?
      ORDER BY COALESCE(published_at, 0) DESC LIMIT 1`,
    product,
    version,
  );
  return row?.release_id ?? null;
}

/** An operator lowers a floor (R6-10). The caller has checked it is not a raise. */
export async function lowerChannelFloor(
  db: Db,
  product: string,
  channel: string,
  floor: { version: string; releaseId: string | null },
  loweredBy: string,
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE release_channel_floors
        SET version = ?, release_id = ?, lowered_by = ?, lowered_at = ?
      WHERE product = ? AND channel = ?`,
    floor.version,
    floor.releaseId,
    loweredBy,
    now,
    product,
    channel,
  );
}

/** An operator clears a floor: the channel follows the list again until the next sync. */
export async function clearChannelFloor(
  db: Db,
  product: string,
  channel: string,
): Promise<void> {
  await db.run(
    "DELETE FROM release_channel_floors WHERE product = ? AND channel = ?",
    product,
    channel,
  );
}

// ── Writers ──────────────────────────────────────────────────────────────────

/**
 * The access mode a truth-store row may carry.
 *
 * `release_metadata` and `release_artifacts` were created with
 * `CHECK (… IN ('public','authenticated','licensed'))` (0007), and `entitled` (D-13) arrived
 * after them. It is mapped to `licensed` rather than widened by migration because these columns
 * are read by ONE consumer — the customer portal — which authenticates a human with a portal
 * session, not a device with a `pkeyt_` token. There is no device grant to evaluate on that
 * path, so `entitled`'s channel/version check is not expressible there; `licensed` is the
 * strictest thing the portal CAN enforce (`hasUsableProductLicense`), which makes this a
 * tightening, never a downgrade. The `entitled` check itself lives on the device-facing routes,
 * where the token exists.
 */
function storeAccess(mode: ReleaseAccess): string {
  return mode === "entitled" ? "licensed" : mode;
}

/** Classify an asset by name: what a consumer is looking at, not what the uploader called it. */
function artifactKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sig")) return "signature";
  if (lower.endsWith(".sha256")) return "checksum";
  if (lower.endsWith(".dmg")) return "dmg";
  if (lower.endsWith(".pkg")) return "pkg";
  if (lower.endsWith(".zip") || lower.endsWith(".tar.gz")) return "archive";
  if (/\.[a-z0-9]+$/.test(lower)) return "other";
  return "cli";
}

function artifactPlatform(kind: string, name: string): string | null {
  if (kind === "dmg" || kind === "pkg") return "macos";
  const lower = name.toLowerCase();
  if (lower.includes("darwin") || lower.includes("macos")) return "macos";
  if (lower.includes("linux")) return "linux";
  if (lower.includes("windows") || lower.endsWith(".exe")) return "windows";
  return null;
}

/** The Content-Type this gateway would serve the artifact as — never the uploader's (R6-04). */
function artifactContentType(kind: string): string {
  return kind === "dmg"
    ? "application/x-apple-diskimage"
    : "application/octet-stream";
}

function publishedAtSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function stmtUpsertMetadata(row: ReleaseMetadataRow): DbStatement {
  return {
    sql: `INSERT INTO release_metadata
            (product, release_id, version, title, notes, commit_sha, source_url,
             metadata_access, artifacts_access, published_at, metadata_json,
             created_at, modified_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(product, release_id) DO UPDATE SET
            version = excluded.version,
            title = excluded.title,
            notes = excluded.notes,
            commit_sha = excluded.commit_sha,
            source_url = excluded.source_url,
            metadata_access = excluded.metadata_access,
            artifacts_access = excluded.artifacts_access,
            published_at = excluded.published_at,
            metadata_json = excluded.metadata_json,
            modified_at = excluded.modified_at`,
    params: [
      row.product,
      row.release_id,
      row.version,
      row.title,
      row.notes,
      row.commit_sha,
      row.source_url,
      row.metadata_access,
      row.artifacts_access,
      row.published_at,
      row.metadata_json,
      row.created_at,
      row.modified_at,
    ],
  };
}

function stmtUpsertArtifact(row: ReleaseArtifactRow): DbStatement {
  return {
    sql: `INSERT INTO release_artifacts
            (product, release_id, artifact_id, name, kind, platform, arch, content_type,
             size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
             metadata_json, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(product, release_id, artifact_id) DO UPDATE SET
            name = excluded.name,
            kind = excluded.kind,
            platform = excluded.platform,
            arch = excluded.arch,
            content_type = excluded.content_type,
            size_bytes = excluded.size_bytes,
            source_url = excluded.source_url,
            access = excluded.access,
            metadata_json = excluded.metadata_json`,
    params: [
      row.product,
      row.release_id,
      row.artifact_id,
      row.name,
      row.kind,
      row.platform,
      row.arch,
      row.content_type,
      row.size_bytes,
      row.sha256,
      row.source_url,
      row.storage_key,
      row.sparkle_signature,
      row.access,
      row.metadata_json,
      row.created_at,
    ],
  };
}

function stmtUpsertChannel(row: ReleaseChannelRow): DbStatement {
  return {
    sql: `INSERT INTO release_channels
            (product, channel, release_id, policy_json, created_at, modified_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(product, channel) DO UPDATE SET
            release_id = excluded.release_id,
            policy_json = excluded.policy_json,
            modified_at = excluded.modified_at`,
    params: [
      row.product,
      row.channel,
      row.release_id,
      row.policy_json,
      row.created_at,
      row.modified_at,
    ],
  };
}

function stmtUpsertHealth(row: ReleaseHealthRow): DbStatement {
  return {
    sql: `INSERT INTO release_health
            (product, subject_kind, subject_id, status, checked_at, details_json)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(product, subject_kind, subject_id) DO UPDATE SET
            status = excluded.status,
            checked_at = excluded.checked_at,
            details_json = excluded.details_json`,
    params: [
      row.product,
      row.subject_kind,
      row.subject_id,
      row.status,
      row.checked_at,
      row.details_json,
    ],
  };
}

/**
 * Raise a channel's floor to `release` when it is higher than the one read before the sync.
 *
 * The comparison is semver, which SQL cannot do, so it happens here against the row the caller
 * READ — and the write is conditioned on that row still being what was read (`version = ?`), or
 * on there still being no row (`DO NOTHING`). A concurrent sync or an operator lowering the
 * floor in between therefore makes this a no-op instead of a lost update; the next sync
 * re-evaluates. Returns null when there is nothing to raise.
 */
function floorStatement(
  product: string,
  channel: string,
  release: Release,
  current: ReleaseChannelFloorRow | undefined,
  now: number,
): DbStatement | null {
  const version = semverOfTag(release.tag_name);
  if (version === null) return null;
  if (!current) {
    return {
      sql: `INSERT INTO release_channel_floors (product, channel, version, release_id, raised_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(product, channel) DO NOTHING`,
      params: [product, channel, version, release.tag_name, now],
    };
  }
  if (
    parseSemver(current.version) &&
    compareSemver(version, current.version) <= 0
  )
    return null;
  return {
    sql: `UPDATE release_channel_floors SET version = ?, release_id = ?, raised_at = ?
           WHERE product = ? AND channel = ? AND version = ?`,
    params: [version, release.tag_name, now, product, channel, current.version],
  };
}

/**
 * The statements that make the truth store agree with a fetched GitHub release list.
 *
 * Returned rather than executed so the caller can put them in ITS batch: `resyncRepo` already
 * writes the manifest-owned rows atomically, and a truth store that landed in a second
 * transaction could survive a failure that rolled the rest back.
 *
 * ORDER IS LOAD-BEARING. `release_artifacts` and `release_channels` both carry a foreign key to
 * `release_metadata(product, release_id)`, which D1 enforces per statement inside a batch, so
 * every metadata row is emitted before anything that references it.
 *
 * ABSENT UPSTREAM (P0-03). `storedReleaseIds` is what the store held before this sync, and the
 * caller passes it ONLY when `releases` is the whole upstream list (the paginated read reached a
 * page with no `next`). Each stored release that is not among the published ones — deleted, or
 * unpublished back to a draft — gets `release_health` `degraded` with
 * `{"absentUpstream": true}`. Its metadata and artifact rows stay (see IDEMPOTENCE above). A
 * capped or cut-short list passes `null` and marks nothing: absence from a partial read proves
 * nothing. A release that comes back is re-marked by its ordinary health row on the next sync.
 */
export function releaseStoreStatements(
  product: string,
  cfg: ReleaseConfigRow,
  releases: Release[],
  now: number,
  floors: ReleaseChannelFloorRow[] = [],
  storedReleaseIds: readonly string[] | null = null,
): DbStatement[] {
  const policy = artifactPolicy(cfg);
  const candidates = resolutionPolicy(cfg);
  const metadataAccess = storeAccess(policy.access.metadata);
  const artifactsAccess = storeAccess(policy.access.artifacts);
  // Drafts are not published software. They are visible to the installation token and invisible
  // to everyone the portal serves, so ingesting them would list a release nobody can download.
  const published = releases.filter((r) => !r.draft);

  const metadata: DbStatement[] = [];
  const artifacts: DbStatement[] = [];
  const health: DbStatement[] = [];

  for (const release of published) {
    const releaseId = release.tag_name;
    metadata.push(
      stmtUpsertMetadata({
        product,
        release_id: releaseId,
        version: versionFromTag(release.tag_name),
        title: release.name,
        notes: release.body,
        commit_sha: null,
        source_url: release.html_url,
        metadata_access: metadataAccess,
        artifacts_access: artifactsAccess,
        published_at: publishedAtSeconds(release.published_at),
        metadata_json: JSON.stringify({
          tag: release.tag_name,
          prerelease: release.prerelease,
          assetCount: release.assets.length,
        }),
        created_at: now,
        modified_at: now,
      }),
    );
    for (const asset of release.assets) {
      artifacts.push(
        stmtUpsertArtifact(
          artifactRow(product, releaseId, asset, artifactsAccess, now),
        ),
      );
    }
    health.push(
      stmtUpsertHealth({
        product,
        subject_kind: "release",
        subject_id: releaseId,
        // "Has anything to download at all" is the only judgement this pass can make honestly:
        // whether the RIGHT assets are present is a per-product policy question, and answering
        // it is `checkReleaseHealth`'s job (it fetches sidecars and checks the Sparkle key).
        status: release.assets.length > 0 ? "healthy" : "degraded",
        checked_at: now,
        details_json: JSON.stringify({ assetCount: release.assets.length }),
      }),
    );
  }

  if (storedReleaseIds) {
    const upstream = new Set(published.map((r) => r.tag_name));
    for (const releaseId of storedReleaseIds) {
      if (upstream.has(releaseId)) continue;
      health.push(
        stmtUpsertHealth({
          product,
          subject_kind: "release",
          subject_id: releaseId,
          status: "degraded",
          checked_at: now,
          details_json: JSON.stringify({ absentUpstream: true }),
        }),
      );
    }
  }

  const channels: DbStatement[] = [];
  const floorStmts: DbStatement[] = [];
  const manual = parseManualChannels(cfg.manual_channels_json);
  for (const channel of channelNames(cfg)) {
    const sel = classifyChannel(channel, manual);
    // `beta` and `pr` resolve through the channel workflow when one is configured, and that is
    // a network call this pure function cannot make. `resolveChannel` falls back to the newest
    // prerelease candidate, which is the same fallback the live routes use when no workflow is
    // set — and the reason `floorChannelOf` refuses to floor `beta` when one IS set.
    const offered = sel
      ? resolveChannel(sel, published, undefined, candidates)
      : null;
    const floorName = sel ? floorChannelOf(sel, cfg) : null;
    const floor = floorName
      ? floors.find((f) => f.channel === floorName)
      : undefined;
    // R6-10. The sync read up to 1,000 releases, so a floor release that is not among them is
    // gone: the channel resolves to NOTHING rather than to the older release still listed. The
    // live route makes the same call (with a tag lookup, since it reads fewer pages), and
    // `checkReleaseHealth` names the floor so an operator can lower it deliberately.
    const regressed = floor ? isBelowFloor(offered, floor) : false;
    const resolved = regressed ? null : offered;
    if (floorName && resolved) {
      const stmt = floorStatement(product, floorName, resolved, floor, now);
      if (stmt) floorStmts.push(stmt);
    }
    channels.push(
      stmtUpsertChannel({
        product,
        channel,
        release_id: resolved ? resolved.tag_name : null,
        policy_json: null,
        created_at: now,
        modified_at: now,
      }),
    );
    health.push(
      stmtUpsertHealth({
        product,
        subject_kind: "channel",
        subject_id: channel,
        status: regressed ? "blocked" : resolved ? "healthy" : "unknown",
        checked_at: now,
        details_json: regressed
          ? JSON.stringify({
              regressed: true,
              floor: { version: floor?.version, releaseId: floor?.release_id },
              offered: offered ? offered.tag_name : null,
            })
          : resolved
            ? JSON.stringify({ releaseId: resolved.tag_name })
            : null,
      }),
    );
  }

  return [...metadata, ...artifacts, ...channels, ...floorStmts, ...health];
}

function artifactRow(
  product: string,
  releaseId: string,
  asset: ReleaseAsset,
  access: string,
  now: number,
): ReleaseArtifactRow {
  const kind = artifactKind(asset.name);
  return {
    product,
    release_id: releaseId,
    artifact_id: String(asset.id),
    name: asset.name,
    kind,
    platform: artifactPlatform(kind, asset.name),
    // Read from the NAME, because GitHub carries no arch metadata — and read through the SAME
    // helper the download matcher uses, so the store can never disagree with what is servable.
    arch: archOf(asset.name),
    content_type: artifactContentType(kind),
    size_bytes: asset.size,
    // The published `.sha256` sidecar is a separate asset; fetching every one of them during a
    // sync would be an unbounded number of subrequests against the installation quota. The
    // download route reads it on demand (`?checksum=sha256`), which is where it is needed.
    sha256: null,
    // GitHub's own URL, and only ever GitHub's. This is the value the portal's
    // `/download/<token>` redirects to, and the reason that redirect is host-validated (R6-12).
    source_url: asset.browser_download_url,
    storage_key: null,
    sparkle_signature: null,
    access,
    metadata_json: null,
    created_at: now,
  };
}

/** The channels a product declares: the two built-ins plus its manual rules. */
export function channelNames(cfg: ReleaseConfigRow): string[] {
  const manual: ManualChannel[] = parseManualChannels(cfg.manual_channels_json);
  return ["stable", "beta", ...manual.map((c) => c.name)];
}
