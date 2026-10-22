/**
 * The reference `SyncStore`: plain maps, with `transaction` rolling back by restoring a snapshot.
 * Used by the engine's tests and by anything that needs the rules without storage.
 */

import type { SyncScope } from "@polaris-key/protocol/sync";
import { settingId } from "./store.js";
import type {
  ClientRecord,
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

export class MemoryStore implements SyncStore {
  private seq = 0;
  private clients = new Map<string, ClientRecord>();
  private settings = new Map<string, StoredSetting>();
  private usage: StoreUsage = { settings: 0, settingsBytes: 0, bytes: 0 };
  private watermark = 0;

  transaction<T>(fn: () => T): T {
    const seq = this.seq;
    const usage = { ...this.usage };
    const watermark = this.watermark;
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
      this.usage = usage;
      this.watermark = watermark;
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

  getSetting(
    key: string,
    scope: SyncScope,
    family?: string,
  ): StoredSetting | undefined {
    const row = this.settings.get(settingId(key, scope, family));
    return row ? cloneRow(row) : undefined;
  }

  putSetting(row: StoredSetting): void {
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

  isEmpty(): boolean {
    return this.settings.size === 0;
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
      usage: this.usage,
      watermark: this.watermark,
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
