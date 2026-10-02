/// <reference types="@cloudflare/workers-types" />

/**
 * Whether the truth store's newest release carries a `.dmg` artifact. The "ships DMGs"
 * predicate (`shipsDmgs`) needs this for the console's setup state of a product with no
 * declared artifact map, which reads the store rather than calling GitHub the way release
 * health does.
 */
export async function latestReleaseHasDmg(
  db: Db,
  product: string,
): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    `SELECT 1 AS n
       FROM release_artifacts a
      WHERE a.product = ? AND a.kind = 'dmg'
        AND a.release_id = (
          SELECT release_id FROM release_metadata
           WHERE product = ? AND deliverable_id = ?
           ORDER BY COALESCE(published_at, 0) DESC, version DESC
           LIMIT 1)
      LIMIT 1`,
    product,
    product,
    APP_DELIVERABLE_ID,
  );
  return row != null;
}

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
 *
 * ── WHAT A RESYNC OWNS, AND WHAT IT DOES NOT (P2-03) ────────────────────────────────────────
 *
 * The sync upserts only the GitHub-derived columns. The release model v2 columns (0027) are
 * someone else's, and a resync must never clobber them:
 *
 *   release_metadata   `deliverable_id` and `channel` are written on insert only (`app`, NULL);
 *                      `seq` is assigned on insert — the deliverable's max + 1, in publication
 *                      order — and afterwards only fills a NULL left by pre-P2-03 code.
 *   release_artifacts  `sha256`, `storage_key`, `metadata_json`, `build_id` and `locations_json`
 *                      belong to the release descriptor (P2-04, `model.ts`); `role` is filled
 *                      from the name-sniffed kind when NULL and never overwritten once set.
 *
 * The product's implicit `app` deliverable is created (never modified) first in the batch, so
 * every release the sync writes belongs to a deliverable that exists.
 *
 * ── PLANNED FROM A READ, APPLIED LATER (P2-04) ──────────────────────────────────────────────
 *
 * The statements are built from what the sync read and run later, in the caller's batch. A
 * release descriptor ingested in between (P2-02's CI submit racing a webhook's sync) owns its
 * release by the time they run, so no statement may trust the plan's "undescribed": the
 * metadata upsert carries `metadata_json.descriptor` over as it is at write time, the map's
 * build upserts are guarded on the release still being undescribed (`guard.ts`), the stale-build
 * DELETE skips described releases, and the `sniffed`/`mapped` artifact upserts fall back to
 * exactly what `described` would write (`ArtifactSyncMode`).
 */

import {
  APP_DELIVERABLE_ID,
  type ManifestAppDeliverable,
} from "@polaris-key/manifest";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Db, DbStatement } from "../../core/platform.js";
import { archOf } from "./assets.js";
import { assetSha256, type Release, type ReleaseAsset } from "./github.js";
import {
  classifyByMap,
  hasArtifactMap,
  type ClassifiedFile,
} from "./artifactMap.js";
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
import {
  artifactPolicy,
  artifactsAccessSnapshot,
  type ReleaseConfigRow,
} from "./config.js";
import {
  NEXT_SEQ_SQL,
  roleOfKind,
  stmtEnsureAppDeliverable,
  stmtUpsertBuild,
} from "./model.js";
import {
  guardStatement,
  RELEASE_DESCRIBED_SQL,
  RELEASE_NOT_FOREIGN_DELIVERABLE_SQL,
} from "./guard.js";

/** What the truth-store sync needs to know about classification (P2-04). */
export interface StoreClassificationOptions {
  /** The declared app deliverable; its `artifacts` map, when non-empty, replaces sniffing. */
  app?: ManifestAppDeliverable | null;
  /** Releases with an ingested descriptor, which owns their builds and classification. */
  described?: ReadonlySet<string>;
  /** Releases whose `pkey-release.json` was refused, with the reason (degrades their health). */
  refused?: ReadonlyMap<string, string>;
  /**
   * The release rows of descriptors ingested in this pass, by release id. Each is emitted in
   * that release's own publication-order slot, just before the store's upsert of the same row,
   * so a new described release takes its `seq` in publication order like any other (P2-03).
   */
  describedRows?: ReadonlyMap<string, readonly DbStatement[]>;
}

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
  /** The deliverable this is a release of (0027_b). `app` for everything the sync writes. */
  deliverable_id: string;
  /** Publication order within the deliverable (0027_c). NULL only on a pre-P2-03 row. */
  seq: number | null;
  /** The channel a release was published to (0027_d). NULL ⇒ derive from GitHub, as today. */
  channel: string | null;
  /** An app release's `content.contentApi` (0045_a); NULL for a pack release or an app release
   *  published before its product declared packs. Optional: rows built in code omit it. */
  content_api?: number | null;
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
  /** The build this is a file of (0027_e). Written by the descriptor, never by the sync. */
  build_id: string | null;
  /** What the file is for (0027_f): `ARTIFACT_ROLES` in @polaris-key/manifest. */
  role: string | null;
  /** Hash-pinned byte locations as JSON (0027_g). Written by the descriptor, never by the sync. */
  locations_json: string | null;
}

/**
 * `release_channels`: the DERIVED "what GitHub says each channel resolves to" view, rewritten on
 * every sync. `policy_json` is not a seam — nothing reads it and the sync always writes NULL.
 * Operator-owned channel policy lives in `release_channel_policy` (0027_a, `model.ts`).
 */
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
 *
 * This is the sync's anti-rollback HIGH-WATER MARK, and it stays release's own table. It is not
 * `release_channel_policy.min_supported` (P2-03), which is the DEVICE floor the signed feed will
 * carry: folding the high-water mark into it would raise every channel's device floor to its
 * newest version and, once P3 enforces floors, block every older install. (0023's header
 * anticipated that fold; P2-03 decided against it.)
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

/**
 * The `app` deliverable's releases, newest first: the console's Releases list. A pack release
 * (P4-02) is not one of them: its rows can name thousands of content objects, and the console's
 * pack views are P4-09's.
 */
export async function listReleaseMetadata(
  db: Db,
  product: string,
  limit = 100,
): Promise<ReleaseMetadataRow[]> {
  return db.all<ReleaseMetadataRow>(
    `SELECT * FROM release_metadata WHERE product = ? AND deliverable_id = ?
      ORDER BY COALESCE(published_at, 0) DESC, version DESC
      LIMIT ?`,
    product,
    APP_DELIVERABLE_ID,
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
 * Every release id the store holds for a product that GitHub is upstream of. The truth-store
 * sync hands these to `releaseStoreStatements` so it can mark a release that has gone from
 * upstream (P0-03) without the statement builder touching the database. A release CI published
 * through a descriptor with no GitHub release behind it (P2-04: `source_url` NULL, descriptor
 * source `ci`) was never upstream, so its absence from the list means nothing. Neither was a
 * pack release (P4-02): only `app` releases come from GitHub.
 */
export async function listStoredReleaseIds(
  db: Db,
  product: string,
): Promise<string[]> {
  const rows = await db.all<{ release_id: string }>(
    `SELECT release_id FROM release_metadata
      WHERE product = ? AND deliverable_id = ?
        AND NOT (source_url IS NULL
                 AND COALESCE(json_extract(metadata_json, '$.descriptor.source'), '') = 'ci')
      ORDER BY release_id ASC`,
    product,
    APP_DELIVERABLE_ID,
  );
  return rows.map((r) => r.release_id);
}

/**
 * The release ids a NON-app deliverable holds (P4-02: pack releases, `<packId>@<version>`). The
 * truth-store sync skips a GitHub release whose tag is one of these and reports it as a
 * conflict: git allows `@` in a tag, and a GitHub release must never be merged into a pack row.
 */
export async function listForeignDeliverableReleaseIds(
  db: Db,
  product: string,
): Promise<string[]> {
  const rows = await db.all<{ release_id: string }>(
    `SELECT release_id FROM release_metadata
      WHERE product = ? AND deliverable_id <> ?
      ORDER BY release_id ASC`,
    product,
    APP_DELIVERABLE_ID,
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
    `SELECT release_id FROM release_metadata
      WHERE product = ? AND deliverable_id = ? AND version = ?
      ORDER BY COALESCE(published_at, 0) DESC LIMIT 1`,
    product,
    APP_DELIVERABLE_ID,
    version,
  );
  return row?.release_id ?? null;
}

/**
 * The app deliverable's releases as the STORE remembers them, shaped as GitHub releases (no
 * notes, no assets) so `resolveChannel` can judge channel membership over them. Includes a
 * release since deleted upstream: the store keeps its row (P0-03), and that is the point — the
 * yanked-floor fallback (`gateway.ts` `yankedFloorFallback`) must not let a deletion that
 * happened AFTER the yank lower the channel any further than the yank itself did.
 */
export async function storedAppReleases(
  db: Db,
  product: string,
): Promise<Release[]> {
  const rows = await db.all<
    Pick<
      ReleaseMetadataRow,
      "release_id" | "title" | "source_url" | "published_at" | "metadata_json"
    >
  >(
    `SELECT release_id, title, source_url, published_at, metadata_json
       FROM release_metadata WHERE product = ? AND deliverable_id = ?
      ORDER BY COALESCE(seq, 0) DESC, release_id ASC
      LIMIT 1000`,
    product,
    APP_DELIVERABLE_ID,
  );
  return rows.map((r) => {
    let prerelease = false;
    try {
      const meta = r.metadata_json
        ? (JSON.parse(r.metadata_json) as { prerelease?: unknown })
        : null;
      prerelease = meta?.prerelease === true;
    } catch {
      // An unreadable metadata blob reads as a full release, the sync's own default.
    }
    return {
      tag_name: r.release_id,
      name: r.title,
      body: null,
      published_at:
        r.published_at === null
          ? null
          : new Date(r.published_at * 1000).toISOString(),
      html_url: r.source_url ?? "",
      prerelease,
      draft: false,
      assets: [],
    };
  });
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
export function storeAccess(mode: ReleaseAccess): string {
  return mode === "entitled" ? "licensed" : mode;
}

/** Classify an asset by name: what a consumer is looking at, not what the uploader called it. */
export function artifactKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sig")) return "signature";
  if (lower.endsWith(".sha256")) return "checksum";
  if (lower.endsWith(".dmg")) return "dmg";
  if (lower.endsWith(".pkg")) return "pkg";
  if (lower.endsWith(".zip") || lower.endsWith(".tar.gz")) return "archive";
  if (/\.[a-z0-9]+$/.test(lower)) return "other";
  return "cli";
}

export function artifactPlatform(kind: string, name: string): string | null {
  if (kind === "dmg" || kind === "pkg") return "macos";
  const lower = name.toLowerCase();
  if (lower.includes("darwin") || lower.includes("macos")) return "macos";
  if (lower.includes("linux")) return "linux";
  if (lower.includes("windows") || lower.endsWith(".exe")) return "windows";
  return null;
}

/** The Content-Type this gateway would serve the artifact as — never the uploader's (R6-04). */
export function artifactContentType(kind: string): string {
  return kind === "dmg"
    ? "application/x-apple-diskimage"
    : "application/octet-stream";
}

function publishedAtSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * `deliverable_id`, `seq` and `channel` are INSERT-only (see the header): on conflict the
 * existing row keeps them, except that a NULL `seq` (a row pre-P2-03 code wrote) is filled.
 * `row.seq` is ignored — the next seq is computed inside the statement, from the rows already
 * written earlier in the same batch, so the batch's statement order IS the publication order.
 *
 * The descriptor's facts survive a resync (P2-04): `metadata_json.descriptor` (the ingested
 * descriptor's hash, or a refusal) is carried over into the rewritten `metadata_json`, and a
 * `commit_sha` the descriptor recorded is kept when GitHub has none to offer. Both are decided
 * inside the statement, against the row as it is at that moment, so a descriptor ingested
 * between this sync's read and its batch is never lost.
 *
 * Only an `app` row is ever updated (P4-02): a GitHub tag equal to a pack release id
 * (`<packId>@<version>`) leaves the pack's row exactly as its ingest wrote it.
 */
function stmtUpsertMetadata(
  row: Omit<ReleaseMetadataRow, "seq" | "channel">,
): DbStatement {
  return {
    sql: `INSERT INTO release_metadata
            (product, release_id, version, title, notes, commit_sha, source_url,
             metadata_access, artifacts_access, published_at, metadata_json,
             created_at, modified_at, deliverable_id, seq, channel)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,${NEXT_SEQ_SQL},NULL)
          ON CONFLICT(product, release_id) DO UPDATE SET
            seq = COALESCE(release_metadata.seq, excluded.seq),
            version = excluded.version,
            title = excluded.title,
            notes = excluded.notes,
            commit_sha = excluded.commit_sha,
            source_url = excluded.source_url,
            metadata_access = excluded.metadata_access,
            artifacts_access = excluded.artifacts_access,
            published_at = excluded.published_at,
            metadata_json = CASE
              WHEN json_extract(release_metadata.metadata_json, '$.descriptor') IS NULL
                THEN excluded.metadata_json
              ELSE json_set(excluded.metadata_json, '$.descriptor',
                            json(json_extract(release_metadata.metadata_json, '$.descriptor')))
            END,
            commit_sha = COALESCE(excluded.commit_sha, release_metadata.commit_sha),
            modified_at = excluded.modified_at
          WHERE release_metadata.deliverable_id = '${APP_DELIVERABLE_ID}'`,
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
      row.deliverable_id,
      row.product,
      row.deliverable_id,
    ],
  };
}

/**
 * How the sync classifies a release's files (P2-04):
 *
 *   `sniffed`    no artifact map: name sniffing, exactly as before P2-04. GitHub-derived columns
 *                only; `sha256`, `storage_key`, `metadata_json` and `locations_json` are
 *                inserted as found (NULL) and never updated; `role` is filled when NULL and never
 *                overwritten. The one addition: a file a REMOVED map had put in a build
 *                (`build_id` set on a release with no descriptor) leaves it, and its role is
 *                re-sniffed — a no-op for every release that never had a map.
 *   `mapped`     the product declares a map and the release has no descriptor: the map is the
 *                truth, so `build_id`, `role`, `platform` and `arch` follow it on every sync, and
 *                `sha256` is filled from GitHub's digest when it is still NULL.
 *   `described`  the release has an ingested descriptor, which owns its classification: only
 *                the GitHub-derived serving columns (name, size, URL, access) are refreshed.
 *
 * THE MODE IS RE-CHECKED WHEN THE STATEMENT RUNS. The sync picks `sniffed` or `mapped` from what
 * it read, and its batch lands later; a descriptor ingested in between (P2-02's CI submit, racing
 * the webhook's sync) owns the release by then. So every `sniffed`/`mapped` statement asks the
 * store, at write time, whether the release is described — and if it is, it writes exactly what
 * the `described` statement would have: a new file goes in with no build and its kind's role
 * (and not at all when the descriptor already holds a file of that name), and an existing row
 * keeps every column the descriptor owns. A stale plan can never overwrite a described release.
 */
export type ArtifactSyncMode = "sniffed" | "mapped" | "described";

/** Refreshed in every mode: the GitHub-derived serving columns. */
const ARTIFACT_SERVING_SET = `name = excluded.name,
            size_bytes = excluded.size_bytes,
            source_url = excluded.source_url,
            access = excluded.access`;

/** The columns `sniffed`/`mapped` also assign, and what to; a described release keeps its own. */
const ARTIFACT_CLASSIFYING_SET: Record<
  Exclude<ArtifactSyncMode, "described">,
  readonly (readonly [column: string, value: string])[]
> = {
  sniffed: [
    ["kind", "excluded.kind"],
    ["platform", "excluded.platform"],
    ["arch", "excluded.arch"],
    ["content_type", "excluded.content_type"],
    [
      "role",
      `CASE WHEN release_artifacts.build_id IS NULL
                        THEN COALESCE(release_artifacts.role, excluded.role)
                        ELSE excluded.role END`,
    ],
    ["build_id", "NULL"],
  ],
  mapped: [
    ["kind", "excluded.kind"],
    ["platform", "excluded.platform"],
    ["arch", "excluded.arch"],
    ["content_type", "excluded.content_type"],
    ["build_id", "excluded.build_id"],
    ["role", "excluded.role"],
    ["sha256", "COALESCE(release_artifacts.sha256, excluded.sha256)"],
  ],
};

/** The conflicting row's release has an ingested descriptor (correlated; no params). */
const CONFLICT_ROW_DESCRIBED_SQL = `EXISTS (
                 SELECT 1 FROM release_metadata d
                  WHERE d.product = release_artifacts.product
                    AND d.release_id = release_artifacts.release_id
                    AND json_extract(d.metadata_json, '$.descriptor.status') = 'ingested')`;

function artifactConflictSet(mode: ArtifactSyncMode): string {
  if (mode === "described") return ARTIFACT_SERVING_SET;
  const classifying = ARTIFACT_CLASSIFYING_SET[mode].map(
    ([column, value]) =>
      `${column} = CASE WHEN ${CONFLICT_ROW_DESCRIBED_SQL}
              THEN release_artifacts.${column}
              ELSE ${value} END`,
  );
  return [ARTIFACT_SERVING_SET, ...classifying].join(",\n            ");
}

/** The columns whose inserted value differs between a described release and the others. */
const MODE_DEPENDENT_COLUMNS = new Set<keyof ReleaseArtifactRow>([
  "platform",
  "arch",
  "sha256",
  "build_id",
  "role",
]);

const ARTIFACT_COLUMNS = [
  "product",
  "release_id",
  "artifact_id",
  "name",
  "kind",
  "platform",
  "arch",
  "content_type",
  "size_bytes",
  "sha256",
  "source_url",
  "storage_key",
  "sparkle_signature",
  "access",
  "metadata_json",
  "created_at",
  "build_id",
  "role",
  "locations_json",
] as const satisfies readonly (keyof ReleaseArtifactRow)[];

/**
 * In `described` mode a file is not inserted when the release already has a row of that NAME
 * under another id: the descriptor recorded it (an `r2`-only file is keyed by its name, not by
 * a GitHub asset id), and a second row would list it twice.
 *
 * In `sniffed`/`mapped` mode `asDescribed` is the row `described` mode would insert for the same
 * file, and the statement inserts it — under the same name rule — instead of `row` when the
 * release turns out to be described by the time it runs (see `ArtifactSyncMode`).
 *
 * In every mode nothing is written to a release a non-app deliverable holds (P4-02). The guard
 * is on the INSERT's SELECT, so the ON CONFLICT update is never reached either.
 */
function stmtUpsertArtifact(
  row: ReleaseArtifactRow,
  mode: ArtifactSyncMode = "sniffed",
  asDescribed: ReleaseArtifactRow | null = null,
): DbStatement {
  const nameTaken = `EXISTS (
              SELECT 1 FROM release_artifacts
               WHERE product = ? AND release_id = ? AND name = ? AND artifact_id <> ?)`;
  const nameParams = [row.product, row.release_id, row.name, row.artifact_id];
  let values: string;
  let params: unknown[];
  if (mode === "described") {
    values = `SELECT ${ARTIFACT_COLUMNS.map(() => "?").join(",")}
          WHERE NOT ${nameTaken} AND ${RELEASE_NOT_FOREIGN_DELIVERABLE_SQL}`;
    params = [
      ...ARTIFACT_COLUMNS.map((c) => row[c]),
      ...nameParams,
      row.product,
      row.release_id,
    ];
  } else {
    if (!asDescribed)
      throw new Error("stmtUpsertArtifact: sniffed/mapped need asDescribed");
    const select: string[] = [];
    params = [];
    for (const c of ARTIFACT_COLUMNS) {
      if (MODE_DEPENDENT_COLUMNS.has(c)) {
        select.push("CASE WHEN g.described THEN ? ELSE ? END");
        params.push(asDescribed[c], row[c]);
      } else {
        select.push("?");
        params.push(row[c]);
      }
    }
    values = `SELECT ${select.join(",\n                 ")}
            FROM (SELECT ${RELEASE_DESCRIBED_SQL} AS described) AS g
           WHERE NOT (g.described AND ${nameTaken})
             AND ${RELEASE_NOT_FOREIGN_DELIVERABLE_SQL}`;
    params.push(
      row.product,
      row.release_id,
      ...nameParams,
      row.product,
      row.release_id,
    );
  }
  return {
    sql: `INSERT INTO release_artifacts
            (${ARTIFACT_COLUMNS.join(", ")})
          ${values}
          ON CONFLICT(product, release_id, artifact_id) DO UPDATE SET
            ${artifactConflictSet(mode)}`,
    params: params as DbStatement["params"],
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
 * The releases the store records from a listing — the published ones plus the `held` floor
 * releases the list did not reach — in publication order, the same order 0027_h's backfill
 * numbers `seq` in: an undated release first (SQLite sorts NULL low), then by date, ties by tag.
 * `releaseStoreStatements` upserts the rows in exactly this order, so it is also the order in
 * which new releases take their `seq`; the descriptor ingest (P2-04) plans explicit seqs against
 * it.
 */
export function releasesInPublicationOrder(
  releases: readonly Release[],
  held: readonly Release[] = [],
): Release[] {
  const published = releases.filter((r) => !r.draft);
  return [
    ...published,
    ...held.filter(
      (h) => !h.draft && !published.some((p) => p.tag_name === h.tag_name),
    ),
  ]
    .map((release) => ({
      release,
      at: publishedAtSeconds(release.published_at),
    }))
    .sort(
      (a, b) =>
        (a.at ?? -Infinity) - (b.at ?? -Infinity) ||
        (a.release.tag_name < b.release.tag_name
          ? -1
          : a.release.tag_name > b.release.tag_name
            ? 1
            : 0),
    )
    .map((x) => x.release);
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
 * every metadata row is emitted before anything that references it — and the `app` deliverable
 * before everything. The metadata rows themselves go out oldest first, (published_at,
 * release_id), because each new one takes the next `seq` in statement order (P2-03). A release
 * whose descriptor this pass ingested (`opts.describedRows`) has its descriptor row emitted in
 * that same slot, so an explicit or computed `seq` never jumps ahead of an older new release.
 *
 * ABSENT UPSTREAM (P0-03). `storedReleaseIds` is what the store held before this sync, and the
 * caller passes it ONLY when `releases` is the whole upstream list (the paginated read reached a
 * page with no `next`). Each stored release that is not among the published ones (nor among the
 * `held` floor releases a tag lookup found) — deleted, or unpublished back to a draft — gets
 * `release_health` `degraded` with `{"absentUpstream": true}`. Its metadata and artifact rows
 * stay (see IDEMPOTENCE above). A capped or cut-short list passes `null` and marks nothing:
 * absence from a partial read proves nothing. A release that comes back is re-marked by its
 * ordinary health row on the next sync.
 */
export function releaseStoreStatements(
  product: string,
  cfg: ReleaseConfigRow,
  releases: Release[],
  now: number,
  floors: ReleaseChannelFloorRow[] = [],
  /**
   * Floor releases the (capped) list did not reach but a tag lookup found (`sync.ts`). They are
   * recorded like any listed release and hold their channel up exactly as the live route's own
   * lookup does; they are NOT candidates for any other channel, since the live route would not
   * have read them either.
   */
  held: Release[] = [],
  storedReleaseIds: readonly string[] | null = null,
  /** How files are classified, and what the descriptor ingest has already decided (P2-04). */
  opts: StoreClassificationOptions = {},
): DbStatement[] {
  const map = hasArtifactMap(opts.app) ? opts.app : null;
  const policy = artifactPolicy(cfg);
  const candidates = resolutionPolicy(cfg);
  const metadataAccess = storeAccess(policy.access.metadata);
  const artifactsAccess = storeAccess(artifactsAccessSnapshot(cfg));
  // Drafts are not published software. They are visible to the installation token and invisible
  // to everyone the portal serves, so ingesting them would list a release nobody can download.
  const published = releases.filter((r) => !r.draft);
  const inPublishOrder = releasesInPublicationOrder(releases, held);

  const metadata: DbStatement[] = [];
  const artifacts: DbStatement[] = [];
  const builds: DbStatement[] = [];
  const health: DbStatement[] = [];
  /** `release_id` + NUL + `build_id` of every build the map classified, across the listing. */
  const mappedBuildKeys: string[] = [];
  const undescribedReleaseIds: string[] = [];

  // A described release's row that has no slot here (none should) still goes before anything
  // that references it.
  const slotted = new Set(inPublishOrder.map((r) => r.tag_name));
  for (const [releaseId, rows] of opts.describedRows ?? [])
    if (!slotted.has(releaseId)) metadata.push(...rows);

  for (const release of inPublishOrder) {
    const releaseId = release.tag_name;
    metadata.push(...(opts.describedRows?.get(releaseId) ?? []));
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
        deliverable_id: APP_DELIVERABLE_ID,
      }),
    );
    const described = opts.described?.has(releaseId) ?? false;
    const mode: ArtifactSyncMode = described
      ? "described"
      : map
        ? "mapped"
        : "sniffed";
    // A described release is never classified by the map: the descriptor owns its builds, so a
    // GitHub file it does not name is inserted in no build (`build_id` NULL, role from its kind),
    // exactly as the descriptor's own ingest leaves such a file. Taking the map's build here would
    // point the new row at a build the descriptor never wrote, and nothing would prune it.
    const classified =
      map && !described
        ? classifyByMap(
            map,
            release.assets.map((a) => a.name),
          )
        : null;
    for (const asset of release.assets) {
      const row = (m: ArtifactSyncMode) =>
        artifactRow(
          product,
          releaseId,
          asset,
          artifactsAccess,
          now,
          m === "described"
            ? null
            : (classified?.files.get(asset.name) ?? null),
          m,
        );
      artifacts.push(
        stmtUpsertArtifact(
          row(mode),
          mode,
          mode === "described" ? null : row("described"),
        ),
      );
    }
    // The map's builds, for a release the descriptor does not own. They follow the map: a build
    // the map no longer yields is deleted below (nothing references `release_builds`). Each is
    // written only if the release is still undescribed when the batch runs: a descriptor
    // ingested after this sync read the store owns the builds (and their build numbers) by then.
    if (!described) undescribedReleaseIds.push(releaseId);
    if (classified) {
      for (const entry of classified.builds) {
        mappedBuildKeys.push(`${releaseId}\u0000${entry.id}`);
        builds.push(
          guardStatement(
            stmtUpsertBuild(
              {
                product,
                releaseId,
                buildId: entry.id,
                platform: entry.platform,
                arch: entry.arch,
                format: entry.format,
              },
              now,
            ),
            `NOT ${RELEASE_DESCRIBED_SQL} AND ${RELEASE_NOT_FOREIGN_DELIVERABLE_SQL}`,
            [product, releaseId, product, releaseId],
          ),
        );
      }
    }
    const refused = opts.refused?.get(releaseId);
    health.push(
      guardStatement(
        stmtUpsertHealth({
          product,
          subject_kind: "release",
          subject_id: releaseId,
          // "Has anything to download at all" is the only judgement this pass can make honestly:
          // whether the RIGHT assets are present is a per-product policy question, and answering
          // it is `checkReleaseHealth`'s job (it fetches sidecars and checks the Sparkle key). A
          // refused `pkey-release.json` (P2-04) degrades the release, with the reason.
          status: refused
            ? "degraded"
            : release.assets.length > 0
              ? "healthy"
              : "degraded",
          checked_at: now,
          details_json: JSON.stringify({
            assetCount: release.assets.length,
            ...(refused ? { descriptor: { refused } } : {}),
          }),
        }),
        RELEASE_NOT_FOREIGN_DELIVERABLE_SQL,
        [product, releaseId],
      ),
    );
  }
  // Builds a listed release no longer has under the map (the map changed or was removed, or a
  // file left). ONE statement per sync, map or not. A release that has an ingested descriptor by
  // the time this runs is skipped by the subquery — the descriptor owns its builds — even when
  // it was ingested after this sync read the store. Only `app` releases' builds are touched: a
  // pack release's builds are its ingest's (P4-02).
  {
    builds.push({
      sql: `DELETE FROM release_builds
             WHERE product = ?
               AND release_id IN (SELECT value FROM json_each(?))
               AND release_id NOT IN (
                 SELECT release_id FROM release_metadata
                  WHERE product = ?
                    AND json_extract(metadata_json, '$.descriptor.status') = 'ingested')
               AND release_id IN (
                 SELECT release_id FROM release_metadata
                  WHERE product = ? AND deliverable_id = '${APP_DELIVERABLE_ID}')
               AND (release_id || char(0) || build_id) NOT IN (SELECT value FROM json_each(?))`,
      params: [
        product,
        JSON.stringify(undescribedReleaseIds),
        product,
        product,
        JSON.stringify(mappedBuildKeys),
      ],
    });
  }

  if (storedReleaseIds) {
    const upstream = new Set(inPublishOrder.map((r) => r.tag_name));
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
    // R6-10. A floor release that is neither in the list nor in `held` is gone: the channel
    // resolves to NOTHING rather than to the older release still listed. The live route makes
    // the same call, and `checkReleaseHealth` names the floor so an operator can lower it
    // deliberately. One the capped list did not reach but a tag lookup found (`held`) still
    // holds the channel up — the same answer, and the same "is it still something this selector
    // would pick" test, as `resolveMovingSelector`.
    const below = floor ? isBelowFloor(offered, floor) : false;
    const holding =
      below && floor && sel
        ? (held.find((h) =>
            floor.release_id
              ? h.tag_name === floor.release_id
              : semverOfTag(h.tag_name) === floor.version,
          ) ?? null)
        : null;
    const heldUp =
      holding && sel && resolveChannel(sel, [holding], undefined, candidates)
        ? holding
        : null;
    const regressed = below && !heldUp;
    const resolved = regressed ? null : (heldUp ?? offered);
    if (floorName && resolved) {
      const stmt = floorStatement(product, floorName, resolved, floor, now);
      if (stmt) floorStmts.push(stmt);
    }
    channels.push(
      stmtUpsertChannel({
        product,
        channel,
        release_id: resolved ? resolved.tag_name : null,
        // Not a seam: operator policy is `release_channel_policy` (model.ts).
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

  return [
    stmtEnsureAppDeliverable(product, now),
    ...metadata,
    ...builds,
    ...artifacts,
    ...channels,
    ...floorStmts,
    ...health,
  ];
}

function artifactRow(
  product: string,
  releaseId: string,
  asset: ReleaseAsset,
  access: string,
  now: number,
  classified: ClassifiedFile | null = null,
  mode: ArtifactSyncMode = "sniffed",
): ReleaseArtifactRow {
  const kind = artifactKind(asset.name);
  // Under a map (P2-04), the declaration is the truth and an unmatched file has no platform or
  // arch at all; sniffing runs only for a product that declares no map.
  const sniffed = mode === "sniffed";
  return {
    product,
    release_id: releaseId,
    artifact_id: String(asset.id),
    name: asset.name,
    kind,
    platform: sniffed
      ? artifactPlatform(kind, asset.name)
      : (classified?.platform ?? null),
    // Read from the NAME, because GitHub carries no arch metadata — and read through the SAME
    // helper the download matcher uses, so the store can never disagree with what is servable.
    arch: sniffed ? archOf(asset.name) : (classified?.arch ?? null),
    content_type: artifactContentType(kind),
    size_bytes: asset.size,
    // The published `.sha256` sidecar is a separate asset; fetching every one of them during a
    // sync would be an unbounded number of subrequests against the installation quota. The
    // download route reads it on demand (`?checksum=sha256`), which is where it is needed.
    // Under a map, GitHub's own digest of the bytes is recorded when it has one (P2-04).
    sha256: sniffed ? null : assetSha256(asset),
    // GitHub's own URL, and only ever GitHub's. This is the value the portal's
    // `/download/<token>` redirects to, and the reason that redirect is host-validated (R6-12).
    source_url: asset.browser_download_url,
    storage_key: null,
    sparkle_signature: null,
    access,
    metadata_json: null,
    created_at: now,
    // A legacy release has no build, and its role comes from the kind; under a map, both come
    // from the declaration (an unmatched file is in no build).
    build_id: classified?.buildId ?? null,
    role: classified?.role ?? roleOfKind(kind),
    locations_json: null,
  };
}

/** The channels a product declares: the two built-ins plus its manual rules. */
export function channelNames(cfg: ReleaseConfigRow): string[] {
  const manual: ManualChannel[] = parseManualChannels(cfg.manual_channels_json);
  return ["stable", "beta", ...manual.map((c) => c.name)];
}
