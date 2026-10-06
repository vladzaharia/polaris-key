/// <reference types="@cloudflare/workers-types" />

/**
 * Release-file mirroring (HA-08; notes/S-20 §4.3, §6.3 "Mirror a release file", §6.8, owner
 * decision 6).
 *
 * Every file of an APP release whose bytes live only on GitHub (`github`, or a legacy row with no
 * locations: its GitHub asset) or at an `external` URL gets a verified copy in the blob store and
 * an `{provider: "r2", key: "blobs/sha256/<hex>"}` location appended to its `locations_json`.
 * Distribution's `serveArtifact` ranks `r2` first (`LOCATION_RANK`), so every byte route then
 * serves our bytes, and GitHub stays the fallback location. Nothing signed changes: the release
 * record carries hashes, never locations (`shared-protocol/src/release.ts`), and the bytes behind
 * every URL are hash-identical.
 *
 *   1. ENQUEUE (`enqueueReleaseMirrors`): after a truth-store sync (the GitHub `release` webhook
 *      and the release admin surface, `sync.ts`), a manifest resync (`resync.ts`) and a
 *      descriptor ingest (`descriptor.ts`, the CI submit). The owed files are READ from
 *      `release_artifacts` (`owedSql`), so a sync needs to know nothing about what it changed; a
 *      `release_mirrors` row holds each file off for one back-off step while its message is in
 *      flight, and longer after a failure. At most `MIRROR_ENQUEUE_MAX_PER_RUN` per call.
 *   2. MIRROR (`processReleaseMirror`, on the HA-05 queue `pkey-assets-<env>`, `src/assetQueue.ts`):
 *      the message names the file only. Everything is re-read: the artifact row, its locations,
 *      the release configuration and, for a GitHub file, the asset's metadata (`getReleaseAsset`),
 *      whose `digest` must agree with the row's `sha256` when both exist. The bytes then go
 *      through Core's `ingest` (HA-01) into the slot `release-file:<sha256>`: the guarded fetch
 *      (`GET /repos/{o}/{r}/releases/assets/{id}`, `Accept: application/octet-stream`, the
 *      installation token on the first hop only, redirects only to GitHub's storage hosts; an
 *      external URL through the same guard), the 4.995 GiB cap, every byte hashed and R2 handed
 *      the expected SHA-256 so it refuses anything else (`putVerified`), the `hosted_assets` row,
 *      its `hosted-asset` ref and the `assets.ingest` audit row in one batch.
 *   3. APPEND (`appendLocation`): ONE batch, every statement guarded on the artifact row being
 *      what this run read (`locations_json` unchanged, `sha256` NULL or the expected hash) and on
 *      the product holding the key: the `release-artifact` ref (`<release_id>/<artifact_id>`),
 *      the `release.mirror` audit row, the job row, and last the row's new `locations_json` (and
 *      its `sha256`, filled from the verified hash when the sync never recorded one).
 *   4. BACKFILL (`backfillReleaseMirrors`, the nightly sweep; `mirrorNow`, the operator's
 *      `POST /manage/api/products/<slug>/assets/mirror`): the same owed query across products,
 *      bounded per run. Once every file has its copy it finds nothing, so on first deploy it is
 *      the one-shot backfill, and afterwards it is the retry of failed files.
 *
 * ── RULES ───────────────────────────────────────────────────────────────────────────────────
 *
 * - A copy is promoted only when its bytes are the expected hash. A refusal (a digest mismatch,
 *   a size mismatch, corrupted bytes) writes no ref and no location: the job row goes `failed`
 *   with the reason and back-off, and GitHub keeps serving.
 * - Only app releases. A pack's objects are reached through the blob route under the pack's own
 *   gate, and a package release is r2-located already; an app-side copy of either would change
 *   who may fetch it, so neither is ever mirrored.
 * - Possession (THREAT-MODEL §3): the `release-artifact` ref is earned only in the batch that
 *   finds this product holding the key, which `ingest` has just proven by reading and hashing
 *   every byte. Whether another product stored the same bytes is never consulted.
 * - Blob GC: neither ref kind is ever dropped by the collector (`core/blobGc.ts`). The copy is
 *   held for as long as the artifact row's location names it.
 * - Never on an end user's request (owner decision 3), and never failing the sync, resync or
 *   publish that triggered it: enqueueing is best-effort and swallows every failure.
 * - `releaseMirrorEnabled` (`mirrorSwitch.ts`) is asked first everywhere: HA-10's
 *   `assets.releases.mirror`, on by default.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db, DbStatement, Env } from "../../core/platform.js";
import { isAllowedStorageHost, randomId } from "../../core/platform.js";
import { blobKey } from "../../core/blobs.js";
import {
  ingest,
  SLOT_CLASSES,
  type IngestInput,
} from "../../core/hostedAssets.js";
import {
  PULL_BACKOFF_BASE_SECONDS,
  PULL_BACKOFF_CAP_SECONDS,
  pullBackoffSeconds,
} from "../../core/hostedAssetPulls.js";
import { getReleaseConfig, isResolved, type ResolvedConfig } from "./config.js";
import { installationToken } from "./gateway.js";
import {
  assetSha256,
  getReleaseAsset,
  releaseAssetUrl,
  UpstreamRateLimitedError,
} from "./github.js";
import type { FetchImpl } from "../../core/safeFetch.js";
import { githubAssetId } from "./source.js";
import type { ReleaseArtifactRow } from "./store.js";
import { releaseMirrorEnabled } from "./mirrorSwitch.js";

export { releaseMirrorEnabled } from "./mirrorSwitch.js";

/** The `blob_refs.ref_kind` a mirrored file's `r2` location is held by (ref id
 *  `<release_id>/<artifact_id>`). Never dropped by the collector. */
export const RELEASE_ARTIFACT_REF = "release-artifact";

/** How many files one sync, resync or publish queues at most. */
export const MIRROR_ENQUEUE_MAX_PER_RUN = 100;
/** How many files the nightly backfill queues at most, across products. */
export const MIRROR_BACKFILL_MAX_PER_RUN = 100;
/** How many files one operator request queues at most. */
export const MIRROR_OPERATOR_MAX_PER_RUN = 200;
/** Queues' `sendBatch` limit. */
const SEND_BATCH_MAX = 100;

const PRODUCT_RE = /^[a-z0-9-]{1,64}$/;
/** A release id or artifact id as the store keys them (a tag, a GitHub asset id, `file:<name>`). */
const ID_MAX = 512;

// ── Messages ─────────────────────────────────────────────────────────────────────────────────

/** One queued mirror. It names the file only; everything else is re-read on delivery. */
export interface ReleaseMirrorMessage {
  v: 1;
  kind: "release-mirror";
  product: string;
  releaseId: string;
  artifactId: string;
  reason: "sync" | "backfill" | "operator";
}

/** A message read off the asset queue, validated; `null` when it is not a mirror. */
export function readReleaseMirrorMessage(
  body: unknown,
): ReleaseMirrorMessage | null {
  if (!body || typeof body !== "object") return null;
  const m = body as Record<string, unknown>;
  if (m.v !== 1 || m.kind !== "release-mirror") return null;
  if (typeof m.product !== "string" || !PRODUCT_RE.test(m.product)) return null;
  const id = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
  if (!id(m.releaseId) || !id(m.artifactId)) return null;
  if (m.reason !== "sync" && m.reason !== "backfill" && m.reason !== "operator")
    return null;
  return {
    v: 1,
    kind: "release-mirror",
    product: m.product,
    releaseId: m.releaseId,
    artifactId: m.artifactId,
    reason: m.reason,
  };
}

// ── What is owed ─────────────────────────────────────────────────────────────────────────────

/** `locations_json` of the row aliased `a`, when it is a JSON array; NULL otherwise. */
function locsSql(a: string): string {
  return `(CASE WHEN json_valid(${a}.locations_json)
                 AND json_type(${a}.locations_json) = 'array'
            THEN ${a}.locations_json END)`;
}

/**
 * SQL over a `release_artifacts` row aliased `a`: does it owe a copy? Its bytes are somewhere we
 * can pull from (a `github` or `external` location, or, with no readable locations, the GitHub
 * asset its numeric id names: `parseLocations`'s legacy reading) and no `r2` location names a
 * copy yet.
 */
export function owedSql(a = "a"): string {
  const locs = locsSql(a);
  return `((${locs} IS NULL AND ${a}.artifact_id <> '' AND ${a}.artifact_id NOT GLOB '*[^0-9]*')
      OR EXISTS (SELECT 1 FROM json_each(${locs}) e
                  WHERE json_extract(e.value, '$.provider') IN ('github', 'external')))
    AND NOT EXISTS (SELECT 1 FROM json_each(${locs}) e
                     WHERE json_extract(e.value, '$.provider') = 'r2')`;
}

interface OwedRow {
  product: string;
  release_id: string;
  artifact_id: string;
}

/** The owed files, oldest-due first, then the newest releases first. */
async function owedFiles(
  db: Db,
  now: number,
  opts: { product?: string; limit: number; force?: boolean },
): Promise<OwedRow[]> {
  const params: (string | number)[] = [];
  let where = "";
  if (opts.product !== undefined) {
    where += " AND a.product = ?";
    params.push(opts.product);
  }
  if (!opts.force) {
    where += " AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)";
    params.push(now);
  }
  return db.all<OwedRow>(
    `SELECT a.product, a.release_id, a.artifact_id
       FROM release_artifacts a
       JOIN release_metadata m ON m.product = a.product AND m.release_id = a.release_id
       JOIN products p ON p.slug = a.product
       LEFT JOIN release_mirrors j
         ON j.product = a.product AND j.release_id = a.release_id
        AND j.artifact_id = a.artifact_id
      WHERE p.deleted_at IS NULL AND m.deliverable_id = ? AND ${owedSql("a")}${where}
      ORDER BY COALESCE(j.next_attempt_at, 0), COALESCE(m.published_at, 0) DESC,
               a.product, a.release_id, a.artifact_id
      LIMIT ?`,
    APP_DELIVERABLE_ID,
    ...params,
    opts.limit,
  );
}

/** How many files of `product` owe a copy (whatever their back-off). */
export async function owedCount(db: Db, product: string): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM release_artifacts a
       JOIN release_metadata m ON m.product = a.product AND m.release_id = a.release_id
      WHERE a.product = ? AND m.deliverable_id = ? AND ${owedSql("a")}`,
    product,
    APP_DELIVERABLE_ID,
  );
  return row?.n ?? 0;
}

// ── The job row ──────────────────────────────────────────────────────────────────────────────

const ARTIFACT_EXISTS = `EXISTS (SELECT 1 FROM release_artifacts
   WHERE product = ? AND release_id = ? AND artifact_id = ?)`;

/** The statement that holds a file off for one back-off step while its message is in flight. */
function stmtQueued(f: OwedRow, now: number): DbStatement {
  return {
    sql: `INSERT INTO release_mirrors (product, release_id, artifact_id, status, attempts,
            next_attempt_at, modified_at)
          SELECT ?, ?, ?, 'queued', 0, ?, ? WHERE ${ARTIFACT_EXISTS}
          ON CONFLICT(product, release_id, artifact_id) DO UPDATE SET
            status = 'queued', next_attempt_at = excluded.next_attempt_at,
            modified_at = excluded.modified_at`,
    params: [
      f.product,
      f.release_id,
      f.artifact_id,
      now + PULL_BACKOFF_BASE_SECONDS,
      now,
      f.product,
      f.release_id,
      f.artifact_id,
    ],
  };
}

/** SQL: the back-off after one more failure, from the stored `attempts` (before the increment). */
function backoffAfterFailureSql(column: string): string {
  const steps = Array.from(
    { length: 8 },
    (_, i) => `WHEN ${i} THEN ${pullBackoffSeconds(i + 1)}`,
  ).join(" ");
  return `CASE ${column} ${steps} ELSE ${PULL_BACKOFF_CAP_SECONDS} END`;
}

/** Record a refused mirror on the job row: `failed`, the reason, one more back-off step. */
async function recordFailure(
  db: Db,
  msg: ReleaseMirrorMessage,
  now: number,
  error: string,
  source: string | null,
): Promise<void> {
  await db.run(
    `INSERT INTO release_mirrors (product, release_id, artifact_id, status, source, error,
       attempts, next_attempt_at, tried_at, modified_at)
     SELECT ?, ?, ?, 'failed', ?, ?, 1, ? + ${pullBackoffSeconds(1)}, ?, ? WHERE ${ARTIFACT_EXISTS}
     ON CONFLICT(product, release_id, artifact_id) DO UPDATE SET
       status = 'failed', source = COALESCE(excluded.source, release_mirrors.source),
       error = excluded.error, attempts = release_mirrors.attempts + 1,
       next_attempt_at = ? + ${backoffAfterFailureSql("release_mirrors.attempts")},
       tried_at = excluded.tried_at, modified_at = excluded.modified_at`,
    msg.product,
    msg.releaseId,
    msg.artifactId,
    source,
    error,
    now,
    now,
    now,
    msg.product,
    msg.releaseId,
    msg.artifactId,
    now,
  );
}

/** Settle the job row of a file that already has an `r2` location. */
async function recordAlready(
  db: Db,
  msg: ReleaseMirrorMessage,
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE release_mirrors SET status = 'ready', error = NULL, attempts = 0,
            next_attempt_at = NULL, tried_at = ?, modified_at = ?
      WHERE product = ? AND release_id = ? AND artifact_id = ?`,
    now,
    now,
    msg.product,
    msg.releaseId,
    msg.artifactId,
  );
}

// ── Enqueue ──────────────────────────────────────────────────────────────────────────────────

type QueueEnv = Pick<Env, "HOSTED_ASSET_QUEUE" | "BLOBS">;

async function send(
  queue: Queue<unknown>,
  messages: readonly ReleaseMirrorMessage[],
): Promise<void> {
  for (let i = 0; i < messages.length; i += SEND_BATCH_MAX)
    await queue.sendBatch(
      messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })),
    );
}

/** Hold each file off for one back-off step, then send its message. Returns how many were sent. */
async function queueFiles(
  queue: Queue<unknown>,
  db: Db,
  files: readonly OwedRow[],
  now: number,
  reason: ReleaseMirrorMessage["reason"],
): Promise<number> {
  if (files.length === 0) return 0;
  // The holds first: a send that fails leaves the files held for one step, and the next sync or
  // the nightly backfill queues them again.
  await db.batch(files.map((f) => stmtQueued(f, now)));
  await send(
    queue,
    files.map((f) => ({
      v: 1,
      kind: "release-mirror",
      product: f.product,
      releaseId: f.release_id,
      artifactId: f.artifact_id,
      reason,
    })),
  );
  return files.length;
}

/**
 * Queue the copies `product` owes (S-20 §6.3 "Mirror a release file"), after a sync, a resync or a
 * descriptor ingest. Best-effort by construction: it never throws, so the caller's write never
 * fails because of a mirror. Nothing is planned without a queue or a blob store, or while
 * mirroring is off for the product.
 */
export async function enqueueReleaseMirrors(
  env: QueueEnv,
  db: Db,
  product: string,
  now: number,
  limit = MIRROR_ENQUEUE_MAX_PER_RUN,
): Promise<number> {
  const queue = env.HOSTED_ASSET_QUEUE;
  if (!queue || !env.BLOBS) return 0;
  try {
    if (!(await releaseMirrorEnabled(env, db, product))) return 0;
    const files = await owedFiles(db, now, { product, limit });
    return await queueFiles(queue, db, files, now, "sync");
  } catch {
    return 0;
  }
}

/**
 * The nightly backfill (S-20 §6.8): owed copies of every product whose back-off has elapsed,
 * oldest-due first, at most `limit` per run. On first deploy this is the backfill of every
 * existing release; once every file has its copy it finds nothing but the failed ones. Returns
 * how many were queued; nothing without a queue or a blob store.
 */
export async function backfillReleaseMirrors(
  env: QueueEnv,
  db: Db,
  now: number,
  limit = MIRROR_BACKFILL_MAX_PER_RUN,
): Promise<number> {
  const queue = env.HOSTED_ASSET_QUEUE;
  if (!queue || !env.BLOBS) return 0;
  // Read a little past the budget so a product with mirroring off cannot starve the others.
  const candidates = await owedFiles(db, now, { limit: limit * 2 });
  const enabled = new Map<string, boolean>();
  const files: OwedRow[] = [];
  for (const f of candidates) {
    if (files.length >= limit) break;
    let on = enabled.get(f.product);
    if (on === undefined) {
      on = await releaseMirrorEnabled(env, db, f.product);
      enabled.set(f.product, on);
    }
    if (on) files.push(f);
  }
  return queueFiles(queue, db, files, now, "backfill");
}

export type MirrorNowResult =
  | { ok: true; queued: number; owed: number }
  | { ok: false; reason: "unavailable" | "disabled" };

/**
 * The operator's "mirror now" (`POST /manage/api/products/<slug>/assets/mirror`): every owed copy
 * of `product`, back-off or not, at most `MIRROR_OPERATOR_MAX_PER_RUN`. `owed` is how many files
 * still owe a copy before this run's messages are delivered, so a caller can show progress.
 */
export async function mirrorNow(
  env: QueueEnv,
  db: Db,
  product: string,
  now: number,
): Promise<MirrorNowResult> {
  const queue = env.HOSTED_ASSET_QUEUE;
  if (!queue || !env.BLOBS) return { ok: false, reason: "unavailable" };
  if (!(await releaseMirrorEnabled(env, db, product)))
    return { ok: false, reason: "disabled" };
  const files = await owedFiles(db, now, {
    product,
    limit: MIRROR_OPERATOR_MAX_PER_RUN,
    force: true,
  });
  const queued = await queueFiles(queue, db, files, now, "operator");
  return { ok: true, queued, owed: await owedCount(db, product) };
}

// ── Mirror one file ──────────────────────────────────────────────────────────────────────────

export type MirrorOutcome =
  /** The copy is stored and the `r2` location appended. */
  | "mirrored"
  /** The file already had an `r2` location. */
  | "already"
  /** Nothing to do: the file is gone, not an app release's, mirroring is off, or its row changed
   *  between this run's read and its write (the next sync queues it again). */
  | "superseded"
  /** Refused and recorded on the job row, with back-off; GitHub keeps serving. */
  | "failed"
  /** A transient store race: the consumer retries the message. */
  | "retry"
  /** No blob store bound: nothing attempted. */
  | "unavailable";

export interface MirrorContext {
  env: Env;
  db: Db;
  now: number;
  /** A test seam: the fetch every GitHub call and pull goes through. */
  fetchImpl?: FetchImpl;
}

export interface MirrorDeps {
  /** The installation token for a product's repository (a test seam; Release's own otherwise). */
  token?: (cfg: ResolvedConfig) => Promise<string>;
}

type ArtifactRow = ReleaseArtifactRow & { deliverable_id: string };

/** One stored location, as stored (unknown fields kept), or the legacy implied GitHub asset. */
type RawLocation = Record<string, unknown>;

/** The row's locations as stored, or `parseLocations`'s legacy reading. */
function rawLocations(a: ArtifactRow): RawLocation[] {
  if (a.locations_json) {
    try {
      const parsed: unknown = JSON.parse(a.locations_json);
      if (Array.isArray(parsed))
        return parsed.filter(
          (l): l is RawLocation =>
            !!l && typeof l === "object" && !Array.isArray(l),
        );
    } catch {
      /* the legacy reading below */
    }
  }
  return /^\d+$/.test(a.artifact_id) ? [{ provider: "github" }] : [];
}

/** Where to pull from: the GitHub asset first (authenticated, digest-checked), else an URL. */
type Source =
  | { kind: "github"; asset: number | string | undefined }
  | { kind: "external"; url: string };

function pickSource(locations: readonly RawLocation[]): Source | null {
  const gh = locations.find((l) => l.provider === "github");
  if (gh)
    return {
      kind: "github",
      asset:
        typeof gh.asset === "number" || typeof gh.asset === "string"
          ? gh.asset
          : undefined,
    };
  for (const l of locations) {
    if (l.provider !== "external" || typeof l.url !== "string") continue;
    try {
      if (new URL(l.url).protocol === "https:")
        return { kind: "external", url: l.url };
    } catch {
      /* not a URL: not a source */
    }
  }
  return null;
}

/** A GitHub asset's redirects may reach the API and GitHub's storage hosts only. */
function githubHost(host: string): boolean {
  return host === "api.github.com" || isAllowedStorageHost(host);
}

const RELEASE_FILE_CAP = SLOT_CLASSES["release-file"].maxBytes;

/**
 * Mirror one file (the consumer, `src/assetQueue.ts`). Never throws for a refusal: the outcome is
 * recorded on the job row. Throws only for an unexpected failure (D1 down), which the consumer
 * turns into a queue retry and, past the retries, the dead-letter queue.
 */
export async function processReleaseMirror(
  ctx: MirrorContext,
  msg: ReleaseMirrorMessage,
  deps: MirrorDeps = {},
): Promise<MirrorOutcome> {
  const { env, db, now } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  if (!env.BLOBS) return "unavailable";
  const row = await db.first<ArtifactRow>(
    `SELECT a.*, m.deliverable_id
       FROM release_artifacts a
       JOIN release_metadata m ON m.product = a.product AND m.release_id = a.release_id
      WHERE a.product = ? AND a.release_id = ? AND a.artifact_id = ?`,
    msg.product,
    msg.releaseId,
    msg.artifactId,
  );
  if (!row || row.deliverable_id !== APP_DELIVERABLE_ID) return "superseded";
  if (!(await releaseMirrorEnabled(env, db, msg.product))) return "superseded";

  const locations = rawLocations(row);
  if (locations.some((l) => l.provider === "r2")) {
    await recordAlready(db, msg, now);
    return "already";
  }
  const source = pickSource(locations);
  const fail = async (
    error: string,
    label: string | null,
  ): Promise<MirrorOutcome> => {
    await recordFailure(db, msg, now, error, label);
    return "failed";
  };
  if (!source) return fail("no-source", null);

  let input: IngestInput;
  let expected: string;
  let label: string;
  if (source.kind === "github") {
    const cfg = await getReleaseConfig(db, msg.product);
    if (!cfg || !isResolved(cfg)) return fail("no-access", null);
    const assetId = await githubAssetId(db, row, source.asset);
    if (assetId === null) return fail("no-source", null);
    label = `github:${assetId}`;
    let token: string;
    try {
      token = await (deps.token
        ? deps.token(cfg)
        : installationToken(env, cfg, now, fetchImpl));
    } catch {
      return fail("no-access", label);
    }
    let meta: Awaited<ReturnType<typeof getReleaseAsset>>;
    try {
      meta = await getReleaseAsset(
        token,
        cfg.gh_owner,
        cfg.gh_repo,
        assetId,
        fetchImpl,
      );
    } catch (err) {
      return fail(
        err instanceof UpstreamRateLimitedError
          ? "github:rate-limited"
          : "github:lookup",
        label,
      );
    }
    if (!meta) return fail("github:404", label);
    const digest = assetSha256(meta);
    // Both hashes, when both exist, must name the same bytes: the descriptor's (or the map's)
    // `sha256` and GitHub's own `digest`. Neither alone is trusted over the other.
    if (row.sha256 && digest && row.sha256 !== digest)
      return fail("digest-mismatch", label);
    const want = row.sha256 ?? digest;
    if (!want) return fail("no-digest", label);
    if (row.size_bytes !== null && row.size_bytes !== meta.size)
      return fail("size-mismatch", label);
    if (meta.size > RELEASE_FILE_CAP) return fail("too-large", label);
    expected = want;
    input = {
      kind: "pull",
      url: releaseAssetUrl(cfg.gh_owner, cfg.gh_repo, assetId),
      headers: {
        accept: "application/octet-stream",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      allowHost: githubHost,
      origin: "release-mirror",
      sourceKind: "github-asset",
      sourceRef: String(assetId),
      expectedSha256: want,
      expectedSize: meta.size,
    };
  } else {
    label = source.url;
    if (!row.sha256) return fail("no-digest", label);
    if (row.size_bytes !== null && row.size_bytes > RELEASE_FILE_CAP)
      return fail("too-large", label);
    expected = row.sha256;
    input = {
      kind: "pull",
      url: source.url,
      origin: "release-mirror",
      sourceKind: "url",
      sourceRef: source.url,
      expectedSha256: row.sha256,
      expectedSize: row.size_bytes,
    };
  }

  const result = await ingest(
    { env, db, now, fetchImpl },
    msg.product,
    `release-file:${expected}`,
    input,
  );
  if (!result.ok) {
    if (result.reason === "retry") return "retry";
    if (result.reason === "unavailable") return "unavailable";
    return fail(result.reason, label);
  }
  // `ingest` stored exactly the expected bytes, or answered that its last copy from this source
  // is still current (a 304): the slot is named by the hash, so that copy is these bytes too.
  if (result.sha256 !== expected) return fail("sha256-mismatch", label);
  const appended = await appendLocation(db, row, locations, expected, now, {
    label,
    name: row.name,
  });
  return appended ? "mirrored" : "superseded";
}

/**
 * The append (step 3): the `release-artifact` ref, the audit row, the job row and the new
 * `locations_json`, in ONE batch, each guarded on the row being what this run read and on the
 * product holding the key. The row's update comes last, since it changes what the guard reads.
 * Returns whether it applied.
 */
async function appendLocation(
  db: Db,
  row: ArtifactRow,
  locations: readonly RawLocation[],
  sha256: string,
  now: number,
  info: { label: string; name: string },
): Promise<boolean> {
  const key = blobKey(sha256);
  const next = JSON.stringify([...locations, { provider: "r2", key }]);
  const ids = [row.product, row.release_id, row.artifact_id];
  const guard = `EXISTS (SELECT 1 FROM release_artifacts
      WHERE product = ? AND release_id = ? AND artifact_id = ?
        AND locations_json IS ? AND (sha256 IS NULL OR sha256 = ?))
    AND EXISTS (SELECT 1 FROM blob_refs WHERE product = ? AND storage_key = ?)`;
  const guardParams = [...ids, row.locations_json, sha256, row.product, key];
  const refId = `${row.release_id}/${row.artifact_id}`;
  const statements: DbStatement[] = [
    {
      sql: `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
            SELECT ?, ?, ?, ?, ? WHERE ${guard}
            ON CONFLICT(product, storage_key, ref_kind, ref_id) DO UPDATE SET
              created_at = MAX(blob_refs.created_at, excluded.created_at)`,
      params: [
        row.product,
        key,
        RELEASE_ARTIFACT_REF,
        refId,
        now,
        ...guardParams,
      ],
    },
    {
      sql: `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
              target_kind, target_id, parent_id, summary)
            SELECT ?, ?, ?, NULL, 'Polaris Key', NULL, 'release.mirror', 'release-artifact', ?,
                   ?, ? WHERE ${guard}`,
      params: [
        row.product,
        randomId("aud"),
        now,
        refId,
        row.release_id,
        `${info.name} of ${row.release_id} is now served from Polaris Key's own copy (sha256 ${sha256.slice(0, 12)}, from ${info.label.startsWith("github:") ? "GitHub" : "its external URL"}); the original location stays as the fallback`,
        ...guardParams,
      ],
    },
    {
      sql: `INSERT INTO release_mirrors (product, release_id, artifact_id, status, source, sha256,
              error, attempts, next_attempt_at, tried_at, modified_at)
            SELECT ?, ?, ?, 'ready', ?, ?, NULL, 0, NULL, ?, ? WHERE ${guard}
            ON CONFLICT(product, release_id, artifact_id) DO UPDATE SET
              status = 'ready', source = excluded.source, sha256 = excluded.sha256,
              error = NULL, attempts = 0, next_attempt_at = NULL,
              tried_at = excluded.tried_at, modified_at = excluded.modified_at`,
      params: [...ids, info.label, sha256, now, now, ...guardParams],
    },
    {
      sql: `UPDATE release_artifacts SET locations_json = ?, sha256 = COALESCE(sha256, ?)
             WHERE product = ? AND release_id = ? AND artifact_id = ?
               AND locations_json IS ? AND (sha256 IS NULL OR sha256 = ?)
               AND EXISTS (SELECT 1 FROM blob_refs WHERE product = ? AND storage_key = ?)`,
      params: [next, sha256, ...guardParams],
    },
  ];
  if (db.batchChanges) {
    const changes = await db.batchChanges(statements);
    return changes.at(-1) === 1;
  }
  await db.batch(statements);
  const after = await db.first<{ locations_json: string | null }>(
    "SELECT locations_json FROM release_artifacts WHERE product = ? AND release_id = ? AND artifact_id = ?",
    ...ids,
  );
  return after?.locations_json === next;
}
