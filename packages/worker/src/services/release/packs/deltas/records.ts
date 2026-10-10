/**
 * Where a lazy delta's two payloads live (P4-17): the pack records a (from, to) pair, or a newly
 * stored `full` object, belongs to. Read-only, from the stored CI-signed records (the record is
 * the whole truth, P4-02); a yanked release is never a target.
 */

import type {
  PackRecordDoc,
  PackVariant,
  PayloadDelta,
} from "@polaris-key/protocol/packs";
import type { Db } from "../../../../db/types.js";
import { blobKey } from "../../../../core/blobs.js";
import { storedRecordPayload, variantBuildId } from "../ingest.js";
import { LAZY_DELTA_METHOD } from "./policy.js";

/** How many of a pack's newest releases a pair lookup reads (`MAX_PAYLOAD_SCAN`'s bound). */
export const PAIR_SCAN = 200;
const PAGE = 20;

/** One container payload of a pack release, as the consumer needs it. */
export interface PayloadSide {
  releaseId: string;
  deliverableId: string;
  buildId: string;
  /** The record's hash. */
  recordSha256: string;
  record: PackRecordDoc;
  variant: PackVariant;
  /** The record's `entitlement` is set: its objects are under `gated/`. */
  gated: boolean;
  /** The `full` object's blob-store key. */
  fullKey: string;
  yanked: boolean;
}

interface Row {
  release_id: string;
  jws: string;
  record_sha256: string;
  deliverable_id: string;
  yanked: number;
}

const SELECT = `SELECT r.release_id, r.jws, r.record_sha256, m.deliverable_id,
            EXISTS (SELECT 1 FROM release_yanks y
                     WHERE y.product = m.product AND y.release_id = m.release_id) AS yanked
       FROM release_records r
       JOIN release_metadata m ON m.product = r.product AND m.release_id = r.release_id`;

function sides(row: Row): PayloadSide[] {
  const payload = storedRecordPayload(row.jws);
  if (!payload || payload.kind !== "pack") return [];
  const record = payload as unknown as PackRecordDoc;
  if (!Array.isArray(record.variants)) return [];
  const gated = record.entitlement !== undefined;
  const out: PayloadSide[] = [];
  for (const variant of record.variants) {
    if (variant?.files?.layout !== "container" || !variant.full?.sha256)
      continue;
    out.push({
      releaseId: row.release_id,
      deliverableId: row.deliverable_id,
      buildId: variantBuildId(variant.variant ?? {}),
      recordSha256: row.record_sha256,
      record,
      variant,
      gated,
      fullKey: blobKey(variant.full.sha256, { gated }),
      yanked: Boolean(row.yanked),
    });
  }
  return out;
}

/** The container variants of one pack release (by release id), or [] when it is not one. */
export async function releaseSides(
  db: Db,
  product: string,
  releaseId: string,
): Promise<PayloadSide[]> {
  const row = await db.first<Row>(
    `${SELECT} WHERE r.product = ? AND r.release_id = ? AND r.kind = 'pack'`,
    product,
    releaseId,
  );
  return row ? sides(row) : [];
}

export interface FoundPair {
  from: PayloadSide;
  to: PayloadSide;
}

/**
 * The newest not-yanked release variant whose payload is `to`, and a variant of the SAME build
 * (variant key) whose payload is `from`, among the pack's newest `PAIR_SCAN` releases. Null when
 * either is missing (the pair is then not a lazy delta: a device that moved across variants
 * gets none).
 */
export async function findPair(
  db: Db,
  product: string,
  deliverableId: string,
  from: string,
  to: string,
): Promise<FoundPair | null> {
  const targets: PayloadSide[] = [];
  const bases: PayloadSide[] = [];
  for (let offset = 0; offset < PAIR_SCAN; offset += PAGE) {
    const rows = await db.all<Row>(
      `${SELECT} WHERE r.product = ? AND r.kind = 'pack' AND m.deliverable_id = ?
        ORDER BY m.seq DESC, r.release_id LIMIT ? OFFSET ?`,
      product,
      deliverableId,
      PAGE,
      offset,
    );
    for (const row of rows)
      for (const s of sides(row)) {
        if (s.variant.payload?.sha256 === to && !s.yanked) targets.push(s);
        if (s.variant.payload?.sha256 === from) bases.push(s);
      }
    if (rows.length < PAGE) break;
  }
  for (const t of targets) {
    const b = bases.find((x) => x.buildId === t.buildId);
    if (b) return { from: b, to: t };
  }
  return null;
}

/** The `from` of each `zstd-patch-from` payload delta the target's record already carries. */
export function ciDeltaFroms(variant: PackVariant): string[] {
  return (variant.deltas ?? [])
    .filter(
      (d): d is PayloadDelta =>
        d.scope === "payload" && d.method === LAZY_DELTA_METHOD,
    )
    .map((d) => d.from);
}

/** The pack releases (`pack-object` ref holders) that name `storageKey`, per product. */
export async function packObjectHolders(
  db: Db,
  storageKey: string,
): Promise<{ product: string; releaseId: string }[]> {
  const rows = await db.all<{ product: string; ref_id: string }>(
    `SELECT DISTINCT product, ref_id FROM blob_refs
      WHERE storage_key = ? AND ref_kind = 'pack-object'
      ORDER BY product, ref_id LIMIT 64`,
    storageKey,
  );
  return rows.map((r) => ({ product: r.product, releaseId: r.ref_id }));
}

/** The products that hold an upload ref to `storageKey` but no record names it yet (an R2 event
 *  can arrive before the record's ingest commits). */
export async function uploadHolders(
  db: Db,
  storageKey: string,
): Promise<string[]> {
  const rows = await db.all<{ product: string }>(
    `SELECT DISTINCT product FROM blob_refs
      WHERE storage_key = ? AND ref_kind = 'pack-upload' ORDER BY product LIMIT 64`,
    storageKey,
  );
  return rows.map((r) => r.product);
}
