/**
 * Reading an `ExportDocument` back into the engine's rows (U-05.8). The document came from another
 * of our own objects, but an absorb writes it into a person's store, so its shape is checked as an
 * input is: a malformed one is refused whole, before any write.
 */

import { SYNC_KEY_PATTERN, type SyncJson } from "@polaris-key/protocol/sync";
import { hexDecode } from "../../../platform/bytes.js";
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
  StoredFile,
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

const SHA256_RE = /^[0-9a-f]{64}$/;
/** The key id of an SSE-C key (`ensureSsecKey` in `fileOps.ts`). */
const SSEC_KID_RE = /^sk_[A-Za-z0-9_-]{16}$/;
const SUBJECT_RE = /^[A-Za-z0-9_-]{1,256}$/;
const FILE_STATUSES: ReadonlySet<string> = new Set([
  "live",
  "revision",
  "parked",
]);
/** More subjects than this folded into one object is not a person's history. */
const MAX_ABSORBED_FROM = 256;

/**
 * A file row of a merge export. The R2 key is checked against the grammar the Worker writes
 * (`u/<product>/<subject>/o/<uploadId>`, the product being the document's own): the survivor will
 * read and delete by it, so nothing else is accepted. A dead file is never exported, so one in a
 * document is refused with the rest.
 */
function fileOf(v: unknown, product: string): StoredFile | null {
  if (!isObject(v)) return null;
  const stamp = typeof v.clientId === "string" && isClientId(v.clientId);
  if (
    typeof v.collection !== "string" ||
    !KEY_RE.test(v.collection) ||
    typeof v.recordId !== "string" ||
    !KEY_RE.test(v.recordId) ||
    !Number.isSafeInteger(v.version) ||
    (v.version as number) < 1 ||
    typeof v.objectKey !== "string" ||
    !objectKeyOf(product).test(v.objectKey) ||
    (v.format !== "whole" && v.format !== "chunks") ||
    (v.enc !== "e2e" && v.enc !== "none") ||
    !Number.isSafeInteger(v.size) ||
    (v.size as number) < 0 ||
    typeof v.sha256 !== "string" ||
    !SHA256_RE.test(v.sha256) ||
    typeof v.status !== "string" ||
    !FILE_STATUSES.has(v.status) ||
    (v.ssecKid !== undefined &&
      !(typeof v.ssecKid === "string" && SSEC_KID_RE.test(v.ssecKid))) ||
    !Number.isSafeInteger(v.createdAt) ||
    (v.createdAt as number) < 0 ||
    !stamp
  )
    return null;
  return {
    collection: v.collection as string,
    recordId: v.recordId as string,
    version: v.version as number,
    objectKey: v.objectKey,
    format: v.format,
    enc: v.enc,
    size: v.size as number,
    sha256: v.sha256,
    status: v.status as StoredFile["status"],
    ...(v.ssecKid !== undefined ? { ssecKid: v.ssecKid as string } : {}),
    createdAt: v.createdAt as number,
    clientId: v.clientId as string,
  };
}

const objectKeyOf = (product: string): RegExp =>
  new RegExp(
    `^u/${product.replace(/[^a-z0-9-]/g, "")}/[A-Za-z0-9_-]{1,256}/o/up_[A-Za-z0-9_-]{22}$`,
  );

export interface ParsedExport {
  settings: StoredSetting[];
  /** Records, tombstones included; an export from before U-09.8 has none. */
  records: StoredRecord[];
  /** Copies an earlier account merge parked (D3); the survivor carries them on. */
  parked: ParkedRecord[];
  clients: ClientRecord[];
  /** The absorbed store's `encryptionSince`, when it has one. */
  encryptionSince?: number;
  /** The absorbed store's live files, revisions and parked files (U-10); an older export has none. */
  files: StoredFile[];
  /** The SSE-C keys the files reference, by key id. */
  ssecKeys: Map<string, Uint8Array>;
  /** Subjects the absorbed object had already folded in, whose R2 prefixes hold files now the survivor's. */
  absorbedFrom: string[];
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
  const files: StoredFile[] = [];
  if (doc.files !== undefined) {
    if (!Array.isArray(doc.files)) return null;
    const product = typeof doc.product === "string" ? doc.product : "";
    for (const raw of doc.files) {
      const f = fileOf(raw, product);
      if (!f) return null;
      files.push(f);
    }
  }
  const ssecKeys = new Map<string, Uint8Array>();
  if (doc.ssecKeys !== undefined) {
    if (!Array.isArray(doc.ssecKeys)) return null;
    for (const pair of doc.ssecKeys) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const [kid, hex] = pair as [unknown, unknown];
      const key = typeof hex === "string" ? hexDecode(hex) : null;
      if (
        typeof kid !== "string" ||
        !SSEC_KID_RE.test(kid) ||
        !key ||
        key.length !== 32
      )
        return null;
      ssecKeys.set(kid, key);
    }
  }
  // Every key a file names is in the document: a file the survivor could not open is refused.
  for (const f of files) if (f.ssecKid && !ssecKeys.has(f.ssecKid)) return null;
  const absorbedFrom: string[] = [];
  if (doc.absorbedFrom !== undefined) {
    if (
      !Array.isArray(doc.absorbedFrom) ||
      doc.absorbedFrom.length > MAX_ABSORBED_FROM ||
      !doc.absorbedFrom.every(
        (s) => typeof s === "string" && SUBJECT_RE.test(s),
      )
    )
      return null;
    absorbedFrom.push(...(doc.absorbedFrom as string[]));
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
    files,
    ssecKeys,
    absorbedFrom,
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
