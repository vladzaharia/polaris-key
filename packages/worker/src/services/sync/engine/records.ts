/**
 * Record mutations (U-09.4; WIRE-CONTRACT-V5 §13.3, plans/U-09-slices.md §2.2): the scalar
 * policies as pure functions over a `SyncStore`. One mutation in, one `MutationResult` out. A write
 * allocates the store sequence and becomes the record's `version`; a conflict or a rejection writes
 * nothing.
 *
 * The Worker's classification has answered checks 1 to 4 (`handlers/classify.ts`). What is left
 * here is, in this order: the one check 4 cause that reads the sequence (a `remove` whose
 * `observedSeq` is above it), check 5 (an operation the policy does not allow, or a `max`/`min`
 * record whose `conflictField` is missing), then stored state: a `conflict` (a compare-and-swap
 * mismatch, a stale `lastWrite`, a register mismatch), then `quota_exceeded`. A mutation that
 * conflicts is never charged.
 *
 *   revision      `set`: a number `baseVersion` is compare-and-swap, `"*"` create-only, absent
 *                 unconditional. `delete` likewise.
 *   lastWrite     the same with a `baseVersion`; without one, the `editedHlc` order.
 *   max, min      server mode: the better `conflictField` wins whatever its clock, a tie falls back
 *                 to `lastWrite`. E2E: the compare-and-swap register of §13.3 (the server cannot
 *                 read a field). `delete` is decided by `editedHlc` alone, as a `clear` is.
 *   delete        a tombstone with the clock of the delete. A record the store holds no row for
 *                 answers `ok` and writes nothing, so inventing ids stores nothing.
 *
 * `merge` and `union` records (U-09.5) are planned by `recordSets.ts`; this file admits and writes
 * the plan.
 *
 * Forgotten state is bounded (§13.3): record tombstones, and the removed field cells of `merge`
 * records, are each kept to 2 x `maxRecords` per concrete collection and 20,000 per person. Past
 * either the oldest, by clock, are forgotten. A forgotten tombstone raises the tombstone watermark
 * past it, so a cursor from before cannot silently miss the delete; a forgotten cell is invisible
 * to a pull, so it moves nothing. A tombstone or a removed cell costs no quota; this bound is what
 * stops delete floods from growing the store.
 */

import { CLOUD_SYNC_DEFAULTS } from "@polaris-key/catalog";
import type {
  MutationResult,
  SyncJson,
  SyncMutation,
  SyncOp,
  SyncServerCopy,
} from "@polaris-key/protocol/sync";
import { compareStamps } from "./hlc.js";
import {
  liveRecordValue,
  planFields,
  planSet,
  sealedFields,
  tagAdd,
} from "./recordSets.js";
import { envelopeKid } from "./sealed.js";
import { accountRecord, recordCost } from "./usage.js";
import type {
  Classification,
  PushLimits,
  RecordPolicy,
  Stamp,
  StoredRecord,
  SyncStore,
} from "./types.js";

type RecordRoute = Extract<Classification, { verdict: "record" }>;

/** The operation-versus-policy table (§13.3). Any other operation is `op_invalid_for_policy`. */
export const RECORD_OPS: Readonly<Record<RecordPolicy, ReadonlySet<SyncOp>>> = {
  revision: new Set<SyncOp>(["set", "delete"]),
  lastWrite: new Set<SyncOp>(["set", "delete"]),
  max: new Set<SyncOp>(["set", "delete"]),
  min: new Set<SyncOp>(["set", "delete"]),
  merge: new Set<SyncOp>(["setField", "removeField", "delete"]),
  union: new Set<SyncOp>(["add", "remove", "delete"]),
};

/** Record tombstones one person keeps in all: 2 x the 10,000 records a collection can hold. */
export const MAX_PERSON_RECORD_TOMBSTONES =
  2 * CLOUD_SYNC_DEFAULTS.records.maxRecords;

/** Removed field cells one person keeps in all: as many as the record tombstones. */
const MAX_PERSON_REMOVED_FIELDS = MAX_PERSON_RECORD_TOMBSTONES;

const isPlainObject = (v: SyncJson): v is { [k: string]: SyncJson } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The server's copy of a record, as a `conflict` carries it. A deleted record answers
 * `value: null`; a record the store holds no row for answers version 0. A sealed record answers
 * `ct` in place of `value` (§13.10).
 */
export function recordCopy(row: StoredRecord | undefined): SyncServerCopy {
  if (!row) return { value: null, version: 0 };
  const base = { version: row.version, editedHlc: row.stamp.hlc };
  if (row.sealed && !row.deleted) {
    if (row.kind === "value" && typeof row.value === "string")
      return { ct: row.value, ...base };
    if (row.kind === "fields") return { fields: sealedFields(row), ...base };
  }
  return { value: liveRecordValue(row), ...base };
}

/** What a record mutation needs beyond the route. */
export interface RecordContext {
  limits?: PushLimits;
}

const reject = (
  m: SyncMutation,
  code: "value_invalid" | "op_invalid_for_policy" | "collection_unknown",
): MutationResult => ({ mutationId: m.mutationId, status: "rejected", code });

const conflict = (
  m: SyncMutation,
  row: StoredRecord | undefined,
): MutationResult => ({
  mutationId: m.mutationId,
  status: "conflict",
  server: recordCopy(row),
});

/** A compare-and-swap mismatch: `"*"` against a live record, a number against any other version. */
function casMismatch(
  prev: StoredRecord | undefined,
  baseVersion: number | "*",
): boolean {
  return baseVersion === "*"
    ? prev !== undefined && !prev.deleted
    : prev === undefined || prev.version !== baseVersion;
}

/** The `conflictField` of a `max`/`min` record's value, when it is a finite number. */
function fieldNumber(value: SyncJson, field: string): number | undefined {
  if (!isPlainObject(value) || !Object.hasOwn(value, field)) return undefined;
  const n = value[field];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Admits, then writes (`quota_exceeded` scopes: `collection`, then `product`, then `user`, so the
 * client, which cannot fix `maxRecords` by waiting, learns it first). Only a create can hit
 * `maxRecords`. A delete, and a write that only removes (`shrinking`), are never refused.
 * `onSeq` runs once the sequence is allocated and before the row is written (an `add`'s tag).
 */
function commit(
  store: SyncStore,
  ctx: RecordContext,
  route: RecordRoute,
  m: SyncMutation,
  prev: StoredRecord | undefined,
  next: StoredRecord,
  opts: { shrinking?: boolean; onSeq?: (version: number) => void } = {},
): MutationResult {
  const create = (prev === undefined || prev.deleted) && !next.deleted;
  if (!next.deleted && opts.shrinking !== true) {
    const dBytes = recordCost(next).bytes - recordCost(prev).bytes;
    const usage = store.getUsage();
    const limits = ctx.limits;
    let scope: "collection" | "product" | "user" | null = null;
    if (create && store.liveRecordCount(next.collection) >= route.maxRecords)
      scope = "collection";
    else if (limits?.productOverCeiling && dBytes > 0) scope = "product";
    else if (
      limits &&
      (limits.quotaBytes <= 0 ||
        usage.bytes + Math.max(dBytes, 0) > limits.quotaBytes)
    )
      scope = "user";
    if (scope !== null)
      return {
        mutationId: m.mutationId,
        status: "rejected",
        code: "quota_exceeded",
        scope,
      };
  }
  next.version = store.nextSeq();
  opts.onSeq?.(next.version);
  store.putRecord(next);
  accountRecord(store, prev, next);
  if (next.deleted) forgetTombstones(store, next.collection, route.maxRecords);
  return { mutationId: m.mutationId, status: "ok", version: next.version };
}

/** Keeps the tombstone bounds (see the file comment). Cheap when under them: two counts. */
function forgetTombstones(
  store: SyncStore,
  collection: string,
  maxRecords: number,
): void {
  let through = 0;
  const forget = (limit: number, name?: string) => {
    const over = store.recordTombstoneCount(name) - limit;
    if (over <= 0) return;
    for (const row of store.oldestRecordTombstones(over, name)) {
      store.deleteRecordRow(row.collection, row.id);
      through = Math.max(through, row.version);
    }
  };
  forget(2 * maxRecords, collection);
  forget(MAX_PERSON_RECORD_TOMBSTONES);
  if (through > store.getWatermark()) store.setWatermark(through);
}

/** Keeps the removed-cell bounds (see the file comment): the same two counts as the tombstones'. */
function forgetRemovedFields(
  store: SyncStore,
  collection: string,
  maxRecords: number,
): void {
  const forget = (limit: number, name?: string) => {
    const over = store.removedFieldCount(name) - limit;
    if (over <= 0) return;
    for (const cell of store.oldestRemovedFields(over, name)) {
      const row = store.getRecord(cell.collection, cell.id);
      if (!row?.fields?.get(cell.field)?.removed) continue;
      row.fields.delete(cell.field);
      store.putRecord(row);
    }
  };
  forget(2 * maxRecords, collection);
  forget(MAX_PERSON_REMOVED_FIELDS);
}

function applyDelete(
  store: SyncStore,
  ctx: RecordContext,
  route: RecordRoute,
  m: SyncMutation,
  prev: StoredRecord | undefined,
  stamp: Stamp,
): MutationResult {
  if (prev === undefined)
    return {
      mutationId: m.mutationId,
      status: "ok",
      version: store.currentSeq(),
    };
  const bv = m.baseVersion;
  const byClock = route.policy === "max" || route.policy === "min";
  if (!byClock && bv !== undefined) {
    if (casMismatch(prev, bv)) return conflict(m, prev);
  } else if (
    (byClock || route.policy === "lastWrite") &&
    compareStamps(stamp, prev.stamp) < 0
  )
    return conflict(m, prev);
  // Already deleted: nothing changes, and the tombstone keeps the clock it has.
  if (prev.deleted)
    return { mutationId: m.mutationId, status: "ok", version: prev.version };
  return commit(store, ctx, route, m, prev, {
    collection: prev.collection,
    id: prev.id,
    version: 0,
    stamp,
    deleted: true,
    kind: "value",
    value: null,
  });
}

/**
 * Applies one record mutation. `stamp` carries the clamped `editedHlc` (the server's clock when the
 * mutation has none) and the pushing clientId.
 */
export function applyRecordMutation(
  store: SyncStore,
  m: SyncMutation,
  route: RecordRoute,
  stamp: Stamp,
  ctx: RecordContext = {},
): MutationResult {
  // Check 4's request-only causes were the classifier's; the one that reads the sequence is ours.
  if (route.valueInvalid) return reject(m, "value_invalid");
  if (m.op === "remove" && (m.observedSeq as number) > store.currentSeq())
    return reject(m, "value_invalid");
  // Check 5.
  if (!RECORD_OPS[route.policy].has(m.op))
    return reject(m, "op_invalid_for_policy");
  const byField = route.policy === "max" || route.policy === "min";
  if (
    byField &&
    !route.sealed &&
    m.op === "set" &&
    (route.conflictField === undefined ||
      fieldNumber(m.value as SyncJson, route.conflictField) === undefined)
  )
    return reject(m, "op_invalid_for_policy");

  const [collection, id] = (m.target as { record: [string, string] }).record;
  const loaded = store.getRecord(collection, id);
  // A row at or above `encryptionSince` holds sealed values (§13.10.7).
  const since = store.getEncryptionSince();
  const prev: StoredRecord | undefined =
    loaded && since !== undefined && loaded.version >= since
      ? { ...loaded, sealed: true }
      : loaded;

  if (route.policy === "merge" || route.policy === "union") {
    const plan =
      route.policy === "merge"
        ? planFields(route, m, prev, stamp)
        : planSet(route, m, prev, stamp);
    if (plan.kind === "reject") return reject(m, plan.code);
    if (plan.kind === "conflict") return conflict(m, prev);
    if (plan.kind === "noop")
      return {
        mutationId: m.mutationId,
        status: "ok",
        version: plan.version ?? store.currentSeq(),
      };
    const key = plan.addTag;
    const out = commit(store, ctx, route, m, prev, plan.next, {
      shrinking: plan.shrinking,
      ...(key !== undefined
        ? { onSeq: (v: number) => tagAdd(plan.next, key, v) }
        : {}),
    });
    if (out.status === "ok" && plan.removedCell)
      forgetRemovedFields(store, collection, route.maxRecords);
    return out;
  }

  // A sealed record cannot change shape: the server converts nothing it cannot read.
  if (route.sealed && prev?.sealed && !prev.deleted && prev.kind !== "value")
    return reject(m, "op_invalid_for_policy");

  if (m.op === "delete") return applyDelete(store, ctx, route, m, prev, stamp);

  const value = (route.sealed ? m.ct : m.value) as SyncJson;
  const bv = m.baseVersion;
  const stale = prev !== undefined && compareStamps(stamp, prev.stamp) < 0;
  let stampOut = stamp;
  if (byField && route.sealed && bv !== undefined) {
    // The E2E register: decided by `baseVersion` alone, never by value (§13.3).
    if (casMismatch(prev, bv)) return conflict(m, prev);
    if (prev && compareStamps(prev.stamp, stamp) > 0) stampOut = prev.stamp;
  } else if (byField) {
    const field = route.conflictField;
    const before =
      !route.sealed && field !== undefined && prev && !prev.deleted
        ? fieldNumber(liveRecordValue(prev), field)
        : undefined;
    const after =
      !route.sealed && field !== undefined
        ? fieldNumber(value, field)
        : undefined;
    if (before !== undefined && after !== undefined && before !== after) {
      // The better value wins whatever its clock; the worse loses whatever its clock.
      const beats = route.policy === "max" ? after > before : after < before;
      if (!beats) return conflict(m, prev);
    } else if (stale) return conflict(m, prev);
  } else if (bv !== undefined) {
    if (casMismatch(prev, bv)) return conflict(m, prev);
  } else if (route.policy === "lastWrite" && stale) return conflict(m, prev);

  const kid = route.sealed ? envelopeKid(value as string) : undefined;
  return commit(store, ctx, route, m, prev, {
    collection,
    id,
    version: 0,
    stamp: stampOut,
    deleted: false,
    kind: "value",
    value,
    ...(kid !== undefined ? { kid } : {}),
  });
}
