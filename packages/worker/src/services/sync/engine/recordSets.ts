/**
 * `merge` and `union` records (U-09.5; WIRE-CONTRACT-V5 §13.3, plans/U-09-slices.md §2.2): the
 * planners that turn one mutation and the stored row into the row to write. They are pure: they
 * read no store and write none, so `records.ts` keeps the one place that admits, allocates the
 * sequence and writes.
 *
 *   merge   field cells, each a last-write-wins cell ordered by its stamp. `delete` drops the cells
 *           at or below its stamp and sets the record's floor there, so an older field write cannot
 *           bring the record back; a removed field is a cell tombstone. A record whose last live
 *           cell goes is a tombstone itself.
 *   union   an observed-remove set. `add` tags the element with the store sequence of the add (the
 *           caller passes it back once the sequence is allocated); `remove` drops the element's
 *           tags at or below `observedSeq`, so a concurrent add survives. A set with no element
 *           left is a tombstone. An element holds at most `MAX_ELEMENT_TAGS` tags: only the
 *           newest tag decides whether it lives, so repeated adds cannot grow storage.
 *
 * Policy change (§13.6): the server reads the policy at push time and converts at write. An object
 * becomes field cells, and an array becomes elements, stamped as the record stood. A shape that
 * cannot convert (an object stored for a `union` policy, a number for either) is
 * `op_invalid_for_policy`, as is a name or element over the 1 KiB a push allows, and a `delete` always
 * works. In end-to-end mode the server cannot read a
 * sealed record, so it converts nothing: a live record of another shape is `op_invalid_for_policy`
 * for every operation but `delete`.
 *
 * Keys: a `merge` cell is keyed by the field name (a blinded name in E2E mode). A `union` element
 * is keyed by its canonical JSON in server mode and by its blinded name in E2E mode, so equal
 * elements are one element.
 */

import {
  SYNC_MAX_MERGE_MEMBERS,
  SYNC_MAX_RECORD_BYTES,
  SYNC_MAX_UNION_ELEMENT_BYTES,
  type SyncJson,
  type SyncMutation,
  type SyncSealedElement,
  type SyncSealedField,
} from "@polaris-key/protocol/sync";
import { compareStamps } from "./hlc.js";
import { budgetBytes, envelopeKid } from "./sealed.js";
import {
  canonicalJson,
  ENTRY_CHARGE,
  EXTRA_TAG_CHARGE,
  utf8Length,
  valueBytes,
} from "./usage.js";
import type {
  Classification,
  FieldCell,
  SetElement,
  Stamp,
  StoredRecord,
} from "./types.js";

type RecordRoute = Extract<Classification, { verdict: "record" }>;

/** Tags one element keeps. The newest decides whether it lives; more would be unbounded storage. */
export const MAX_ELEMENT_TAGS = 8;

/** The placeholder an `add` carries until its sequence is allocated (`tagAdd`). Real tags are 1 or more. */
const PENDING_TAG = 0;

/** Puts the allocated sequence in place of the pending tag of the element an `add` wrote. */
export function tagAdd(next: StoredRecord, key: string, version: number): void {
  const tags = next.elements?.get(key)?.tags;
  const at = tags ? tags.indexOf(PENDING_TAG) : -1;
  if (tags && at >= 0) tags[at] = version;
}

/** What a blinded field or element name adds to an E2E record's budget (§13.3 Budget). */
export const SEALED_NAME_CHARGE = ENTRY_CHARGE;

export type RecordPlan =
  | { kind: "reject"; code: "value_invalid" | "op_invalid_for_policy" }
  | { kind: "conflict" }
  /** Nothing to write: `ok` with the record's own version, or the store sequence when it has none. */
  | { kind: "noop"; version?: number }
  | {
      kind: "write";
      next: StoredRecord;
      /** The write removes (a `removeField`, a `remove`): it is never refused for quota. */
      shrinking: boolean;
      /** The element the add tags with the sequence the write is given. */
      addTag?: string;
      /** The write left a removed field cell: the forgetting bound applies. */
      removedCell?: boolean;
    };

const invalid: RecordPlan = { kind: "reject", code: "value_invalid" };
const badPolicy: RecordPlan = {
  kind: "reject",
  code: "op_invalid_for_policy",
};

const isPlainObject = (v: SyncJson): v is { [k: string]: SyncJson } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const newer = (a: Stamp, b: Stamp): Stamp => (compareStamps(a, b) >= 0 ? a : b);

const hasStamp = (s: Stamp): boolean => s.hlc !== "";

// ---- reading -------------------------------------------------------------------------------

/** The live elements of a `union` record, in the order of each one's first surviving add tag. */
export function liveElements(row: StoredRecord): [string, SetElement][] {
  return [...(row.elements ?? [])]
    .filter(([, e]) => e.tags.length > 0)
    .sort(
      ([ka, a], [kb, b]) =>
        Math.min(...a.tags) - Math.min(...b.tags) ||
        (ka < kb ? -1 : ka > kb ? 1 : 0),
    );
}

/** The record's live content as a value: its value, a `merge` record's object, a `union` array. */
export function liveRecordValue(row: StoredRecord): SyncJson {
  if (row.deleted) return null;
  if (row.kind === "fields") {
    const out: Record<string, SyncJson> = Object.create(null) as Record<
      string,
      SyncJson
    >;
    let any = false;
    for (const [name, cell] of row.fields ?? []) {
      if (cell.removed) continue;
      out[name] = cell.value;
      any = true;
    }
    return any ? out : null;
  }
  if (row.kind === "set") {
    const live = liveElements(row);
    return live.length > 0 ? live.map(([, e]) => e.element) : null;
  }
  return row.value;
}

/** The live cells of a sealed `merge` record, as the wire carries them (§13.4): its whole content. */
export function sealedFields(row: StoredRecord): SyncSealedField[] {
  const out: SyncSealedField[] = [];
  for (const [field, cell] of row.fields ?? [])
    if (!cell.removed && typeof cell.value === "string")
      out.push({ field, ct: cell.value, editedHlc: cell.stamp.hlc });
  return out;
}

/** The live elements of a sealed `union` record, in the order of each one's first add tag. */
export function sealedElements(row: StoredRecord): SyncSealedElement[] {
  const out: SyncSealedElement[] = [];
  for (const [element, e] of liveElements(row))
    if (typeof e.element === "string") out.push({ element, ct: e.element });
  return out;
}

// ---- budget --------------------------------------------------------------------------------

/**
 * Whether the record is over its 64 KiB (`SYNC_MAX_RECORD_BYTES`): the canonical JSON of its
 * content in server mode plus 45 for every live field or element and 8 for every tag of an element
 * beyond its first; in E2E mode each live entry's `envelopeBytes - 113` plus 45 for its blinded
 * name (and the 8 per extra tag), so a record of many tiny entries cannot charge nothing.
 */
function overBudget(row: StoredRecord, sealed: boolean): boolean {
  let extraTags = 0;
  for (const e of row.elements?.values() ?? [])
    if (e.tags.length > 1) extraTags += e.tags.length - 1;
  const tagBytes = EXTRA_TAG_CHARGE * extraTags;
  if (!sealed) {
    const v = liveRecordValue(row);
    if (v === null) return false;
    const entries =
      row.kind === "fields"
        ? liveFieldCount(row)
        : row.kind === "set"
          ? liveElements(row).length
          : 0;
    return (
      valueBytes(v) + ENTRY_CHARGE * entries + tagBytes > SYNC_MAX_RECORD_BYTES
    );
  }
  let total = tagBytes;
  const charge = (v: SyncJson) =>
    (total +=
      SEALED_NAME_CHARGE + (typeof v === "string" ? budgetBytes(v) : 0));
  if (row.kind === "fields") {
    for (const cell of row.fields?.values() ?? [])
      if (!cell.removed) charge(cell.value);
  } else if (row.kind === "set") {
    for (const [, e] of liveElements(row)) charge(e.element);
  }
  return total > SYNC_MAX_RECORD_BYTES;
}

const liveFieldCount = (row: StoredRecord): number => {
  let n = 0;
  for (const c of row.fields?.values() ?? []) if (!c.removed) n++;
  return n;
};

/**
 * Removed field cells one record keeps (§13.3): the newest `SYNC_MAX_MERGE_MEMBERS`, by stamp. The
 * per-collection and per-person bounds count rows already stored, so without this a single record
 * could hold them all, and every write to it would read them.
 */
export function clampRemovedCells(fields: Map<string, FieldCell>): void {
  let removed = 0;
  for (const c of fields.values()) if (c.removed) removed++;
  if (removed <= SYNC_MAX_MERGE_MEMBERS) return;
  const oldest = [...fields]
    .filter(([, c]) => c.removed)
    .sort(
      ([ka, a], [kb, b]) =>
        compareStamps(a.stamp, b.stamp) || (ka < kb ? -1 : ka > kb ? 1 : 0),
    )
    .slice(0, removed - SYNC_MAX_MERGE_MEMBERS);
  for (const [name] of oldest) fields.delete(name);
}

// ---- the base row --------------------------------------------------------------------------

type Base = { ok: true; row: StoredRecord } | { ok: false; plan: RecordPlan };

const blank = (
  collection: string,
  id: string,
  kind: "fields" | "set",
  prev: StoredRecord | undefined,
): StoredRecord => ({
  collection,
  id,
  version: 0,
  stamp: prev?.stamp ?? { hlc: "", clientId: "" },
  deleted: true,
  kind,
  value: null,
  ...(kind === "fields" ? { fields: new Map<string, FieldCell>() } : {}),
  ...(kind === "set" ? { elements: new Map<string, SetElement>() } : {}),
});

const copyElements = (
  from: ReadonlyMap<string, SetElement> | undefined,
): Map<string, SetElement> =>
  new Map(
    [...(from ?? [])].map(
      ([k, e]) => [k, { ...e, tags: [...e.tags] }] as [string, SetElement],
    ),
  );

/**
 * The row a `merge` mutation works on, as a copy: the stored cells, the cells of a converted
 * object, or none. `sealed` is the route's mode.
 */
function fieldsBase(
  collection: string,
  id: string,
  prev: StoredRecord | undefined,
  sealed: boolean,
): Base {
  const row = blank(collection, id, "fields", prev);
  if (prev === undefined) return { ok: true, row };
  if (prev.kind === "fields") {
    // A live sealed-mode record must already be sealed: a legacy plaintext one mixes nothing.
    if (!prev.deleted && sealed && !prev.sealed)
      return { ok: false, plan: badPolicy };
    row.fields = new Map(prev.fields ?? []);
    row.deleted = prev.deleted;
    if (prev.floor) row.floor = prev.floor;
    return { ok: true, row };
  }
  if (prev.deleted) {
    // A tombstone of another shape still beats an older write.
    if (hasStamp(prev.stamp)) row.floor = prev.stamp;
    return { ok: true, row };
  }
  // Live, and of another shape: only an object in server mode converts.
  if (sealed || prev.kind !== "value" || !isPlainObject(prev.value))
    return { ok: false, plan: badPolicy };
  // The caps a push applies to a name hold for a converted one (§13.3): an over-long name stays
  // with the shape it was written under.
  for (const [name, value] of Object.entries(prev.value)) {
    if (name === "" || utf8Length(name) > SYNC_MAX_UNION_ELEMENT_BYTES)
      return { ok: false, plan: badPolicy };
    row.fields?.set(name, { value, removed: false, stamp: prev.stamp });
  }
  row.deleted = false;
  if (hasStamp(prev.stamp)) row.floor = prev.stamp;
  return { ok: true, row };
}

/** The row a `union` mutation works on, as a copy: see `fieldsBase`. */
function setBase(
  collection: string,
  id: string,
  prev: StoredRecord | undefined,
  sealed: boolean,
): Base {
  const row = blank(collection, id, "set", prev);
  if (prev === undefined) return { ok: true, row };
  if (prev.kind === "set") {
    if (!prev.deleted && sealed && !prev.sealed)
      return { ok: false, plan: badPolicy };
    row.elements = copyElements(prev.elements);
    row.deleted = prev.deleted;
    return { ok: true, row };
  }
  if (prev.deleted) return { ok: true, row };
  if (sealed || prev.kind !== "value" || !Array.isArray(prev.value))
    return { ok: false, plan: badPolicy };
  // Every converted element is tagged with the version the array was stored at, so an
  // `observedSeq` taken from that pull still removes it.
  for (const e of prev.value) {
    if (valueBytes(e) > SYNC_MAX_UNION_ELEMENT_BYTES)
      return { ok: false, plan: badPolicy };
    row.elements?.set(canonicalJson(e), { element: e, tags: [prev.version] });
  }
  row.deleted = false;
  return { ok: true, row };
}

/**
 * A `delete` of a live record of another shape (the policy changed under it): it needs no
 * conversion, so it is a tombstone of the route's shape. An older delete than the record loses.
 */
function foreignDelete(
  route: RecordRoute,
  prev: StoredRecord,
  stamp: Stamp,
): RecordPlan {
  if (compareStamps(stamp, prev.stamp) < 0) return { kind: "conflict" };
  const kind = route.policy === "merge" ? "fields" : "set";
  const row = blank(prev.collection, prev.id, kind, prev);
  row.stamp = stamp;
  if (kind === "fields") row.floor = stamp;
  return { kind: "write", next: row, shrinking: true };
}

type Begun = { plan: RecordPlan } | { row: StoredRecord; sealed: boolean };

/**
 * What both planners start with: a mutation that cannot change anything is answered here (an
 * operation that removes, on a record the store holds no row for: inventing ids stores nothing; a
 * `delete` of a live record of another shape), and otherwise the row to work on, as a copy.
 */
function begin(
  kind: "fields" | "set",
  route: RecordRoute,
  m: SyncMutation,
  prev: StoredRecord | undefined,
  stamp: Stamp,
): Begun {
  const [collection, id] = (m.target as { record: [string, string] }).record;
  const sealed = route.sealed === true;
  if (prev === undefined && m.op !== (kind === "fields" ? "setField" : "add"))
    return { plan: { kind: "noop" } };
  if (m.op === "delete" && prev && !prev.deleted && prev.kind !== kind)
    return { plan: foreignDelete(route, prev, stamp) };
  const base =
    kind === "fields"
      ? fieldsBase(collection, id, prev, sealed)
      : setBase(collection, id, prev, sealed);
  return base.ok ? { row: base.row, sealed } : { plan: base.plan };
}

// ---- merge ---------------------------------------------------------------------------------

const anyLive = (fields: ReadonlyMap<string, FieldCell>): boolean => {
  for (const c of fields.values()) if (!c.removed) return true;
  return false;
};

/**
 * One `merge` record mutation (`setField`, `removeField`, `delete`). `prev` is the stored record,
 * if any; a `removeField` or `delete` of a record the store holds no row for is the caller's
 * no-op.
 */
export function planFields(
  route: RecordRoute,
  m: SyncMutation,
  prev: StoredRecord | undefined,
  stamp: Stamp,
): RecordPlan {
  const begun = begin("fields", route, m, prev, stamp);
  if ("plan" in begun) return begun.plan;
  const { row, sealed } = begun;
  const fields = row.fields as Map<string, FieldCell>;
  // The floor is the latest delete: nothing at or below it can come back.
  if (row.floor && compareStamps(stamp, row.floor) < 0)
    return { kind: "conflict" };

  if (m.op === "delete") {
    // An already-deleted record keeps the clock it has.
    if (prev?.deleted) return { kind: "noop", version: prev.version };
    for (const [name, cell] of fields)
      if (compareStamps(cell.stamp, stamp) <= 0) fields.delete(name);
    row.floor = stamp;
    row.stamp = newer(stamp, row.stamp);
    row.deleted = !anyLive(fields);
    return { kind: "write", next: row, shrinking: true };
  }

  const name = m.field as string;
  const cell = fields.get(name);
  if (cell && compareStamps(stamp, cell.stamp) < 0) return { kind: "conflict" };
  row.stamp = newer(stamp, row.stamp);
  if (m.op === "removeField") {
    fields.set(name, { value: null, removed: true, stamp });
    clampRemovedCells(fields);
    row.deleted = !anyLive(fields);
    return { kind: "write", next: row, shrinking: true, removedCell: true };
  }
  const kid = sealed ? envelopeKid(m.ct as string) : undefined;
  fields.set(name, {
    value: (sealed ? m.ct : m.value) as SyncJson,
    removed: false,
    stamp,
    ...(kid !== undefined ? { kid } : {}),
  });
  row.deleted = false;
  if (overBudget(row, sealed)) return invalid;
  return { kind: "write", next: row, shrinking: false };
}

// ---- union ---------------------------------------------------------------------------------

/** One `union` record mutation (`add`, `remove`, `delete`); see `planFields`. */
export function planSet(
  route: RecordRoute,
  m: SyncMutation,
  prev: StoredRecord | undefined,
  stamp: Stamp,
): RecordPlan {
  const begun = begin("set", route, m, prev, stamp);
  if ("plan" in begun) return begun.plan;
  const { row, sealed } = begun;
  const elements = row.elements as Map<string, SetElement>;

  if (m.op === "delete") {
    if (prev?.deleted) return { kind: "noop", version: prev.version };
    elements.clear();
    row.stamp = stamp;
    row.deleted = true;
    return { kind: "write", next: row, shrinking: true };
  }

  const key = sealed
    ? (m.element as string)
    : canonicalJson(m.element as SyncJson);
  if (m.op === "remove") {
    const observed = m.observedSeq as number;
    const have = elements.get(key);
    const tags = have?.tags.filter((t) => t > observed) ?? [];
    // Nothing at or below `observedSeq` to drop: the element is as it was.
    if (!have || tags.length === have.tags.length) return { kind: "noop" };
    if (tags.length > 0) elements.set(key, { ...have, tags });
    else elements.delete(key);
    row.stamp = stamp;
    row.deleted = liveElements(row).length === 0;
    return { kind: "write", next: row, shrinking: true };
  }

  const kid = sealed ? envelopeKid(m.ct as string) : undefined;
  const have = elements.get(key);
  // The tag is the add's own sequence, put in once it is allocated. A full element drops its
  // newest old tag for it: the oldest keeps the element's place in the order.
  const tags = have ? [...have.tags] : [];
  if (tags.length >= MAX_ELEMENT_TAGS) tags.pop();
  tags.push(PENDING_TAG);
  elements.set(key, {
    element: (sealed ? m.ct : m.element) as SyncJson,
    tags,
    ...(kid !== undefined ? { kid } : {}),
  });
  row.stamp = stamp;
  row.deleted = false;
  if (overBudget(row, sealed)) return invalid;
  return { kind: "write", next: row, shrinking: false, addTag: key };
}
