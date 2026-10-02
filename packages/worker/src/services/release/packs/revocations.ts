/// <reference types="@cloudflare/workers-types" />

/**
 * Revocation records (P4-13, plans/P4-13.md §2.3, §6.2; decisions 3, 5 and 18).
 *
 * A revocation is a CI-signed `pkey-release+jws` with `kind: "revocation"`, submitted alone on the
 * CI submit route (`{record, dryRun?}`, no descriptor, no ticket). It names a stored pack record by
 * hash (`revokes`) and, optionally, a replacement of the same pack. Only a declared RELEASE key
 * verifies it (`verifyRecordJws`: a key that is a product key is refused at `product-key`), so the
 * Worker can withhold content but never condemn or substitute it: it holds no key that signs one.
 *
 * ── THE CHECKS, IN ORDER (each refusal is `release_record_rejected` with its reason) ─────────
 *
 *   1. the shared record checks against the product's release keys (`verifyRecordJws`);
 *   2. `revocation-body`         client-core's `revocationOf` finds the body unusable;
 *   3. `revocation-target`       the target is not a stored `kind: pack` record of `deliverable`
 *                                whose version and `seq` are the record's;
 *   4. superseding               a byte-identical resubmit succeeds and changes nothing; a
 *                                revocation that `newerRevocation` ranks above the stored one
 *                                UPDATES the row; an older one is refused (`revocation-stale`).
 *                                No submit ever deletes the row: there is no un-revoke;
 *   5. `revocation-replacement`  a replacement is not a stored, non-yanked, non-revoked record of
 *                                the same pack with the pin's version and `seq`;
 *   6. `revocation-replacement-incompatible`  the replacement does not cover the target: every
 *                                variant key of the target must exist in the replacement with an
 *                                equal `requires.engine`, and for a `compatible` pack every level
 *                                the target's `requires.contentApi.app` admits that is live, or
 *                                that an app release pinning or holding the target has, must be
 *                                admitted by the replacement's range too.
 *
 * Then ONE batch: the revocation row (insert, or the superseding update), a `release_yanks` row
 * for the target (reason `revoked`, by `ci:<kid>`, never over an existing yank), and the clear of
 * the product's sets; then the re-resolution (P4-12's trigger pattern), which skips revoked
 * releases (`revokedReleaseIds`).
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { newerRevocation, revocationOf } from "@polaris-key/client-core/record";
import { variantKey } from "@polaris-key/client-core/packs";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import type { ServiceContext } from "../../../core/registry.js";
import type { CatalogRevocation } from "../../../core/hooks.js";
import { errorResponse, json } from "../../../core/errors.js";
import { ciActor } from "../../../core/ciScope.js";
import type { CiTokenRecord } from "../../../core/publisher.js";
import { appendAudit } from "../../../core/data.js";
import type { Db, DbStatement } from "../../../core/platform.js";
import { randomId } from "../../../core/platform.js";
import { bumpReleaseGeneration } from "../ghCache.js";
import {
  sha256HexOfAscii,
  type RecordRefusalReason,
  type VerifiedRecordJws,
} from "../records.js";
import { readPackDeliverable } from "./deliverables.js";
import {
  handleDelegationRevocation,
  readDelegationRevocations,
} from "./delegations.js";
import { storedRecordPayload } from "./ingest.js";
import { levelInRange, PackResolver } from "./resolve.js";
import {
  invalidateSetsStatements,
  loadResolutionState,
  resolveAndStore,
} from "./sets.js";

/** One stored row of `release_revocations`. */
interface RevocationRow {
  deliverable_id: string;
  target_release_id: string;
  target_sha256: string;
  record_sha256: string;
  kid: string;
  jws: string;
  replacement_release_id: string | null;
  replacement_sha256: string | null;
  reason: string;
  issued_at: number;
  ingested_at: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every revocation in force, with its target's version and `seq` (the hook's `revocations`). */
export async function readRevocations(
  db: Db,
  product: string,
): Promise<CatalogRevocation[]> {
  const rows = await db.all<
    RevocationRow & { version: string | null; seq: number | null }
  >(
    `SELECT v.*, m.version AS version, m.seq AS seq
       FROM release_revocations v
       LEFT JOIN release_metadata m
         ON m.product = v.product AND m.release_id = v.target_release_id
      WHERE v.product = ?`,
    product,
  );
  return rows
    .filter((r) => r.version !== null && r.seq !== null)
    .map((r) => ({
      deliverableId: r.deliverable_id,
      targetReleaseId: r.target_release_id,
      targetSha256: r.target_sha256,
      recordSha256: r.record_sha256,
      version: r.version as string,
      seq: r.seq as number,
      kid: r.kid,
      replacement:
        r.replacement_release_id !== null && r.replacement_sha256 !== null
          ? {
              releaseId: r.replacement_release_id,
              sha256: r.replacement_sha256,
            }
          : null,
      reason: r.reason,
      issuedAt: r.issued_at,
      ingestedAt: r.ingested_at,
    }))
    .sort(
      (a, b) =>
        cmp(a.deliverableId, b.deliverableId) ||
        a.seq - b.seq ||
        cmp(a.targetSha256, b.targetSha256),
    );
}

/** Every revocation in force: P4-13's of pack records, then (P4-19) those of delegations
 *  (`kind: "delegation"`, no target release), in the same order. */
export async function readAllRevocations(
  db: Db,
  product: string,
): Promise<CatalogRevocation[]> {
  return [
    ...(await readRevocations(db, product)),
    ...(await readDelegationRevocations(db, product)),
  ].sort(
    (a, b) =>
      cmp(a.deliverableId, b.deliverableId) ||
      a.seq - b.seq ||
      cmp(a.targetSha256, b.targetSha256),
  );
}

function recordRefusal(
  reason: RecordRefusalReason,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return errorResponse(
    reason === "revocation-stale" ? 409 : 400,
    "release_record_rejected",
    message,
    { reason, ...extra },
  );
}

interface StoredPackRecord {
  release_id: string;
  record_sha256: string;
  deliverable_id: string;
  seq: number;
  kind: string;
  jws: string;
  kid: string;
  version: string | null;
  yanked: number;
  revoked: number;
}

async function storedRecord(
  db: Db,
  product: string,
  sha256: string,
): Promise<StoredPackRecord | null> {
  return db.first<StoredPackRecord>(
    `SELECT r.release_id, r.record_sha256, r.deliverable_id, r.seq, r.kind, r.jws, r.kid,
            m.version AS version,
            EXISTS (SELECT 1 FROM release_yanks y
                     WHERE y.product = r.product AND y.release_id = r.release_id) AS yanked,
            EXISTS (SELECT 1 FROM release_revocations v
                     WHERE v.product = r.product AND v.target_sha256 = r.record_sha256) AS revoked
       FROM release_records r
       LEFT JOIN release_metadata m ON m.product = r.product AND m.release_id = r.release_id
      WHERE r.product = ? AND r.record_sha256 = ?`,
    product,
    sha256,
  );
}

/** `requires.contentApi.app` of a pack variant, or undefined. */
function contentApiRange(
  v: PackRecordDoc["variants"][number],
): string | undefined {
  const req = v.requires as Record<string, unknown> | undefined;
  const ca = req?.contentApi;
  if (!ca || typeof ca !== "object" || Array.isArray(ca)) return undefined;
  const r = (ca as Record<string, unknown>)[APP_DELIVERABLE_ID];
  return typeof r === "string" ? r : undefined;
}

function engineOf(v: PackRecordDoc["variants"][number]): string | null {
  return typeof v.requires?.engine === "string" ? v.requires.engine : null;
}

/** The levels a replacement must cover: every live level, and every level of an app release
 *  that pins or holds the target. */
async function coveredLevels(
  db: Db,
  product: string,
  targetReleaseId: string,
): Promise<Set<number>> {
  const levels = new Set<number>();
  const state = await loadResolutionState(db, product);
  if (state) {
    const resolver = new PackResolver(state.input);
    for (const channel of state.input.channels)
      for (const r of resolver.live(channel)) levels.add(r.contentApi);
  }
  const rows = await db.all<{ content_api: number | null }>(
    `SELECT m.content_api FROM release_metadata m
      WHERE m.product = ? AND m.release_id IN (
        SELECT app_release_id FROM release_pins WHERE product = ? AND pack_release_id = ?
        UNION
        SELECT app_release_id FROM release_holds WHERE product = ? AND pack_release_id = ?)`,
    product,
    product,
    targetReleaseId,
    product,
    targetReleaseId,
  );
  for (const r of rows)
    if (typeof r.content_api === "number") levels.add(r.content_api);
  return levels;
}

/** Check 6: why the replacement does not cover the target, or null when it does. */
function replacementGap(
  target: PackRecordDoc,
  replacement: PackRecordDoc,
  compatible: boolean,
  levels: ReadonlySet<number>,
): string | null {
  const byKey = new Map(
    replacement.variants.map((v) => [variantKey(v.variant), v]),
  );
  for (const tv of target.variants) {
    const key = variantKey(tv.variant);
    const rv = byKey.get(key);
    if (!rv) return `the replacement has no variant ${key === "" ? "{}" : key}`;
    if (engineOf(tv) !== engineOf(rv))
      return `the replacement's variant ${key === "" ? "{}" : key} runs on ${engineOf(rv) ?? "any engine"}, not ${engineOf(tv) ?? "any engine"}`;
    if (!compatible) continue;
    const tRange = contentApiRange(tv);
    const rRange = contentApiRange(rv);
    for (const level of [...levels].sort((a, b) => a - b))
      if (levelInRange(tRange, level) && !levelInRange(rRange, level))
        return `the target admits contentApi ${level}, which the replacement's range ${rRange ?? "(none)"} does not`;
  }
  return null;
}

/**
 * A `kind: revocation` record submitted alone (the CI submit route, after the shared checks).
 * `{record, dryRun?}`: no ticket and no descriptor.
 */
export async function handleRevocationSubmit(
  ctx: ServiceContext,
  holder: CiTokenRecord,
  shared: Extract<VerifiedRecordJws, { ok: true }>,
  dryRun: boolean,
  /** P4-19: the delegation this revocation revokes, supplied when the Worker never stored it. */
  suppliedDelegation?: unknown,
): Promise<Response> {
  const { db, env, product, now } = ctx;
  const slug = product.slug;

  // 2. The body.
  const body = revocationOf(shared.payload, shared.nonWireIntegers);
  if (body === null)
    return recordRefusal(
      "revocation-body",
      "the revocation's body is unusable: deliverable must be a pack id, revokes a record hash, replacement absent or {sha256 ≠ revokes, seq, version}, and reason 1–512 bytes (plans/P4-13.md §2.3).",
    );
  const recordSha256 = await sha256HexOfAscii(shared.jws);
  const version = shared.payload.version as string;
  const seq = shared.payload.seq as number;

  // 3. The target: a stored pack record, else (P4-19) a delegation, stored or supplied.
  const target = await storedRecord(db, slug, body.target);
  if (!target) {
    const delegated = await handleDelegationRevocation(
      ctx,
      holder,
      shared,
      body,
      dryRun,
      suppliedDelegation,
    );
    if (delegated) return delegated;
  }
  if (
    !target ||
    target.kind !== "pack" ||
    target.deliverable_id !== body.pack ||
    target.seq !== seq ||
    target.version !== version
  )
    return recordRefusal(
      "revocation-target",
      `the revocation names ${body.pack} ${version} (seq ${seq}) by record ${body.target}, which is not a stored pack record of that release.`,
    );

  // 4. Superseding.
  const existing = await db.first<RevocationRow>(
    "SELECT * FROM release_revocations WHERE product = ? AND target_sha256 = ?",
    slug,
    body.target,
  );
  if (existing && existing.jws === shared.jws)
    return json({
      ok: true,
      dryRun,
      outcome: "unchanged",
      revocation: {
        sha256: recordSha256,
        target: body.target,
        stored: false,
      },
    });
  if (existing) {
    const mine = { issuedAt: body.issuedAt, record: recordSha256 };
    const theirs = {
      issuedAt: existing.issued_at,
      record: existing.record_sha256,
    };
    if (newerRevocation(mine, theirs) !== mine)
      return recordRefusal(
        "revocation-stale",
        `${body.pack} ${version} already has a newer revocation (record ${existing.record_sha256}, issued ${existing.issued_at}); a revocation supersedes another only with a newer issuedAt.`,
        { current: existing.record_sha256 },
      );
  }

  // 5. The replacement.
  let replacementReleaseId: string | null = null;
  if (body.replacement) {
    const r = await storedRecord(db, slug, body.replacement.sha256);
    if (
      !r ||
      r.kind !== "pack" ||
      r.deliverable_id !== body.pack ||
      r.seq !== body.replacement.seq ||
      r.version !== body.replacement.version ||
      r.yanked ||
      r.revoked ||
      // P4-19: a replacement is the release key vouching for exact bytes, never a delegated one.
      r.kid.startsWith("pkd1-")
    )
      return recordRefusal(
        "revocation-replacement",
        `the replacement ${body.replacement.version} (seq ${body.replacement.seq}, record ${body.replacement.sha256}) is not a stored, non-yanked, non-revoked release of ${body.pack}.`,
      );
    // 6. It covers the target.
    const targetDoc = storedRecordPayload(
      target.jws,
    ) as unknown as PackRecordDoc | null;
    const replDoc = storedRecordPayload(
      r.jws,
    ) as unknown as PackRecordDoc | null;
    const pack = await readPackDeliverable(db, slug, body.pack);
    const compatible = pack?.binding === "compatible";
    const gap =
      targetDoc && replDoc
        ? replacementGap(
            targetDoc,
            replDoc,
            compatible,
            compatible
              ? await coveredLevels(db, slug, target.release_id)
              : new Set(),
          )
        : "a stored record does not read back";
    if (gap !== null)
      return recordRefusal(
        "revocation-replacement-incompatible",
        `the replacement does not cover ${body.pack} ${version}: ${gap}.`,
      );
    replacementReleaseId = r.release_id;
  }

  if (dryRun)
    return json({
      ok: true,
      dryRun: true,
      outcome: existing ? "superseded" : "created",
      revocation: {
        sha256: recordSha256,
        kid: shared.kid,
        target: body.target,
        replacement: body.replacement?.sha256 ?? null,
      },
    });

  // One batch: the row, the yank, the clear of the sets.
  const write: DbStatement = existing
    ? {
        sql: `UPDATE release_revocations
                 SET record_sha256 = ?, kid = ?, jws = ?, replacement_release_id = ?,
                     replacement_sha256 = ?, reason = ?, issued_at = ?, ingested_at = ?
               WHERE product = ? AND target_sha256 = ? AND record_sha256 = ?`,
        params: [
          recordSha256,
          shared.kid,
          shared.jws,
          replacementReleaseId,
          body.replacement?.sha256 ?? null,
          body.reason,
          body.issuedAt,
          now,
          slug,
          body.target,
          existing.record_sha256,
        ],
      }
    : {
        sql: `INSERT INTO release_revocations
                (product, deliverable_id, target_release_id, target_sha256, record_sha256, kid,
                 jws, replacement_release_id, replacement_sha256, reason, issued_at, ingested_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT DO NOTHING`,
        params: [
          slug,
          body.pack,
          target.release_id,
          body.target,
          recordSha256,
          shared.kid,
          shared.jws,
          replacementReleaseId,
          body.replacement?.sha256 ?? null,
          body.reason,
          body.issuedAt,
          now,
        ],
      };
  await db.batch([
    write,
    {
      sql: `INSERT INTO release_yanks (product, release_id, reason, at, by)
            VALUES (?, ?, 'revoked', ?, ?)
            ON CONFLICT(product, release_id) DO NOTHING`,
      params: [slug, target.release_id, now, `ci:${shared.kid}`],
    },
    ...invalidateSetsStatements(slug, now),
  ]);
  const stored = await db.first<{ record_sha256: string }>(
    "SELECT record_sha256 FROM release_revocations WHERE product = ? AND target_sha256 = ?",
    slug,
    body.target,
  );
  if (stored?.record_sha256 !== recordSha256) {
    await resolveAndStore(db, slug, now);
    return errorResponse(
      409,
      "release_record_rejected",
      `${body.pack} ${version}'s revocation changed while this one was being checked; submit it again.`,
      { reason: "revocation-stale", retryable: true },
    );
  }
  await appendAudit(db, {
    product: slug,
    id: randomId("aud"),
    at: now,
    actor_sub: ciActor(holder),
    actor_name: "CI",
    actor_email: null,
    action: existing ? "release.revocation.supersede" : "release.revoke",
    target_kind: "release",
    target_id: target.release_id,
    parent_id: null,
    summary: `${existing ? "Superseded the revocation of" : "Revoked"} pack release ${target.release_id} with revocation record ${recordSha256.slice(0, 12)}${body.replacement ? ` (replacement ${body.replacement.version})` : ""}`,
  });
  await bumpReleaseGeneration(env, slug, now);
  const sets = await resolveAndStore(db, slug, now);
  return json({
    ok: true,
    dryRun: false,
    outcome: existing ? "superseded" : "created",
    revocation: {
      sha256: recordSha256,
      target: body.target,
      replacement: body.replacement?.sha256 ?? null,
      stored: true,
    },
    ...(sets.ok ? {} : { packSets: { ok: false, reason: sets.reason } }),
  });
}
