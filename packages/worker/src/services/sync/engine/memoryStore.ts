/**
 * The reference `SyncStore`: plain maps, with `transaction` rolling back by restoring a snapshot.
 * Used by the engine's tests and by anything that needs the rules without storage.
 */

import type { SyncScope } from "@polaris-key/protocol/sync";
import { settingId } from "./store.js";
import type { ClientRecord, StoredSetting, SyncStore } from "./types.js";

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

export class MemoryStore implements SyncStore {
  private seq = 0;
  private clients = new Map<string, ClientRecord>();
  private settings = new Map<string, StoredSetting>();

  transaction<T>(fn: () => T): T {
    const seq = this.seq;
    const clients = new Map(
      [...this.clients].map(([k, v]) => [k, { ...v }] as const),
    );
    const settings = new Map(
      [...this.settings].map(([k, v]) => [k, cloneRow(v)] as const),
    );
    try {
      return fn();
    } catch (e) {
      this.seq = seq;
      this.clients = clients;
      this.settings = settings;
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
  }

  getSetting(key: string, scope: SyncScope): StoredSetting | undefined {
    const row = this.settings.get(settingId(key, scope));
    return row ? cloneRow(row) : undefined;
  }

  putSetting(row: StoredSetting): void {
    this.settings.set(settingId(row.key, row.scope), cloneRow(row));
  }

  /** Sets the sequence (a test seeding a store from a pull's cursor). */
  setSeq(seq: number): void {
    this.seq = seq;
  }

  /** Every stored row, for tests. */
  rows(): StoredSetting[] {
    return [...this.settings.values()].map(cloneRow);
  }

  /** A comparable dump of the whole store, for the idempotence test. */
  snapshot(): unknown {
    return {
      seq: this.seq,
      clients: [...this.clients].sort(),
      settings: [...this.settings]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, r]) => [
          k,
          { ...r, members: r.members ? [...r.members] : undefined },
        ]),
    };
  }
}
