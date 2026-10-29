/**
 * The reference `SyncStore`: plain maps, with `transaction` rolling back by restoring a snapshot.
 * Used by the engine's tests and by anything that needs the rules without storage.
 */

import type { SyncScope } from "@polaris-key/protocol/sync";
import { compareRemoved, recordsDump, settingId } from "./store.js";
import type {
  ClientRecord,
  ParkedRecord,
  RemovedField,
  StoredRecord,
  StoredSetting,
  StoreUsage,
  SyncStore,
} from "./types.js";

const cloneRow = (row: StoredSetting): StoredSetting => ({
  ...row,
  stamp: { ...row.stamp },
  value: structuredClone(row.value),
  ...(row.floor ? { floor: { ...row.floor } } : {}),
  ...(row.members
    ? {
        members: new Map(
          [...row.members].map(([k, c]) => [
            k,
            { ...c, value: structuredClone(c.value), stamp: { ...c.stamp } },
          ]),
        ),
      }
    : {}),
});

const cloneRecord = (row: StoredRecord): StoredRecord => ({
  ...row,
  stamp: { ...row.stamp },
  value: structuredClone(row.value),
  ...(row.floor ? { floor: { ...row.floor } } : {}),
  ...(row.fields
    ? {
        fields: new Map(
          [...row.fields].map(([k, c]) => [
            k,
            { ...c, value: structuredClone(c.value), stamp: { ...c.stamp } },
          ]),
        ),
      }
    : {}),
  ...(row.elements
    ? {
        elements: new Map(
          [...row.elements].map(([k, e]) => [
            k,
            { ...e, element: structuredClone(e.element), tags: [...e.tags] },
          ]),
        ),
      }
    : {}),
});

const recordId = (collection: string, id: string): string =>
  `${collection}\u0000${id}`;

const cloneParked = (row: ParkedRecord): ParkedRecord => ({
  ...row,
  stamp: { ...row.stamp },
  value: structuredClone(row.value),
  ...(row.fields ? { fields: structuredClone(row.fields) } : {}),
  ...(row.elements ? { elements: structuredClone(row.elements) } : {}),
});

export class MemoryStore implements SyncStore {
  private seq = 0;
  private clients = new Map<string, ClientRecord>();
  private settings = new Map<string, StoredSetting>();
  private records = new Map<string, StoredRecord>();
  private parked = new Map<string, ParkedRecord>();
  private usage: StoreUsage = {
    settings: 0,
    settingsBytes: 0,
    records: 0,
    recordBytes: 0,
    bytes: 0,
  };
  private watermark = 0;
  private since: number | undefined;
  private held = false;
  private seen = new Map<string, number>();

  constructor(private readonly clock: () => number = () => Date.now() / 1000) {}

  transaction<T>(fn: () => T): T {
    const seq = this.seq;
    const usage = { ...this.usage };
    const watermark = this.watermark;
    const since = this.since;
    const held = this.held;
    const seen = new Map(this.seen);
    const clients = new Map(
      [...this.clients].map(([k, v]) => [k, { ...v }] as const),
    );
    const settings = new Map(
      [...this.settings].map(([k, v]) => [k, cloneRow(v)] as const),
    );
    const records = new Map(
      [...this.records].map(([k, v]) => [k, cloneRecord(v)] as const),
    );
    const parked = new Map(
      [...this.parked].map(([k, v]) => [k, cloneParked(v)] as const),
    );
    try {
      return fn();
    } catch (e) {
      this.seq = seq;
      this.usage = usage;
      this.watermark = watermark;
      this.since = since;
      this.held = held;
      this.seen = seen;
      this.clients = clients;
      this.settings = settings;
      this.records = records;
      this.parked = parked;
      throw e;
    }
  }

  currentSeq(): number {
    return this.seq;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  getClient(clientId: string): ClientRecord | undefined {
    const c = this.clients.get(clientId);
    return c ? { ...c } : undefined;
  }

  putClient(record: ClientRecord): void {
    this.clients.set(record.clientId, { ...record });
    this.seen.set(record.clientId, this.clock());
  }

  clientCount(): number {
    return this.clients.size;
  }

  dropIdleClient(cutoffSeconds: number): boolean {
    let oldest: [string, number] | undefined;
    for (const id of this.clients) {
      const at = this.seen.get(id[0]) ?? 0;
      if (!oldest || at < oldest[1]) oldest = [id[0], at];
    }
    if (!oldest || oldest[1] > cutoffSeconds) return false;
    this.clients.delete(oldest[0]);
    this.seen.delete(oldest[0]);
    return true;
  }

  getSetting(
    key: string,
    scope: SyncScope,
    family?: string,
  ): StoredSetting | undefined {
    const row = this.settings.get(settingId(key, scope, family));
    return row ? cloneRow(row) : undefined;
  }

  putSetting(row: StoredSetting): void {
    if (!row.deleted) this.held = true;
    this.settings.set(settingId(row.key, row.scope, row.family), cloneRow(row));
  }

  deleteSetting(key: string, scope: SyncScope, family?: string): void {
    this.settings.delete(settingId(key, scope, family));
  }

  settingsAfter(seq: number): StoredSetting[] {
    return [...this.settings.values()]
      .filter((r) => r.version > seq)
      .sort((a, b) => a.version - b.version)
      .map(cloneRow);
  }

  settingsPageAfter(
    seq: number,
    family: string,
    limit: number,
  ): StoredSetting[] {
    return this.settingsAfter(seq)
      .filter((r) => r.scope === "user" || r.family === family)
      .slice(0, limit);
  }

  settingsPageThrough(
    after: number,
    through: number,
    limit: number,
  ): StoredSetting[] {
    return this.settingsAfter(after)
      .filter((r) => r.version <= through)
      .slice(0, limit);
  }

  getRecord(collection: string, id: string): StoredRecord | undefined {
    const row = this.records.get(recordId(collection, id));
    return row ? cloneRecord(row) : undefined;
  }

  putRecord(row: StoredRecord): void {
    if (!row.deleted) this.held = true;
    this.records.set(recordId(row.collection, row.id), cloneRecord(row));
  }

  deleteRecordRow(collection: string, id: string): void {
    this.records.delete(recordId(collection, id));
  }

  private recordsAfter(seq: number): StoredRecord[] {
    return [...this.records.values()]
      .filter((r) => r.version > seq)
      .sort((a, b) => a.version - b.version);
  }

  recordsPageAfter(seq: number, limit: number): StoredRecord[] {
    return this.recordsAfter(seq).slice(0, limit).map(cloneRecord);
  }

  recordsPageThrough(
    after: number,
    through: number,
    limit: number,
  ): StoredRecord[] {
    return this.recordsAfter(after)
      .filter((r) => r.version <= through)
      .slice(0, limit)
      .map(cloneRecord);
  }

  liveRecordCount(collection: string): number {
    let n = 0;
    for (const r of this.records.values())
      if (r.collection === collection && !r.deleted) n++;
    return n;
  }

  private tombstones(collection?: string): StoredRecord[] {
    return [...this.records.values()].filter(
      (r) =>
        r.deleted && (collection === undefined || r.collection === collection),
    );
  }

  recordTombstoneCount(collection?: string): number {
    return this.tombstones(collection).length;
  }

  oldestRecordTombstones(limit: number, collection?: string): StoredRecord[] {
    return this.tombstones(collection)
      .sort(
        (a, b) =>
          (a.stamp.hlc < b.stamp.hlc
            ? -1
            : a.stamp.hlc > b.stamp.hlc
              ? 1
              : 0) ||
          (a.stamp.clientId < b.stamp.clientId
            ? -1
            : a.stamp.clientId > b.stamp.clientId
              ? 1
              : 0) ||
          a.version - b.version,
      )
      .slice(0, limit)
      .map(cloneRecord);
  }

  private removedCells(collection?: string): RemovedField[] {
    const out: RemovedField[] = [];
    for (const r of this.records.values()) {
      if (collection !== undefined && r.collection !== collection) continue;
      for (const [field, cell] of r.fields ?? [])
        if (cell.removed)
          out.push({
            collection: r.collection,
            id: r.id,
            field,
            stamp: { ...cell.stamp },
          });
    }
    return out;
  }

  removedFieldCount(collection?: string): number {
    return this.removedCells(collection).length;
  }

  oldestRemovedFields(limit: number, collection?: string): RemovedField[] {
    return this.removedCells(collection).sort(compareRemoved).slice(0, limit);
  }

  getParkedRecord(
    collection: string,
    id: string,
    fromSubject: string,
  ): ParkedRecord | undefined {
    const row = this.parked.get(
      `${recordId(collection, id)}\u0000${fromSubject}`,
    );
    return row ? cloneParked(row) : undefined;
  }

  putParkedRecord(row: ParkedRecord): void {
    this.held = true;
    this.parked.set(
      `${recordId(row.collection, row.id)}\u0000${row.fromSubject}`,
      cloneParked(row),
    );
  }

  parkedRecords(): ParkedRecord[] {
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...this.parked.values()]
      .sort(
        (a, b) =>
          a.parkedAt - b.parkedAt ||
          cmp(a.collection, b.collection) ||
          cmp(a.id, b.id) ||
          cmp(a.fromSubject, b.fromSubject),
      )
      .map(cloneParked);
  }

  parkedCount(): number {
    return this.parked.size;
  }

  oldestParked(limit: number): ParkedRecord[] {
    return this.parkedRecords().slice(0, limit);
  }

  deleteParkedRecord(
    collection: string,
    id: string,
    fromSubject: string,
  ): void {
    this.parked.delete(`${recordId(collection, id)}\u0000${fromSubject}`);
  }

  isEmpty(): boolean {
    return (
      this.settings.size === 0 &&
      this.records.size === 0 &&
      this.parked.size === 0
    );
  }

  heldData(): boolean {
    return this.held;
  }

  getUsage(): StoreUsage {
    return { ...this.usage };
  }

  setUsage(usage: StoreUsage): void {
    this.usage = { ...usage };
  }

  getWatermark(): number {
    return this.watermark;
  }

  setWatermark(seq: number): void {
    this.watermark = seq;
  }

  getEncryptionSince(): number | undefined {
    return this.since;
  }

  setEncryptionSince(seq: number): void {
    this.since = seq;
  }

  /** Sets the sequence (a test seeding a store from a pull's cursor). */
  setSeq(seq: number): void {
    this.seq = seq;
  }

  /** Every stored row, for tests. */
  rows(): StoredSetting[] {
    return [...this.settings.values()].map(cloneRow);
  }

  /** Every stored record, for tests. */
  recordRows(): StoredRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }

  /** A comparable dump of the whole store, for the idempotence test. */
  snapshot(): unknown {
    return {
      seq: this.seq,
      usage: this.usage,
      watermark: this.watermark,
      clients: [...this.clients].sort(),
      settings: [...this.settings]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, r]) => [
          k,
          { ...r, members: r.members ? [...r.members] : undefined },
        ]),
      ...(this.records.size > 0
        ? { records: recordsDump([...this.records.values()]) }
        : {}),
      ...(this.parked.size > 0
        ? { parked: [...this.parked].sort(([a], [b]) => (a < b ? -1 : 1)) }
        : {}),
    };
  }
}
