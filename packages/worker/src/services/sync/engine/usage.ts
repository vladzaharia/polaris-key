/**
 * Byte accounting (§13.1 budgets; U-05.5). One definition, shared with the client: a setting costs
 * the UTF-8 length of its key plus its value's canonical JSON (object members in byte order, no
 * whitespace). A merged setting's value is its live members as an object, so a member's size goes
 * against the budget. A tombstone costs nothing.
 *
 * The store keeps the running totals (`StoreUsage`); `account` moves them by one row's change, and
 * never below zero, because a script or a repair may seed totals the rows do not add up to.
 */

import type { SyncJson } from "@polaris-key/protocol/sync";
import { budgetBytes } from "./sealed.js";
import { liveMembers } from "./store.js";
import type {
  ParkedRecord,
  StoredRecord,
  StoredSetting,
  StoreUsage,
  SyncStore,
} from "./types.js";

const byteOrder = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

const isObject = (v: SyncJson): v is { [k: string]: SyncJson } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Canonical JSON: object members in byte order, no whitespace. */
export function canonicalJson(v: SyncJson): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort(byteOrder)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k] as SyncJson)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

const encoder = new TextEncoder();
export const utf8Length = (s: string): number => encoder.encode(s).length;

/** The UTF-8 length of a value's canonical JSON. */
export const valueBytes = (v: SyncJson): number => utf8Length(canonicalJson(v));

export interface RowCost {
  /** 1 for a live setting, else 0. */
  settings: number;
  /** The stored bytes: what the quota charges. */
  bytes: number;
  /**
   * What the budgets (256 keys, 64 KiB) charge. Equal to `bytes` for a plaintext row; a sealed
   * value is charged on `envelopeBytes - 113` (§13.10.4), so the budgets keep their meaning.
   */
  budget: number;
}

const FREE: RowCost = { settings: 0, bytes: 0, budget: 0 };

/** The budget charge of a sealed row: the key, and each value less the envelope's overhead. */
function sealedBudget(row: StoredSetting): number {
  const key = utf8Length(row.key);
  if (!row.members)
    return key + (typeof row.value === "string" ? budgetBytes(row.value) : 0);
  let total = key;
  for (const [name, cell] of row.members)
    if (!cell.removed)
      total +=
        utf8Length(name) +
        (typeof cell.value === "string" ? budgetBytes(cell.value) : 0);
  return total;
}

/** What a row costs: nothing for a tombstone or no row. */
export function rowCost(row: StoredSetting | undefined): RowCost {
  if (!row || row.deleted) return FREE;
  const value = row.members ? liveMembers(row) : row.value;
  if (value === null && row.members) return FREE;
  const bytes = utf8Length(row.key) + valueBytes(value);
  return {
    settings: 1,
    bytes,
    budget: row.sealed ? sealedBudget(row) : bytes,
  };
}

/** Moves the store's totals by the change from `prev` to `next`. */
export function account(
  store: SyncStore,
  prev: StoredSetting | undefined,
  next: StoredSetting,
): void {
  const before = rowCost(prev);
  const after = rowCost(next);
  const u = store.getUsage();
  const move = (n: number, d: number) => Math.max(0, n + d);
  const out: StoreUsage = {
    ...u,
    settings: move(u.settings, after.settings - before.settings),
    settingsBytes: move(u.settingsBytes, after.budget - before.budget),
    bytes: move(u.bytes, after.bytes - before.bytes),
  };
  store.setUsage(out);
}

export interface RecordCost {
  /** 1 for a live record, else 0. */
  records: number;
  /** The stored bytes: what the quota charges. */
  bytes: number;
}

/** What each live field or element of a record adds to its charge, in either mode (§13.3 Budget). */
export const ENTRY_CHARGE = 45;

/** What each tag of an element beyond its first adds: every tag is a stored row. */
export const EXTRA_TAG_CHARGE = 8;

/**
 * What a record costs: the collection and id (a `prefix.*` collection's suffix is person-chosen,
 * so it is charged too) plus its content as stored: the value's canonical JSON (the quoted `ct` in
 * E2E mode), each live field's name and value, each element's value, 45 for every live field or
 * element however small (an E2E entry's 45-character blinded name is that charge), and 8 for each
 * tag of an element beyond its first. A tombstone or no row costs nothing.
 */
export function recordCost(row: StoredRecord | undefined): RecordCost {
  if (!row || row.deleted) return { records: 0, bytes: 0 };
  let bytes = utf8Length(row.collection) + utf8Length(row.id);
  if (row.kind === "fields") {
    for (const [name, cell] of row.fields ?? [])
      if (!cell.removed)
        bytes +=
          utf8Length(name) +
          valueBytes(cell.value) +
          (cell.kid !== undefined ? 0 : ENTRY_CHARGE);
  } else if (row.kind === "set") {
    for (const el of row.elements?.values() ?? [])
      if (el.tags.length > 0)
        bytes +=
          valueBytes(el.element) +
          ENTRY_CHARGE +
          EXTRA_TAG_CHARGE * (el.tags.length - 1);
  } else bytes += valueBytes(row.value);
  return { records: 1, bytes };
}

/** What a parked copy costs: its content as a live record of its shape would. */
export const parkedCost = (p: ParkedRecord | undefined): number =>
  p ? recordCost({ ...p, version: 0, deleted: false }).bytes : 0;

/** Moves the store's quota total by the change from the parked copy `prev` to `next`. */
export function accountParked(
  store: SyncStore,
  prev: ParkedRecord | undefined,
  next: ParkedRecord | undefined,
): void {
  const u = store.getUsage();
  store.setUsage({
    ...u,
    bytes: Math.max(0, u.bytes + parkedCost(next) - parkedCost(prev)),
  });
}

/** Moves the store's totals by the change from `prev` to `next` (a record). */
export function accountRecord(
  store: SyncStore,
  prev: StoredRecord | undefined,
  next: StoredRecord,
): void {
  const before = recordCost(prev);
  const after = recordCost(next);
  const u = store.getUsage();
  const move = (n: number, d: number) => Math.max(0, n + d);
  store.setUsage({
    ...u,
    records: move(u.records, after.records - before.records),
    recordBytes: move(u.recordBytes, after.bytes - before.bytes),
    bytes: move(u.bytes, after.bytes - before.bytes),
  });
}
