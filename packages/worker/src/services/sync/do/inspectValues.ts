/**
 * The console's values read (U-11a.2), the object's half: the settings' values, or one page of a
 * collection's live records with their values and file pointers, in id order. The Worker asks only
 * for a server-mode product after a step-up; this module still answers no value for a row written
 * under a key (`version` at or above `encryptionSince`), so a product that switched mode never
 * shows ciphertext as if it were a value. Reads only: nothing is created or changed.
 */
import { parseHlc } from "../engine/hlc.js";
import { livePointer } from "../engine/fileRows.js";
import { liveRecordValue } from "../engine/recordSets.js";
import { liveMembers } from "../engine/store.js";
import { rowCost } from "../engine/usage.js";
import type { SqlStore } from "./sqlStore.js";
import type {
  CloudSyncOp,
  InspectedRecord,
  InspectedSettingValue,
} from "./protocol.js";

const enc = new TextEncoder();

export function inspectValues(
  store: SqlStore,
  op: Extract<CloudSyncOp, { op: "inspectValues" }>,
): {
  settings: InspectedSettingValue[] | null;
  records: InspectedRecord[];
  next: string | null;
} {
  const since = store.getEncryptionSince();
  const sealedAt = (version: number): boolean =>
    since !== undefined && version >= since;

  if (op.collection === undefined) {
    const settings = store
      .settingsAfter(0)
      .filter((r) => !r.deleted)
      .map((r): InspectedSettingValue => {
        const sealed = sealedAt(r.version);
        return {
          key: r.key,
          scope: r.scope,
          ...(r.family !== undefined ? { family: r.family } : {}),
          bytes: rowCost(r).bytes,
          updatedAt: parseHlc(r.stamp.hlc)?.ms ?? 0,
          value: sealed ? null : r.members ? liveMembers(r) : r.value,
          sealed,
        };
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { settings, records: [], next: null };
  }

  const ids = store.liveRecordIds(op.collection, op.after ?? "", op.limit + 1);
  const page = ids.slice(0, op.limit);
  const records: InspectedRecord[] = [];
  for (const id of page) {
    const r = store.getRecord(op.collection, id);
    if (!r || r.deleted) continue;
    const sealed = sealedAt(r.version);
    const value = sealed ? null : liveRecordValue(r);
    const file = livePointer(store, op.collection, id);
    records.push({
      id,
      version: r.version,
      updatedAt: parseHlc(r.stamp.hlc)?.ms ?? 0,
      bytes:
        enc.encode(id).length +
        (value === null ? 0 : enc.encode(JSON.stringify(value)).length),
      value,
      sealed,
      ...(file ? { file } : {}),
    });
  }
  return {
    settings: null,
    records,
    next: ids.length > op.limit ? (page[page.length - 1] ?? null) : null,
  };
}
