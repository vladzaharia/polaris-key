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
import type { StoredSetting, StoreUsage, SyncStore } from "./types.js";

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
