/// <reference types="@cloudflare/workers-types" />

/**
 * Publishing a pack (P4-02, plans/P4-01.md §6, decision 28): stage rounds, then one record
 * submit. Both are CI routes in the release namespace, behind the same `pkeyci_` token and
 * `release:publish` scope as `uploads` and `submit` (`../publish.ts` authenticates and hands over).
 *
 *   POST /<p>/release/publish/stage   `{ticket, deliverable}` → `{staged, present}`
 *   POST /<p>/release/publish/submit  `{ticket?, record, dryRun?}` with NO descriptor → a pack
 *                                     release (the record is the whole truth), or (P4-13) a
 *                                     `kind: revocation` record (`revocations.ts`)
 *
 * WHY ROUNDS. One submit verifies and promotes inside one request, at up to five R2 calls and
 * one D1 query per object, against 10,000 subrequests per invocation (notes/E5, E7). A
 * Diceroll-sized pack is about 1,900 objects, so CI uploads them in rounds of at most
 * `MAX_TICKET_OBJECTS` (256): each round verifies its ticket's objects, claims the ticket,
 * promotes each and earns one `blob_refs` row per object, `(product, key, "pack-upload",
 * <packId>)`. A round of 256 objects costs about 1,550 subrequests. The record submit then checks
 * every object the record and its indexes name against those refs (`ingest.ts`).
 *
 * THE GATE (decision 35). Every object of a pack is staged under the pack's delivery gate:
 * `gated` exactly when `delivery.entitlement(pack)` is set (`gated_mismatch` otherwise). While
 * Distribution is off the hook is null, and both routes refuse every pack
 * (`distribution_disabled`). A `pack-upload` ref is possession, not liveness: the stage round
 * earns one only by promoting a verified upload from the product's own staging prefix (P2-01's
 * rule (a)).
 */

import type { ServiceContext } from "../../../core/registry.js";
import { errorResponse, ErrorCode, json } from "../../../core/errors.js";
import { ciActor } from "../../../core/ciScope.js";
import {
  blobKey,
  promote,
  referencedKeys,
  stagingKey,
  verifyStaged,
} from "../../../core/blobs.js";
import {
  claimUploadTicket,
  findUploadTicket,
  releaseUploadTicket,
  type CiTokenRecord,
  type TicketRecord,
} from "../../../core/publisher.js";
import { appendAudit } from "../../../core/data.js";
import { randomId } from "../../../core/platform.js";
import type { DbStatement } from "../../../core/platform.js";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import { bumpReleaseGeneration } from "../ghCache.js";
import {
  artifactsAccessSnapshot,
  artifactPolicy,
  getReleaseConfig,
} from "../config.js";
import { storeAccess } from "../store.js";
import {
  sha256HexOfAscii,
  verifyRecordJws,
  type RecordRefusalReason,
} from "../records.js";
import { readPackDeliverable, readPackDeliverables } from "./deliverables.js";
import { checkPackPublish } from "./checks.js";
import { resolveAndStore } from "./sets.js";
import { handleRevocationSubmit } from "./revocations.js";
import {
  checkPackAgainstDeclaration,
  checkPackRequires,
  checkPackScheme,
  checkPackStore,
  packReleaseId,
  packReleaseStatements,
  PACK_RELEASE_RECORD_SQL,
  type PendingObject,
} from "./ingest.js";

/** A record submit carries no descriptor: the record, a ticket and a flag. */
export const MAX_PACK_SUBMIT_BODY_BYTES = MAX_RECORD_JWS_BYTES + 4 * 1024;

function refusal(
  status: number,
  code: string,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return errorResponse(status, code, message, { reason, ...extra });
}

function recordRefusal(reason: RecordRefusalReason, message: string): Response {
  return errorResponse(
    reason === "seq" ? 409 : 400,
    "release_record_rejected",
    message,
    { reason },
  );
}

/** `distribution_disabled`: a pack publish while Distribution is off for the product. */
export function distributionDisabled(deliverable: string): Response {
  return refusal(
    409,
    ErrorCode.BadRequest,
    "distribution_disabled",
    `${deliverable} is a pack, and Distribution is off for this product: a pack is served by Distribution, so it cannot be published until Distribution is on.`,
    { deliverable },
  );
}

/** The pack's delivery gate, through Distribution's hook, or the refusal when it is off. */
async function gateOf(
  ctx: ServiceContext,
  deliverable: string,
): Promise<{ gate: string | null } | Response> {
  const delivery = ctx.hooks.delivery();
  if (!delivery) return distributionDisabled(deliverable);
  return { gate: await delivery.entitlement(deliverable) };
}

// ── One round: verify, claim, promote, earn pack-upload refs ──────────────────

interface RoundObject {
  target: string;
  staging: string;
  sha256: string;
  size: number;
}

/**
 * The objects of `ticket` this round must promote (the ones the product does not already
 * reference), after checking each one's `gated` flag against the gate. Reads only.
 */
async function roundObjects(
  ctx: ServiceContext,
  ticket: TicketRecord,
  gate: string | null,
): Promise<{ todo: RoundObject[]; present: string[] } | Response> {
  const gated = gate !== null;
  for (const o of ticket.objects)
    if (o.gated !== gated)
      return refusal(
        400,
        ErrorCode.BadRequest,
        "gated_mismatch",
        gated
          ? `${o.sha256} was requested ungated, but the pack is gated (${gate}): request every object with gated: true.`
          : `${o.sha256} was requested gated, but the pack is ungated: request every object with gated: false.`,
        { sha256: o.sha256 },
      );
  const targets = ticket.objects.map((o) => blobKey(o.sha256, { gated }));
  const owned = await referencedKeys(ctx.db, ctx.product.slug, targets);
  const todo: RoundObject[] = [];
  const present: string[] = [];
  for (const [i, o] of ticket.objects.entries()) {
    const target = targets[i]!;
    if (owned.has(target)) present.push(target);
    else
      todo.push({
        target,
        staging: stagingKey(ctx.product.slug, ticket.ticketId, o.sha256),
        sha256: o.sha256,
        size: o.size,
      });
  }
  return { todo, present };
}

/** Verify every staged copy (one `head` each); the first failure refuses, nothing promoted. */
async function verifyRound(
  bucket: R2Bucket,
  todo: readonly RoundObject[],
  opts: { allowMissing?: boolean } = {},
): Promise<{ missing: string[] } | Response> {
  const missing: string[] = [];
  for (const o of todo) {
    const v = await verifyStaged(bucket, o.staging, {
      sha256: o.sha256,
      size: o.size,
    });
    if (!v.ok && v.reason === "missing" && opts.allowMissing) {
      missing.push(o.target);
      continue;
    }
    if (!v.ok)
      return refusal(
        400,
        ErrorCode.BadRequest,
        v.reason === "missing"
          ? "staged_object_missing"
          : "staged_object_mismatch",
        v.reason === "missing"
          ? `${o.staging} was not uploaded`
          : `${o.staging} does not have the ticket's sha256 and size`,
        {
          key: o.target,
          staged: o.staging,
          ...(v.reason === "missing" ? {} : { detail: v.reason }),
        },
      );
  }
  return { missing };
}

/**
 * Claim the ticket, promote each object, and write one `pack-upload` ref per promoted object in
 * one batch of multi-row inserts. A failure gives the claim back; the objects already promoted
 * keep their refs (`promote` is idempotent, and each was verified from this product's staging).
 */
async function promoteRound(
  ctx: ServiceContext,
  bucket: R2Bucket,
  ticket: TicketRecord,
  deliverable: string,
  todo: readonly RoundObject[],
): Promise<Response | null> {
  const { db, product, now } = ctx;
  if (!(await claimUploadTicket(db, ticket.ticketHash, now)))
    return refusal(
      409,
      ErrorCode.BadRequest,
      "ticket_redeemed",
      "this upload ticket was already redeemed",
    );
  const promoted: string[] = [];
  let failure: Response | null = null;
  for (const o of todo) {
    const res = await promote(
      bucket,
      o.staging,
      o.target,
      { sha256: o.sha256, size: o.size },
      { db, now, product: product.slug },
    );
    // `res.alreadyStored` is never read: CI is answered the same either way (THREAT-MODEL §3).
    if (res.ok) {
      promoted.push(o.target);
      continue;
    }
    const reason =
      res.reason === "missing"
        ? "staged_object_missing"
        : res.reason === "size_mismatch" || res.reason === "digest_mismatch"
          ? "staged_object_mismatch"
          : "promote_failed";
    failure = refusal(
      reason === "promote_failed" ? 409 : 400,
      ErrorCode.BadRequest,
      reason,
      `${o.staging} could not be promoted (${res.reason})`,
      {
        key: o.target,
        staged: o.staging,
        ...(reason === "promote_failed" ? { retryable: true } : {}),
      },
    );
    break;
  }
  if (promoted.length > 0)
    await db.batch(packUploadRefs(product.slug, deliverable, promoted, now));
  if (failure) {
    await releaseUploadTicket(db, ticket.ticketHash, now);
    return failure;
  }
  try {
    await bucket.delete(todo.map((o) => o.staging));
  } catch {
    // Best effort: the bucket's one-day rule takes them anyway.
  }
  return null;
}

/** `(product, key, "pack-upload", <packId>)` refs, 20 rows (100 parameters) per insert. */
function packUploadRefs(
  product: string,
  deliverable: string,
  keys: readonly string[],
  now: number,
): DbStatement[] {
  const out: DbStatement[] = [];
  for (let i = 0; i < keys.length; i += 20) {
    const chunk = keys.slice(i, i + 20);
    out.push({
      sql: `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
            VALUES ${chunk.map(() => "(?, ?, 'pack-upload', ?, ?)").join(", ")}
            ON CONFLICT(product, storage_key, ref_kind, ref_id) DO NOTHING`,
      params: chunk.flatMap((k) => [product, k, deliverable, now]),
    });
  }
  return out;
}

// ── POST /<p>/release/publish/stage ──────────────────────────────────────────

export async function handleStageRound(
  ctx: ServiceContext,
  holder: CiTokenRecord,
  body: Record<string, unknown>,
): Promise<Response> {
  const bucket = ctx.env.BLOBS!;
  const deliverable = body.deliverable;
  if (typeof deliverable !== "string")
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      "deliverable must be the pack id this round uploads for",
    );
  const pack = await readPackDeliverable(ctx.db, ctx.product.slug, deliverable);
  if (!pack)
    return refusal(
      400,
      ErrorCode.BadRequest,
      "unknown_pack_deliverable",
      `${deliverable} is not a pack deliverable ${ctx.product.slug} declares in .pkey/release.`,
      { deliverable },
    );
  const g = await gateOf(ctx, deliverable);
  if (g instanceof Response) return g;
  const found = await findUploadTicket(ctx.env, ctx.db, {
    ticket: body.ticket,
    product: ctx.product.slug,
    holder,
    now: ctx.now,
  });
  if (!found.ok)
    return refusal(
      found.status,
      found.status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest,
      found.reason,
      found.message,
    );
  const round = await roundObjects(ctx, found.ticket, g.gate);
  if (round instanceof Response) return round;
  const verified = await verifyRound(bucket, round.todo);
  if (verified instanceof Response) return verified;
  const failed = await promoteRound(
    ctx,
    bucket,
    found.ticket,
    deliverable,
    round.todo,
  );
  if (failed) return failed;
  return json({
    ok: true,
    deliverable,
    staged: round.todo.map((o) => o.target).sort(),
    present: round.present.sort(),
  });
}

// ── POST /<p>/release/publish/submit, a pack record ─────────────────────────

/**
 * A pack release: `{ticket?, record, dryRun?}`. The optional ticket (at most 256 objects) is
 * promoted as a round first, so a small pack, or an update whose new objects fit, publishes in
 * one request. A dry run runs every check without promoting and lists in `unverified` the ticket
 * objects not uploaded yet.
 */
export async function handlePackSubmit(
  ctx: ServiceContext,
  holder: CiTokenRecord,
  body: Record<string, unknown>,
): Promise<Response> {
  const { db, env, product, now } = ctx;
  const bucket = env.BLOBS!;
  if (
    new TextEncoder().encode(JSON.stringify(body)).length >
    MAX_PACK_SUBMIT_BODY_BYTES
  )
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      `a pack record submit is at most ${MAX_PACK_SUBMIT_BODY_BYTES} bytes`,
    );
  const dryRun = body.dryRun === true;

  // 1. The checks every record shares, then the pack's own, reading only.
  const cfg = await getReleaseConfig(db, product.slug);
  const shared = await verifyRecordJws(db, {
    product: product.slug,
    jws: body.record,
    cfg,
  });
  if (!shared.ok) return recordRefusal(shared.reason, shared.message);
  // P4-13: a revocation record is submitted alone too (no ticket, no descriptor).
  if (shared.payload.kind === "revocation")
    return handleRevocationSubmit(ctx, holder, shared, dryRun);
  if (shared.payload.kind !== "pack")
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      "an app record is submitted with its release descriptor; only a kind: pack or kind: revocation record is submitted alone",
    );
  const record = shared.payload as unknown as PackRecordDoc;
  const recordSha256 = await sha256HexOfAscii(shared.jws);
  const pack = await readPackDeliverable(db, product.slug, record.deliverable);
  if (!pack)
    return recordRefusal(
      "pack-unknown",
      `${record.deliverable} is not a pack deliverable ${product.slug} declares in .pkey/release.`,
    );
  const scheme = checkPackScheme(record, pack);
  if (scheme) return recordRefusal(scheme.reason, scheme.message);

  // seq, and the release as the store has it.
  const releaseId = packReleaseId(record);
  const existing = await db.first<{
    release_id: string;
    deliverable_id: string;
    seq: number | null;
    record: string | null;
  }>(
    `SELECT m.release_id, m.deliverable_id, m.seq,
            json_extract(m.metadata_json, '$.record.sha256') AS record
       FROM release_metadata m
      WHERE m.product = ? AND (m.release_id = ? OR (m.deliverable_id = ? AND m.version = ?))
      LIMIT 1`,
    product.slug,
    releaseId,
    record.deliverable,
    record.version,
  );
  if (existing && existing.record === recordSha256)
    return json({
      ok: true,
      dryRun,
      releaseId,
      outcome: "unchanged",
      record: { sha256: recordSha256, stored: false },
    });
  if (existing)
    return refusal(
      409,
      ErrorCode.BadRequest,
      "release_exists",
      existing.seq !== null && existing.seq !== record.seq
        ? `${record.deliverable} ${record.version} has seq ${existing.seq}; the record says ${record.seq}.`
        : `${record.deliverable} ${record.version} already exists with another record; a record is never rewritten.`,
    );
  const maxRow = await db.first<{ m: number | null }>(
    "SELECT MAX(seq) AS m FROM release_metadata WHERE product = ? AND deliverable_id = ?",
    product.slug,
    record.deliverable,
  );
  if (record.seq <= (maxRow?.m ?? 0))
    return recordRefusal(
      "seq",
      `the record says seq ${record.seq}, not above ${record.deliverable}'s last (${maxRow?.m ?? 0}). Ask the uploads preflight for the release's seq and sign again.`,
    );

  const g = await gateOf(ctx, record.deliverable);
  if (g instanceof Response) return g;
  const declared = checkPackAgainstDeclaration(record, pack, g.gate);
  if (declared) return recordRefusal(declared.reason, declared.message);
  // P4-12: the signed requirements against the binding and the declared packs, and the channel.
  const all = await readPackDeliverables(db, product.slug);
  const required = checkPackRequires(
    record,
    pack,
    new Map(all.packs.map((p) => [p.id, p.binding])),
  );
  if (required) return recordRefusal(required.reason, required.message);

  // 2. The optional ticket: a round of its own (a dry run only verifies what is staged).
  let ticket: TicketRecord | null = null;
  const pending = new Map<string, PendingObject>();
  const unverified = new Set<string>();
  let staged: string[] = [];
  if (body.ticket !== undefined) {
    const found = await findUploadTicket(env, db, {
      ticket: body.ticket,
      product: product.slug,
      holder,
      now,
    });
    if (!found.ok)
      return refusal(
        found.status,
        found.status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest,
        found.reason,
        found.message,
      );
    ticket = found.ticket;
    const round = await roundObjects(ctx, ticket, g.gate);
    if (round instanceof Response) return round;
    const verified = await verifyRound(bucket, round.todo, {
      allowMissing: dryRun,
    });
    if (verified instanceof Response) return verified;
    for (const k of verified.missing) unverified.add(k);
    if (dryRun) {
      for (const o of round.todo)
        if (!unverified.has(o.target))
          pending.set(o.target, {
            sha256: o.sha256,
            size: o.size,
            staging: o.staging,
          });
    } else {
      const failed = await promoteRound(
        ctx,
        bucket,
        ticket,
        record.deliverable,
        round.todo,
      );
      if (failed) return failed;
      staged = round.todo.map((o) => o.target).sort();
    }
  }

  // 3. Every object the record and its indexes name, one index at a time.
  const store = await checkPackStore(db, bucket, product.slug, record, {
    pending,
    unverified,
  });
  if (!store.ok) return recordRefusal(store.reason, store.message);

  // 4. The resolution check (P4-12): the sets every live selector would resolve with it.
  const sets = await checkPackPublish(
    db,
    product.slug,
    record,
    recordSha256,
    cfg,
  );
  if (!sets.ok) return recordRefusal(sets.reason, sets.message);
  if (dryRun)
    return json({
      ok: true,
      dryRun: true,
      releaseId,
      outcome: "created",
      record: { sha256: recordSha256, kid: shared.kid },
      files: store.files,
      unverified: [...unverified].sort(),
      ...(sets.report ? { packSets: sets.report } : {}),
    });

  // 5. The rows, in one batch; a lost race writes nothing.
  const policy = cfg ? artifactPolicy(cfg) : null;
  await db.batch(
    packReleaseStatements({
      product: product.slug,
      record,
      recordSha256,
      kid: shared.kid,
      jws: shared.jws,
      metadataAccess: storeAccess(policy?.access.metadata ?? "public"),
      artifactsAccess: storeAccess(
        cfg ? artifactsAccessSnapshot(cfg) : "public",
      ),
      now,
    }),
  );
  const mine = await db.first<{ one: number }>(
    `SELECT 1 AS one WHERE ${PACK_RELEASE_RECORD_SQL}`,
    product.slug,
    releaseId,
    recordSha256,
  );
  if (!mine)
    return refusal(
      409,
      ErrorCode.BadRequest,
      "release_exists",
      `${record.deliverable} ${record.version} changed while this record was being checked; submit it again.`,
      { retryable: true },
    );
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: ciActor(holder),
    actor_name: "CI",
    actor_email: null,
    action: "release.publish",
    target_kind: "release",
    target_id: releaseId,
    parent_id: null,
    summary: `Published pack release ${releaseId} through trusted publishing with release record ${recordSha256.slice(0, 12)}`,
  });
  await bumpReleaseGeneration(env, product.slug, now);
  // Store the rows the check resolved (re-resolving only if a concurrent trigger moved them).
  if (sets.resolved)
    await resolveAndStore(db, product.slug, now, sets.resolved);
  return json({
    ok: true,
    dryRun: false,
    releaseId,
    outcome: "created",
    record: { sha256: recordSha256, stored: true },
    staged,
    ...(sets.report ? { packSets: sets.report } : {}),
  });
}
