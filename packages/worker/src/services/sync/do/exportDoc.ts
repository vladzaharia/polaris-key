/**
 * Reading an `ExportDocument` back into the engine's rows (U-05.8). The document came from another
 * of our own objects, but an absorb writes it into a person's store, so its shape is checked as an
 * input is: a malformed one is refused whole, before any write.
 */

import { SYNC_KEY_PATTERN, type SyncJson } from "@polaris-key/protocol/sync";
import { isClientId, isHlc } from "../engine/hlc.js";
import type { RecordJoin } from "../engine/absorbRecords.js";
import { MAX_ELEMENT_TAGS } from "../engine/recordSets.js";
import type {
  ClientRecord,
  FieldCell,
  MemberCell,
  ParkedRecord,
  RecordKind,
  RecordPolicy,
  SetElement,
  SettingPolicy,
  Stamp,
  StoredRecord,
  StoredSetting,
} from "../engine/types.js";
import type { ExportDocument } from "./protocol.js";

const KEY_RE = new RegExp(SYNC_KEY_PATTERN);
const POLICIES: ReadonlySet<string> = new Set<SettingPolicy>([
  "lastWrite",
  "max",
  "min",
  "merge",
]);

const RECORD_POLICIES: ReadonlySet<string> = new Set<RecordPolicy>([
  "revision",
  "lastWrite",
  "max",
  "min",
  "merge",
  "union",
]);
const KIDS: ReadonlySet<string> = new Set<RecordKind>([
  "value",
  "fields",
  "set",
]);
/** An envelope key id: the hex of bytes 1 to 16 (`engine/sealed.ts` `envelopeKid`). */
const KID_RE = /^[0-9a-f]{32}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function stampOf(v: unknown): Stamp | null {
  return isObject(v) && isHlc(v.hlc) && isClientId(v.clientId)
    ? { hlc: v.hlc, clientId: v.clientId }
    : null;
}

/** An optional `kid`: `undefined` when absent, `null` when present and malformed. */
function kidOf(v: unknown): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" && KID_RE.test(v) ? v : null;
}

function rowOf(v: unknown): StoredSetting | null {
  if (!isObject(v)) return null;
  const stamp = stampOf(v.stamp);
  if (
    !stamp ||
    typeof v.key !== "string" ||
    !KEY_RE.test(v.key) ||
    (v.scope !== "user" && v.scope !== "platform") ||
    typeof v.deleted !== "boolean" ||
    !("value" in v)
  )
    return null;
  if (v.scope === "platform" && typeof v.family !== "string") return null;
  const row: StoredSetting = {
    key: v.key,
    scope: v.scope,
    ...(v.scope === "platform" ? { family: v.family as string } : {}),
    // Kept to tell a sealed row from a legacy one (§13.10.7); the join gives it a version of its own.
    version:
      Number.isSafeInteger(v.version) && (v.version as number) >= 0
        ? (v.version as number)
        : 0,
    stamp,
    deleted: v.deleted,
    value: v.value as SyncJson,
  };
  const kid = kidOf(v.kid);
  if (kid === null) return null;
  if (kid !== undefined) row.kid = kid;
  if (v.floor !== undefined && v.floor !== null) {
    const floor = stampOf(v.floor);
    if (!floor) return null;
    row.floor = floor;
  }
  if (v.members !== undefined) {
    if (!Array.isArray(v.members)) return null;
    const members = new Map<string, MemberCell>();
    for (const pair of v.members) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const [name, cell] = pair as [unknown, unknown];
      if (typeof name !== "string" || !isObject(cell)) return null;
      const cs = stampOf(cell.stamp);
      if (!cs || typeof cell.removed !== "boolean" || !("value" in cell))
        return null;
      const ck = kidOf(cell.kid);
      if (ck === null) return null;
      members.set(name, {
        value: cell.value as SyncJson,
        removed: cell.removed,
        stamp: cs,
        ...(ck !== undefined ? { kid: ck } : {}),
      });
    }
    row.members = members;
  }
  return row;
}

const isName = (v: unknown): v is string => typeof v === "string" && v !== "";

/** `[name, cell]` pairs of a record's fields; `null` when not that. */
function fieldsOf(v: unknown): Map<string, FieldCell> | null {
  if (!Array.isArray(v)) return null;
  const out = new Map<string, FieldCell>();
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [name, cell] = pair as [unknown, unknown];
    if (!isName(name) || !isObject(cell)) return null;
    const stamp = stampOf(cell.stamp);
    const kid = kidOf(cell.kid);
    if (
      !stamp ||
      kid === null ||
      typeof cell.removed !== "boolean" ||
      !("value" in cell)
    )
      return null;
    out.set(name, {
      value: cell.value as SyncJson,
      removed: cell.removed,
      stamp,
      ...(kid !== undefined ? { kid } : {}),
    });
  }
  return out;
}

/** `[key, element]` pairs of a `union` record; `null` when not that. */
function elementsOf(v: unknown): Map<string, SetElement> | null {
  if (!Array.isArray(v)) return null;
  const out = new Map<string, SetElement>();
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [key, el] = pair as [unknown, unknown];
    if (!isName(key) || !isObject(el) || !("element" in el)) return null;
    const kid = kidOf(el.kid);
    if (
      kid === null ||
      !Array.isArray(el.tags) ||
      el.tags.length === 0 ||
      el.tags.length > MAX_ELEMENT_TAGS ||
      !el.tags.every((t) => Number.isSafeInteger(t) && (t as number) > 0)
    )
      return null;
    out.set(key, {
      element: el.element as SyncJson,
      tags: [...(el.tags as number[])],
      ...(kid !== undefined ? { kid } : {}),
    });
  }
  return out;
}

/** The parts a stored and a parked record share, or `null` when the shape is wrong. */
function recordCore(v: Record<string, unknown>): {
  collection: string;
  id: string;
  kind: RecordKind;
  stamp: Stamp;
  value: SyncJson;
  kid?: string;
  fields?: Map<string, FieldCell>;
  elements?: Map<string, SetElement>;
} | null {
  const stamp = stampOf(v.stamp);
  const kid = kidOf(v.kid);
  if (
    !stamp ||
    kid === null ||
    typeof v.collection !== "string" ||
    !KEY_RE.test(v.collection) ||
    typeof v.id !== "string" ||
    !KEY_RE.test(v.id) ||
    typeof v.kind !== "string" ||
    !KIDS.has(v.kind) ||
    !("value" in v)
  )
    return null;
  const kind = v.kind as RecordKind;
  const out: NonNullable<ReturnType<typeof recordCore>> = {
    collection: v.collection,
    id: v.id,
    kind,
    stamp,
    value: v.value as SyncJson,
    ...(kid !== undefined ? { kid } : {}),
  };
  // The shape and the content agree: a `fields` record has cells and no elements, and so on.
  if (kind === "fields") {
    const fields = fieldsOf(v.fields);
    if (!fields || v.elements !== undefined) return null;
    out.fields = fields;
  } else if (kind === "set") {
    const elements = elementsOf(v.elements);
    if (!elements || v.fields !== undefined) return null;
    out.elements = elements;
  } else if (v.fields !== undefined || v.elements !== undefined) return null;
  return out;
}

function recordOf(v: unknown): StoredRecord | null {
  if (!isObject(v) || typeof v.deleted !== "boolean") return null;
  const core = recordCore(v);
  if (!core) return null;
  const row: StoredRecord = { ...core, version: 0, deleted: v.deleted };
  if (v.floor !== undefined && v.floor !== null) {
    const floor = stampOf(v.floor);
    if (!floor) return null;
    row.floor = floor;
  }
  return row;
}

function parkedOf(v: unknown): ParkedRecord | null {
  if (
    !isObject(v) ||
    !isName(v.fromSubject) ||
    v.fromSubject.length > 256 ||
    !Number.isSafeInteger(v.parkedAt) ||
    (v.parkedAt as number) < 0
  )
    return null;
  const core = recordCore(v);
  return core
    ? { ...core, fromSubject: v.fromSubject, parkedAt: v.parkedAt as number }
    : null;
}

export interface ParsedExport {
  settings: StoredSetting[];
  /** Records, tombstones included; an export from before U-09.8 has none. */
  records: StoredRecord[];
  /** Copies an earlier account merge parked (D3); the survivor carries them on. */
  parked: ParkedRecord[];
  clients: ClientRecord[];
  /** The absorbed store's `encryptionSince`, when it has one. */
  encryptionSince?: number;
}

/** The document's rows and clients, or `null` when its shape is wrong. */
export function parseExportDocument(doc: unknown): ParsedExport | null {
  if (!isObject(doc) || !Array.isArray(doc.settings)) return null;
  if (!Array.isArray(doc.clients)) return null;
  const since = doc.encryptionSince;
  if (
    since !== undefined &&
    (!Number.isSafeInteger(since) || (since as number) < 1)
  )
    return null;
  const settings: StoredSetting[] = [];
  for (const raw of doc.settings) {
    const row = rowOf(raw);
    if (!row) return null;
    settings.push(row);
  }
  const records: StoredRecord[] = [];
  const parked: ParkedRecord[] = [];
  for (const [raw, into, parse] of [
    [doc.records, records, recordOf],
    [doc.parked, parked, parkedOf],
  ] as const) {
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) return null;
    for (const item of raw) {
      const row = parse(item);
      if (!row) return null;
      (into as unknown[]).push(row);
    }
  }
  const clients: ClientRecord[] = [];
  for (const c of doc.clients) {
    if (
      !isObject(c) ||
      !isClientId(c.clientId) ||
      typeof c.deviceId !== "string" ||
      c.deviceId.length === 0 ||
      !Number.isSafeInteger(c.lastMutationId) ||
      (c.lastMutationId as number) < 0
    )
      return null;
    clients.push({
      clientId: c.clientId,
      deviceId: c.deviceId,
      lastMutationId: c.lastMutationId as number,
    });
  }
  return {
    settings,
    records,
    parked,
    clients,
    ...(since !== undefined ? { encryptionSince: since as number } : {}),
  };
}

/** The wire form of a policy table, or `null` when it is not one. */
export function parsePolicies(
  v: unknown,
): ReadonlyMap<string, SettingPolicy> | null | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return null;
  const out = new Map<string, SettingPolicy>();
  for (const pair of v) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !POLICIES.has(pair[1] as string)
    )
      return null;
    out.set(pair[0], pair[1] as SettingPolicy);
  }
  return out;
}

/** The wire form of a record declaration table (by concrete collection), or `null` when it is not one. */
export function parseRecordPolicies(
  v: unknown,
): ReadonlyMap<string, RecordJoin> | null | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return null;
  const out = new Map<string, RecordJoin>();
  for (const pair of v) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !isObject(pair[1]) ||
      typeof pair[1].policy !== "string" ||
      !RECORD_POLICIES.has(pair[1].policy) ||
      (pair[1].conflictField !== undefined &&
        typeof pair[1].conflictField !== "string")
    )
      return null;
    out.set(pair[0], {
      policy: pair[1].policy as RecordPolicy,
      ...(pair[1].conflictField !== undefined
        ? { conflictField: pair[1].conflictField }
        : {}),
    });
  }
  return out;
}

export type { ExportDocument };
