/**
 * Absorb, records (U-09.8; plans/U-09-slices.md §2.4, D3): the survivor of an account merge takes
 * in the absorbed subject's records, row by row, as `absorb.ts` does for settings. The join is
 * decided by what the rows are, because the absorbed side carries no catalog:
 *
 *   absent         a record the survivor does not hold is copied as it is (a tombstone too, so an
 *                  older write cannot bring it back). A `union` record's elements are tagged anew.
 *   merge          (`fields`) cells union, each name keeping its higher stamp; the floor (the
 *                  latest delete) is the higher of the two and drops every cell stamped below it.
 *   union          (`set`) an element the survivor does not hold live is added under a tag of the
 *                  survivor's own sequence, so an `observedSeq` a client took before the merge
 *                  cannot remove it. The absorbed store's tags are its own sequence and mean nothing
 *                  here. A set deleted after the absorbed copy was last written takes nothing.
 *   value          (`revision`, `lastWrite`, `max`, `min`) equal values are one. Different live
 *                  values are a collision: a record the caller names `lastWrite`, `max` or `min`
 *                  (`recordPolicies`) joins by stamp or by the better field; any other is parked,
 *                  D3: the absorbed copy is kept in `parked_records` and the survivor's stays
 *                  (S-17: never silently overwrite). A tombstone against a value goes by stamp, as
 *                  a push does. Sealed values (E2E) are never compared by content.
 *   shapes         two live records of different shapes (the policy changed under one) park the
 *                  absorbed copy. A tombstone takes the other side's shape and joins as above.
 *
 * Like the settings join it is idempotent: absorbing the same export again, or a fresher export of
 * the same source, converges on the same rows and writes nothing for a row that does not change.
 * Nothing is refused for budget, quota or `maxRecords` (L8); usage moves with the rows.
 */

import type { SyncJson } from "@polaris-key/protocol/sync";
import { compareStamps } from "./hlc.js";
import { liveElements } from "./recordSets.js";
import { accountRecord, canonicalJson } from "./usage.js";
import type {
  FieldCell,
  ParkedRecord,
  RecordPolicy,
  SetElement,
  Stamp,
  StoredRecord,
  SyncStore,
} from "./types.js";

/** What the caller knows of a collection's declaration. Absent collections join as `revision`. */
export interface RecordJoin {
  policy: RecordPolicy;
  /** `max` and `min` in server mode: the number property to compare. */
  conflictField?: string;
}

export interface AbsorbRecordsInput {
  records: readonly StoredRecord[];
  parked: readonly ParkedRecord[];
  /** The absorbed subject: the owner of a copy this absorb parks. */
  fromSubject: string;
  /** The concrete collection's declaration, where the caller knows it. */
  recordPolicies?: ReadonlyMap<string, RecordJoin>;
  /** Epoch seconds, stamped on a copy this absorb parks. */
  now: number;
}

export interface AbsorbRecordsOutcome {
  /** Records written, plus copies parked. */
  rows: number;
  /** Copies parked or carried over. */
  parked: number;
}

const newer = (a: Stamp, b: Stamp): Stamp =>
  compareStamps(a, b) >= 0 ? { ...a } : { ...b };

const stampKey = (s: Stamp | undefined): string =>
  s ? `${s.hlc}\u0000${s.clientId}` : "";

const cellKey = (c: FieldCell): string =>
  `${c.removed ? 1 : 0}|${stampKey(c.stamp)}|${c.kid ?? ""}|${canonicalJson(c.value)}`;

/** A comparable form of a record's state (tags and the version are not state). */
function stateKey(r: StoredRecord): string {
  const fields = [...(r.fields ?? [])]
    .map(([n, c]) => `${n}=${cellKey(c)}`)
    .sort();
  const elements = [...(r.elements ?? [])]
    .filter(([, e]) => e.tags.length > 0)
    .map(([k, e]) => `${k}=${e.kid ?? ""}|${canonicalJson(e.element)}`)
    .sort();
  return JSON.stringify([
    r.kind,
    r.deleted,
    stampKey(r.stamp),
    stampKey(r.floor),
    r.kid ?? "",
    canonicalJson(r.value),
    fields,
    elements,
  ]);
}

const copyField = (c: FieldCell): FieldCell => ({
  ...c,
  value: structuredClone(c.value) as SyncJson,
  stamp: { ...c.stamp },
});

function copyRecord(r: StoredRecord): StoredRecord {
  return {
    ...r,
    stamp: { ...r.stamp },
    value: structuredClone(r.value) as SyncJson,
    ...(r.floor ? { floor: { ...r.floor } } : {}),
    ...(r.fields
      ? {
          fields: new Map(
            [...r.fields].map(([k, c]) => [k, copyField(c)] as const),
          ),
        }
      : {}),
    ...(r.elements
      ? {
          elements: new Map(
            [...r.elements].map(
              ([k, e]) =>
                [
                  k,
                  {
                    ...e,
                    element: structuredClone(e.element),
                    tags: [...e.tags],
                  },
                ] as const,
            ),
          ),
        }
      : {}),
  };
}

const anyLiveField = (fields: ReadonlyMap<string, FieldCell>): boolean => {
  for (const c of fields.values()) if (!c.removed) return true;
  return false;
};

/** A tombstone read as a record of `kind`: a `merge` record's delete is its floor. */
function reshape(dead: StoredRecord, kind: StoredRecord["kind"]): StoredRecord {
  if (dead.kind === kind) return dead;
  return {
    collection: dead.collection,
    id: dead.id,
    version: dead.version,
    stamp: { ...dead.stamp },
    deleted: true,
    kind,
    value: null,
    ...(kind === "fields"
      ? {
          fields: new Map<string, FieldCell>(),
          ...(dead.stamp.hlc !== "" ? { floor: { ...dead.stamp } } : {}),
        }
      : {}),
    ...(kind === "set" ? { elements: new Map<string, SetElement>() } : {}),
  };
}

/** The joined `merge` record: cells by stamp, the higher floor, nothing below it. */
function joinFields(cur: StoredRecord, inc: StoredRecord): StoredRecord {
  const out = copyRecord(cur);
  const cells = out.fields as Map<string, FieldCell>;
  for (const [name, cell] of inc.fields ?? new Map<string, FieldCell>()) {
    const have = cells.get(name);
    if (!have || compareStamps(cell.stamp, have.stamp) > 0)
      cells.set(name, copyField(cell));
  }
  if (inc.floor && (!out.floor || compareStamps(inc.floor, out.floor) > 0))
    out.floor = { ...inc.floor };
  if (out.floor) {
    const floor = out.floor;
    for (const [name, cell] of cells)
      if (compareStamps(cell.stamp, floor) < 0) cells.delete(name);
  }
  out.stamp = newer(cur.stamp, inc.stamp);
  out.deleted = !anyLiveField(cells);
  return out;
}

/** The incoming elements the record does not hold live, in the order of their first add. */
function newElements(
  cur: StoredRecord,
  inc: StoredRecord,
): [string, SetElement][] {
  return liveElements(inc).filter(
    ([key]) => (cur.elements?.get(key)?.tags.length ?? 0) === 0,
  );
}

const numberField = (v: SyncJson, field: string): number | undefined => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const n = (v as { [k: string]: SyncJson })[field];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** Whether the absorbed value record beats the survivor's, for a collision on a known policy. */
function incomingWins(
  cur: StoredRecord,
  inc: StoredRecord,
  join: RecordJoin,
): boolean {
  if (
    (join.policy === "max" || join.policy === "min") &&
    join.conflictField !== undefined &&
    cur.kid === undefined &&
    inc.kid === undefined
  ) {
    const a = numberField(cur.value, join.conflictField);
    const b = numberField(inc.value, join.conflictField);
    if (a !== undefined && b !== undefined && a !== b)
      return join.policy === "max" ? b > a : b < a;
  }
  return compareStamps(inc.stamp, cur.stamp) > 0;
}

type Verdict =
  /** Write this record. `retag`: the elements to tag with fresh sequences, in order. */
  | { kind: "write"; next: StoredRecord; retag?: string[] }
  | { kind: "park" }
  | { kind: "skip" };

const SKIP: Verdict = { kind: "skip" };
const PARK: Verdict = { kind: "park" };

/** The `union` join (see the file comment); the added elements are tagged when written (`writeRecord`). */
function joinSet(cur: StoredRecord, inc: StoredRecord): Verdict {
  // A delete newer than the survivor's set clears it, as a push's `delete` does.
  if (inc.deleted) {
    if (cur.deleted || compareStamps(inc.stamp, cur.stamp) <= 0) return SKIP;
    const dead = copyRecord(cur);
    dead.elements = new Map<string, SetElement>();
    dead.stamp = { ...inc.stamp };
    dead.deleted = true;
    return { kind: "write", next: dead };
  }
  // A set deleted after the absorbed copy was last written takes nothing back.
  if (cur.deleted && compareStamps(inc.stamp, cur.stamp) <= 0) return SKIP;
  const add = newElements(cur, inc);
  if (add.length === 0) return SKIP;
  const next = copyRecord(cur);
  const elements = next.elements as Map<string, SetElement>;
  for (const [key, el] of add)
    elements.set(key, {
      element: structuredClone(el.element) as SyncJson,
      tags: [],
      ...(el.kid !== undefined ? { kid: el.kid } : {}),
    });
  next.stamp = newer(cur.stamp, inc.stamp);
  next.deleted = false;
  return { kind: "write", next, retag: add.map(([key]) => key) };
}

function decide(
  cur: StoredRecord | undefined,
  inc: StoredRecord,
  join: RecordJoin | undefined,
): Verdict {
  if (!cur) {
    const next = copyRecord(inc);
    if (inc.kind !== "set") return { kind: "write", next };
    // The absorbed store's tags are not this store's sequence: tag each live element anew.
    const live = liveElements(inc);
    next.elements = new Map(
      live.map(([k, e]) => [k, { ...e, tags: [] }] as const),
    );
    return { kind: "write", next, retag: live.map(([k]) => k) };
  }
  if (stateKey(cur) === stateKey(inc)) return SKIP;

  if (cur.kind !== inc.kind) {
    if (!cur.deleted && !inc.deleted) return PARK;
    if (cur.deleted && inc.deleted)
      return compareStamps(inc.stamp, cur.stamp) > 0
        ? { kind: "write", next: copyRecord(inc) }
        : SKIP;
    // One is a tombstone: it takes the other's shape, and the shape's own join decides. A skip
    // leaves the stored row as it is, whatever shape the tombstone had.
    const kind = cur.deleted ? inc.kind : cur.kind;
    return decide(reshape(cur, kind), reshape(inc, kind), join);
  }

  if (inc.kind === "fields") {
    const next = joinFields(cur, inc);
    return stateKey(next) === stateKey(cur) ? SKIP : { kind: "write", next };
  }
  if (inc.kind === "set") return joinSet(cur, inc);

  // Value records.
  if (cur.deleted || inc.deleted) {
    // A deletion newer than the value wins, a value newer than the deletion wins; a tie keeps
    // the survivor's.
    return compareStamps(inc.stamp, cur.stamp) > 0
      ? { kind: "write", next: copyRecord(inc) }
      : SKIP;
  }
  // Both live and different. Sealed values are compared by their envelope, never by content.
  if (canonicalJson(cur.value) === canonicalJson(inc.value)) return SKIP;
  if (join && join.policy !== "revision")
    return incomingWins(cur, inc, join)
      ? { kind: "write", next: copyRecord(inc) }
      : SKIP;
  return PARK;
}

/** The parked form of an absorbed record. */
function parkedFrom(
  inc: StoredRecord,
  fromSubject: string,
  now: number,
): ParkedRecord {
  const row = copyRecord(inc);
  return {
    collection: inc.collection,
    id: inc.id,
    fromSubject,
    kind: inc.kind,
    stamp: row.stamp,
    value: row.value,
    ...(row.fields ? { fields: row.fields } : {}),
    ...(row.elements
      ? {
          elements: new Map(
            // Tags are the absorbed store's sequence and mean nothing here.
            [...row.elements].map(
              ([k, e]) => [k, { ...e, tags: [1] }] as const,
            ),
          ),
        }
      : {}),
    ...(row.kid !== undefined ? { kid: row.kid } : {}),
    parkedAt: now,
  };
}

/** Whether two parked copies hold the same content (when they were parked is not content). */
const sameParked = (a: ParkedRecord, b: ParkedRecord): boolean => {
  const key = (p: ParkedRecord) =>
    stateKey({
      collection: p.collection,
      id: p.id,
      version: 0,
      stamp: p.stamp,
      deleted: false,
      kind: p.kind,
      value: p.value,
      ...(p.fields ? { fields: p.fields } : {}),
      ...(p.elements ? { elements: p.elements } : {}),
      ...(p.kid !== undefined ? { kid: p.kid } : {}),
    });
  return key(a) === key(b);
};

/** Writes the joined record: a fresh sequence for the row, and for each element tagged anew. */
function writeRecord(
  store: SyncStore,
  cur: StoredRecord | undefined,
  verdict: Extract<Verdict, { kind: "write" }>,
): void {
  const next = verdict.next;
  const elements = next.elements;
  for (const key of verdict.retag ?? []) {
    const el = elements?.get(key);
    if (el) el.tags = [store.nextSeq()];
  }
  // A set's version is the sequence of its last tag; every other row takes one of its own.
  next.version =
    verdict.retag && verdict.retag.length > 0
      ? store.currentSeq()
      : store.nextSeq();
  store.putRecord(next);
  accountRecord(store, cur, next);
}

/**
 * Joins the absorbed records into `store`. Call inside the store's transaction (see
 * `absorbSettings`). Deterministic in the input's order, which is the export's version order.
 */
export function absorbRecords(
  store: SyncStore,
  input: AbsorbRecordsInput,
): AbsorbRecordsOutcome {
  let rows = 0;
  let parked = 0;
  for (const inc of input.records) {
    const cur = store.getRecord(inc.collection, inc.id);
    const verdict = decide(cur, inc, input.recordPolicies?.get(inc.collection));
    if (verdict.kind === "write") {
      writeRecord(store, cur, verdict);
      rows++;
    } else if (verdict.kind === "park") {
      const copy = parkedFrom(inc, input.fromSubject, input.now);
      const have = store.getParkedRecord(
        inc.collection,
        inc.id,
        input.fromSubject,
      );
      if (have && sameParked(have, copy)) continue;
      store.putParkedRecord(copy);
      rows++;
      parked++;
    }
  }
  // Copies an earlier merge parked on the absorbed side travel with the rest of its data.
  for (const p of input.parked) {
    const have = store.getParkedRecord(p.collection, p.id, p.fromSubject);
    if (have && sameParked(have, p)) continue;
    store.putParkedRecord({
      ...p,
      stamp: { ...p.stamp },
      value: structuredClone(p.value) as SyncJson,
    });
    rows++;
    parked++;
  }
  return { rows, parked };
}
