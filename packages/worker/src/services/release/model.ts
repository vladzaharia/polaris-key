/// <reference types="@cloudflare/workers-types" />

/**
 * The release data model v2 (P2-03, README §3.4): deliverables, builds, artifact roles, the
 * operator-owned channel policy and yanks — the read/write surface over `0027_*`.
 *
 * ── WHO USES THIS ───────────────────────────────────────────────────────────────────────────
 *
 * P2-04's descriptor ingest writes deliverables, builds and artifacts through it; P2-05 reads
 * them for resolution and owns the policy OPERATIONS (promote, pin, yank, the admin routes) on
 * top of the primitives here; P2b-01 exposes them through the `releaseCatalog` hook. Nothing in
 * this package changes a route or a resolution: the GitHub sync (`store.ts`) is today's only
 * writer, and it only keeps these tables consistent (the implicit `app` deliverable, `seq`,
 * `role`) without reading them back.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────────────────────
 *
 * Every writer comes in two forms: a pure `stmt*` builder returning a `DbStatement`, so a caller
 * can put it in ITS batch (the descriptor ingest writes a release, its builds, its artifacts and
 * its blob refs atomically), and an async convenience that runs that one statement.
 *
 * Platform, arch and role are free TEXT in D1 (a CHECK change is a table rebuild, and the lists
 * grow), so they are validated HERE against `@polaris-key/manifest`'s vocabularies. A bad value
 * is a programming error in the caller — which has validated its own input and answered 400
 * already — so it throws `ReleaseModelError` rather than returning a result.
 */

import {
  APP_DELIVERABLE_ID,
  ARTIFACT_ROLES,
  DELIVERABLE_KINDS,
  isDeliverableId,
  RELEASE_ARCHES,
  RELEASE_PLATFORMS,
  type ArtifactRole,
  type DeliverableKind,
} from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../core/platform.js";
import type { ReleaseArtifactRow } from "./store.js";

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface ReleaseDeliverableRow {
  product: string;
  deliverable_id: string;
  kind: DeliverableKind;
  pack_type: string | null;
  def_json: string | null;
  def_source: string;
  created_at: number;
  modified_at: number;
  /** A package's ecosystem and declared name (F-03, 0055_b); NULL for the app and packs. */
  ecosystem?: string | null;
  package_name?: string | null;
}

/**
 * SQL true when release row `alias` (a `release_metadata` alias) is NOT a release of a package
 * deliverable (F-03). Every device-facing read that can reach a release by id or digest — the
 * byte routes' file and blob resolution, the changelog, the records route — filters with it, so a
 * package version is served only by its feed. No parameters.
 */
export function notPackageReleaseSql(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM release_deliverables pkgd
                      WHERE pkgd.product = ${alias}.product
                        AND pkgd.deliverable_id = ${alias}.deliverable_id
                        AND pkgd.kind = 'package')`;
}

export interface ReleaseBuildRow {
  product: string;
  release_id: string;
  build_id: string;
  /** NULL = platform-independent (a pack variant). */
  platform: string | null;
  arch: string;
  format: string | null;
  build_number: string | null;
  variant_json: string | null;
  requires_json: string | null;
  min_os: string | null;
  /** The descriptor's `builds[].metadata` (P2b-05, migration 0043), JSON; NULL when absent. */
  metadata_json: string | null;
  /** The descriptor's `builds[].embeds` (P4-02, migration 0045), a JSON array; NULL when absent. */
  embeds_json: string | null;
  created_at: number;
  modified_at: number;
}

export type PolicySource = "manifest" | "admin";

export interface ReleaseChannelPolicyRow {
  product: string;
  deliverable_id: string;
  channel: string;
  pointer_release_id: string | null;
  pinned: number;
  includes_json: string | null;
  min_supported: string | null;
  critical: number;
  source: PolicySource;
  created_at: number;
  modified_at: number;
  modified_by: string | null;
}

export interface ReleaseYankRow {
  product: string;
  release_id: string;
  reason: string;
  at: number;
  by: string;
}

export class ReleaseModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseModelError";
  }
}

// ── Validation against the exported vocabularies ─────────────────────────────

function oneOf<T extends string>(
  list: readonly T[],
  value: string,
): value is T {
  return (list as readonly string[]).includes(value);
}

function assertDeliverableId(id: string): void {
  if (!isDeliverableId(id))
    throw new ReleaseModelError(
      `invalid deliverable id: ${JSON.stringify(id)}`,
    );
}

function assertBuild(build: BuildInput): void {
  if (!build.buildId)
    throw new ReleaseModelError("a build needs a non-empty build id");
  if (build.platform != null && !oneOf(RELEASE_PLATFORMS, build.platform))
    throw new ReleaseModelError(`unknown platform: ${build.platform}`);
  if (build.arch !== undefined && !oneOf(RELEASE_ARCHES, build.arch))
    throw new ReleaseModelError(`unknown arch: ${build.arch}`);
}

/** The role a legacy (name-sniffed) artifact kind maps to — the 0027_h backfill's rule. */
export function roleOfKind(kind: string | null): ArtifactRole {
  if (kind === "signature") return "signature";
  if (kind === "checksum") return "checksum";
  return "payload";
}

// ── seq ──────────────────────────────────────────────────────────────────────

/**
 * The next `seq` for a deliverable as a SQL scalar subquery, with its two params
 * (`product`, `deliverable_id`). Evaluated INSIDE the statement that inserts the release, so a
 * batch that inserts several releases numbers them consecutively in statement order, and the
 * unique `idx_release_metadata_seq` turns any race into a failed batch rather than a duplicate.
 */
export const NEXT_SEQ_SQL =
  "(SELECT COALESCE(MAX(seq), 0) + 1 FROM release_metadata WHERE product = ? AND deliverable_id = ?)";

/** The `seq` the next release of this deliverable would get (publication order, not version). */
export async function nextSeq(
  db: Db,
  product: string,
  deliverableId: string,
): Promise<number> {
  const row = await db.first<{ seq: number }>(
    `SELECT ${NEXT_SEQ_SQL} AS seq`,
    product,
    deliverableId,
  );
  return row?.seq ?? 1;
}

// ── Deliverables ─────────────────────────────────────────────────────────────

export interface DeliverableInput {
  product: string;
  deliverableId: string;
  kind: DeliverableKind;
  packType?: string | null;
  defJson?: string | null;
  defSource?: string;
  /** A package's ecosystem and declared name (F-03); required for, and only for, a package. */
  ecosystem?: string | null;
  packageName?: string | null;
}

export async function listDeliverables(
  db: Db,
  product: string,
): Promise<ReleaseDeliverableRow[]> {
  return db.all<ReleaseDeliverableRow>(
    `SELECT * FROM release_deliverables WHERE product = ?
      ORDER BY CASE kind WHEN 'app' THEN 0 ELSE 1 END, deliverable_id ASC`,
    product,
  );
}

export async function getDeliverable(
  db: Db,
  product: string,
  deliverableId: string,
): Promise<ReleaseDeliverableRow | null> {
  return db.first<ReleaseDeliverableRow>(
    "SELECT * FROM release_deliverables WHERE product = ? AND deliverable_id = ?",
    product,
    deliverableId,
  );
}

/** Create or replace a deliverable's declaration (P2-04's resync writes `def_source = 'manifest'`). */
export function stmtUpsertDeliverable(
  d: DeliverableInput,
  now: number,
): DbStatement {
  assertDeliverableId(d.deliverableId);
  if (!oneOf(DELIVERABLE_KINDS, d.kind))
    throw new ReleaseModelError(`unknown deliverable kind: ${d.kind}`);
  if (d.kind === "app" && d.packType)
    throw new ReleaseModelError("an app deliverable has no pack type");
  const isPackage = d.kind === "package";
  if (isPackage !== Boolean(d.ecosystem && d.packageName))
    throw new ReleaseModelError(
      "a package deliverable has an ecosystem and a name, and only a package does",
    );
  if (isPackage && d.packType)
    throw new ReleaseModelError("a package deliverable has no pack type");
  return {
    sql: `INSERT INTO release_deliverables
            (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at,
             ecosystem, package_name)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(product, deliverable_id) DO UPDATE SET
            kind = excluded.kind,
            pack_type = excluded.pack_type,
            def_json = excluded.def_json,
            def_source = excluded.def_source,
            modified_at = excluded.modified_at,
            ecosystem = excluded.ecosystem,
            package_name = excluded.package_name`,
    params: [
      d.product,
      d.deliverableId,
      d.kind,
      d.packType ?? null,
      d.defJson ?? null,
      d.defSource ?? "manifest",
      now,
      now,
      isPackage ? d.ecosystem! : null,
      isPackage ? d.packageName! : null,
    ],
  };
}

export async function upsertDeliverable(
  db: Db,
  d: DeliverableInput,
  now: number,
): Promise<void> {
  const s = stmtUpsertDeliverable(d, now);
  await db.run(s.sql, ...s.params);
}

/**
 * Make sure the product's implicit `app` deliverable exists, without touching a declaration
 * someone already wrote. The GitHub sync emits this first in its batch, so a product linked
 * after 0027 has the row every release and channel policy of it refers to.
 */
export function stmtEnsureAppDeliverable(
  product: string,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO release_deliverables
            (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at)
          VALUES (?, ?, 'app', NULL, NULL, 'manifest', ?, ?)
          ON CONFLICT(product, deliverable_id) DO NOTHING`,
    params: [product, APP_DELIVERABLE_ID, now, now],
  };
}

// ── Builds ───────────────────────────────────────────────────────────────────

export interface BuildInput {
  product: string;
  releaseId: string;
  buildId: string;
  platform?: string | null;
  /** Defaults to `any`. */
  arch?: string;
  format?: string | null;
  buildNumber?: string | null;
  variantJson?: string | null;
  requiresJson?: string | null;
  minOs?: string | null;
  /** The descriptor's `builds[].metadata`, serialised (P2b-05). */
  metadataJson?: string | null;
  /** The descriptor's `builds[].embeds`, serialised (P4-02); NULL when it omits them. */
  embedsJson?: string | null;
}

export async function listBuilds(
  db: Db,
  product: string,
  releaseId: string,
): Promise<ReleaseBuildRow[]> {
  return db.all<ReleaseBuildRow>(
    `SELECT * FROM release_builds WHERE product = ? AND release_id = ?
      ORDER BY build_id ASC`,
    product,
    releaseId,
  );
}

/** Create or replace one build. The release row must already exist (FK), earlier in the batch. */
export function stmtUpsertBuild(b: BuildInput, now: number): DbStatement {
  assertBuild(b);
  return {
    sql: `INSERT INTO release_builds
            (product, release_id, build_id, platform, arch, format, build_number,
             variant_json, requires_json, min_os, metadata_json, embeds_json, created_at,
            modified_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(product, release_id, build_id) DO UPDATE SET
            platform = excluded.platform,
            arch = excluded.arch,
            format = excluded.format,
            build_number = excluded.build_number,
            variant_json = excluded.variant_json,
            requires_json = excluded.requires_json,
            min_os = excluded.min_os,
            metadata_json = excluded.metadata_json,
            embeds_json = excluded.embeds_json,
            modified_at = excluded.modified_at`,
    params: [
      b.product,
      b.releaseId,
      b.buildId,
      b.platform ?? null,
      b.arch ?? "any",
      b.format ?? null,
      b.buildNumber ?? null,
      b.variantJson ?? null,
      b.requiresJson ?? null,
      b.minOs ?? null,
      b.metadataJson ?? null,
      b.embedsJson ?? null,
      now,
      now,
    ],
  };
}

export async function upsertBuild(
  db: Db,
  b: BuildInput,
  now: number,
): Promise<void> {
  const s = stmtUpsertBuild(b, now);
  await db.run(s.sql, ...s.params);
}

// ── Artifacts ────────────────────────────────────────────────────────────────

export async function listArtifactsForBuild(
  db: Db,
  product: string,
  releaseId: string,
  buildId: string,
): Promise<ReleaseArtifactRow[]> {
  return db.all<ReleaseArtifactRow>(
    `SELECT * FROM release_artifacts
      WHERE product = ? AND release_id = ? AND build_id = ?
      ORDER BY CASE role WHEN 'payload' THEN 0 ELSE 1 END, role ASC, name ASC`,
    product,
    releaseId,
    buildId,
  );
}

/**
 * The descriptor-owned facts about one artifact: which build it belongs to, its role, its hash
 * and where its bytes are (hash-pinned). These are exactly the columns the GitHub sync never
 * overwrites, so a resync after this write leaves them alone.
 */
export interface ArtifactModelInput {
  product: string;
  releaseId: string;
  artifactId: string;
  buildId: string | null;
  role: ArtifactRole;
  sha256?: string | null;
  storageKey?: string | null;
  locationsJson?: string | null;
  metadataJson?: string | null;
}

/**
 * Attach the descriptor's facts to an artifact row the sync (or the ingest's own insert) wrote.
 * An UPDATE, not an upsert: the GitHub-derived columns (name, source URL, size, access) are the
 * sync's, and `source_url` in particular only ever holds GitHub's own URL (R6-12).
 */
export function stmtSetArtifactModel(a: ArtifactModelInput): DbStatement {
  if (!oneOf(ARTIFACT_ROLES, a.role))
    throw new ReleaseModelError(`unknown artifact role: ${a.role}`);
  if (a.sha256 != null && !/^[0-9a-f]{64}$/.test(a.sha256))
    throw new ReleaseModelError("sha256 must be 64 lower-case hex characters");
  return {
    sql: `UPDATE release_artifacts
             SET build_id = ?, role = ?, sha256 = ?, storage_key = ?, locations_json = ?,
                 metadata_json = ?
           WHERE product = ? AND release_id = ? AND artifact_id = ?`,
    params: [
      a.buildId,
      a.role,
      a.sha256 ?? null,
      a.storageKey ?? null,
      a.locationsJson ?? null,
      a.metadataJson ?? null,
      a.product,
      a.releaseId,
      a.artifactId,
    ],
  };
}

// ── Channel policy ───────────────────────────────────────────────────────────

export interface ChannelKey {
  product: string;
  deliverableId: string;
  channel: string;
}

/**
 * The fields a policy write may set. An omitted field is left as it is on an existing row and
 * takes its default (NULL / 0) on a new one, so a manifest write of `includes` never resets an
 * operator's pointer, and a promote never resets the manifest's `includes`.
 */
export interface ChannelPolicyPatch {
  pointerReleaseId?: string | null;
  pinned?: boolean;
  includes?: readonly string[] | null;
  minSupported?: string | null;
  critical?: boolean;
}

export interface PolicyWriter {
  /** `manifest` for a resync; `admin` for ANY operator or CI change. */
  source: PolicySource;
  /** `manifest`, `admin:<sub>` or `ci:<subject>` — recorded in `modified_by`. */
  by: string;
  now: number;
}

export async function getChannelPolicy(
  db: Db,
  key: ChannelKey,
): Promise<ReleaseChannelPolicyRow | null> {
  return db.first<ReleaseChannelPolicyRow>(
    `SELECT * FROM release_channel_policy
      WHERE product = ? AND deliverable_id = ? AND channel = ?`,
    key.product,
    key.deliverableId,
    key.channel,
  );
}

export async function listChannelPolicies(
  db: Db,
  product: string,
  deliverableId?: string,
): Promise<ReleaseChannelPolicyRow[]> {
  if (deliverableId === undefined)
    return db.all<ReleaseChannelPolicyRow>(
      `SELECT * FROM release_channel_policy WHERE product = ?
        ORDER BY deliverable_id ASC, channel ASC`,
      product,
    );
  return db.all<ReleaseChannelPolicyRow>(
    `SELECT * FROM release_channel_policy WHERE product = ? AND deliverable_id = ?
      ORDER BY channel ASC`,
    product,
    deliverableId,
  );
}

const POLICY_COLUMNS: Record<
  keyof ChannelPolicyPatch,
  { column: string; encode: (v: never) => string | number | null }
> = {
  pointerReleaseId: {
    column: "pointer_release_id",
    encode: (v: string | null) => v,
  },
  pinned: { column: "pinned", encode: (v: boolean) => (v ? 1 : 0) },
  includes: {
    column: "includes_json",
    encode: (v: readonly string[] | null) => (v ? JSON.stringify(v) : null),
  },
  minSupported: { column: "min_supported", encode: (v: string | null) => v },
  critical: { column: "critical", encode: (v: boolean) => (v ? 1 : 0) },
};

/**
 * Write a channel's policy, source-guarded (the `services_source` precedent, `repo.ts`):
 *
 *   - `source: "admin"` (any operator or CI change) always applies and claims the row: `source`
 *     becomes `admin`, and resync leaves it alone from then on.
 *   - `source: "manifest"` (a resync) applies only while the row is still manifest-owned. The
 *     guard is a `WHERE` on the upsert itself, not a read-then-write in the caller, so an
 *     operator's concurrent claim can never be overwritten by a sync that read the row first.
 */
export function stmtSetChannelPolicy(
  key: ChannelKey,
  patch: ChannelPolicyPatch,
  writer: PolicyWriter,
): DbStatement {
  assertDeliverableId(key.deliverableId);
  if (!key.channel) throw new ReleaseModelError("a policy needs a channel");
  if (
    patch.includes != null &&
    (!Array.isArray(patch.includes) ||
      patch.includes.some((c) => typeof c !== "string" || !c))
  )
    throw new ReleaseModelError("includes must be an array of channel names");

  const insert: Record<string, string | number | null> = {
    pointer_release_id: null,
    pinned: 0,
    includes_json: null,
    min_supported: null,
    critical: 0,
  };
  const updates: string[] = [];
  for (const [field, spec] of Object.entries(POLICY_COLUMNS) as [
    keyof ChannelPolicyPatch,
    (typeof POLICY_COLUMNS)[keyof ChannelPolicyPatch],
  ][]) {
    if (patch[field] === undefined) continue;
    insert[spec.column] = spec.encode(patch[field] as never);
    updates.push(`${spec.column} = excluded.${spec.column}`);
  }
  updates.push(
    "source = excluded.source",
    "modified_at = excluded.modified_at",
    "modified_by = excluded.modified_by",
  );
  const guard =
    writer.source === "manifest"
      ? "\n          WHERE release_channel_policy.source = 'manifest'"
      : "";
  return {
    sql: `INSERT INTO release_channel_policy
            (product, deliverable_id, channel, pointer_release_id, pinned, includes_json,
             min_supported, critical, source, created_at, modified_at, modified_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(product, deliverable_id, channel) DO UPDATE SET
            ${updates.join(",\n            ")}${guard}`,
    params: [
      key.product,
      key.deliverableId,
      key.channel,
      insert.pointer_release_id ?? null,
      insert.pinned ?? 0,
      insert.includes_json ?? null,
      insert.min_supported ?? null,
      insert.critical ?? 0,
      writer.source,
      writer.now,
      writer.now,
      writer.by,
    ],
  };
}

/** Run one policy write. True when it changed the row; false when the source guard held. */
export async function setChannelPolicy(
  db: Db,
  key: ChannelKey,
  patch: ChannelPolicyPatch,
  writer: PolicyWriter,
): Promise<boolean> {
  const s = stmtSetChannelPolicy(key, patch, writer);
  return (await db.runChanges(s.sql, ...s.params)) > 0;
}

/**
 * Hand a channel's policy back to the manifest. Only the OWNER flips — the values stay as the
 * operator left them until the next resync re-applies the manifest's declaration (the
 * `revertServicesToManifest` precedent). True when a row existed.
 */
export async function revertChannelPolicyToManifest(
  db: Db,
  key: ChannelKey,
  by: string,
  now: number,
): Promise<boolean> {
  return (
    (await db.runChanges(
      `UPDATE release_channel_policy
          SET source = 'manifest', modified_at = ?, modified_by = ?
        WHERE product = ? AND deliverable_id = ? AND channel = ?`,
      now,
      by,
      key.product,
      key.deliverableId,
      key.channel,
    )) > 0
  );
}

// ── Yanks ────────────────────────────────────────────────────────────────────

/**
 * Yank a release: it stops resolving on every moving selector and remains reachable only through
 * an explicit pin (README §3.4). Nothing is deleted. Re-yanking updates the reason and actor.
 */
export function stmtYankRelease(
  product: string,
  releaseId: string,
  reason: string,
  by: string,
  now: number,
): DbStatement {
  if (!reason.trim())
    throw new ReleaseModelError("a yank needs a non-empty reason");
  return {
    sql: `INSERT INTO release_yanks (product, release_id, reason, at, by)
          VALUES (?,?,?,?,?)
          ON CONFLICT(product, release_id) DO UPDATE SET
            reason = excluded.reason, at = excluded.at, by = excluded.by`,
    params: [product, releaseId, reason, now, by],
  };
}

export async function yankRelease(
  db: Db,
  product: string,
  releaseId: string,
  reason: string,
  by: string,
  now: number,
): Promise<void> {
  const s = stmtYankRelease(product, releaseId, reason, by, now);
  await db.run(s.sql, ...s.params);
}

/** Lift a yank, never for a revoked release: a revocation is permanent, and its ingest yanked
 *  the target (plans/P4-13.md §6.2), so the guard keeps that yank even under a race. The same
 *  holds for a release signed under a revoked delegation (P4-19). */
export function stmtUnyankRelease(
  product: string,
  releaseId: string,
): DbStatement {
  return {
    sql: `DELETE FROM release_yanks WHERE product = ? AND release_id = ?
            AND NOT EXISTS (SELECT 1 FROM release_revocations
                             WHERE product = ? AND target_release_id = ?)
            AND NOT EXISTS (SELECT 1 FROM release_records r
                              JOIN release_delegated_records d
                                ON d.product = r.product AND d.record_sha256 = r.record_sha256
                              JOIN release_delegations g
                                ON g.product = d.product AND g.record_sha256 = d.delegation_sha256
                             WHERE r.product = ? AND r.release_id = ?
                               AND g.revocation_sha256 IS NOT NULL)`,
    params: [product, releaseId, product, releaseId, product, releaseId],
  };
}

/** True when a CI-signed revocation names this release (plans/P4-13.md §6.2), or the delegation
 *  it was signed under (P4-19). */
export async function isRevoked(
  db: Db,
  product: string,
  releaseId: string,
): Promise<boolean> {
  return (
    (await db.first<{ one: number }>(
      `SELECT 1 AS one FROM release_revocations WHERE product = ? AND target_release_id = ?
       UNION ALL
       SELECT 1 FROM release_records r
         JOIN release_delegated_records d
           ON d.product = r.product AND d.record_sha256 = r.record_sha256
         JOIN release_delegations g
           ON g.product = d.product AND g.record_sha256 = d.delegation_sha256
        WHERE r.product = ? AND r.release_id = ? AND g.revocation_sha256 IS NOT NULL
       LIMIT 1`,
      product,
      releaseId,
      product,
      releaseId,
    )) !== null
  );
}

/** Lift a yank. True when the release was yanked. */
export async function unyankRelease(
  db: Db,
  product: string,
  releaseId: string,
): Promise<boolean> {
  const s = stmtUnyankRelease(product, releaseId);
  return (await db.runChanges(s.sql, ...s.params)) > 0;
}

export async function isYanked(
  db: Db,
  product: string,
  releaseId: string,
): Promise<boolean> {
  return (
    (await db.first<{ one: number }>(
      "SELECT 1 AS one FROM release_yanks WHERE product = ? AND release_id = ?",
      product,
      releaseId,
    )) !== null
  );
}

export async function listYanks(
  db: Db,
  product: string,
): Promise<ReleaseYankRow[]> {
  return db.all<ReleaseYankRow>(
    "SELECT * FROM release_yanks WHERE product = ? ORDER BY at DESC, release_id ASC",
    product,
  );
}
