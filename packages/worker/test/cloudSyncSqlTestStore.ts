import { settingId } from "../src/services/sync/engine/store.js";
import type {
  StoredRecord,
  StoredSetting,
} from "../src/services/sync/engine/types.js";
import { SqlStore } from "../src/services/sync/do/sqlStore.js";
import { freshSqlStore } from "./cloudSyncDoMock.js";

/**
 * The SQL store with the reference store's test helpers (`rows`, `snapshot`, `setSeq`), standing in
 * for `MemoryStore` in the parity suites (`cloudSyncSqlParity*.test.ts` mock the memory store's
 * module with this class and replay the engine suites unchanged).
 */
export class SqlTestStore extends SqlStore {
  constructor(clock?: () => number) {
    const { storage } = freshSqlStore();
    super(
      storage as unknown as ConstructorParameters<typeof SqlStore>[0],
      clock,
    );
    this.prepare(true);
  }

  setSeq(seq: number): void {
    this.setMeta("seq", String(seq));
  }

  rows(): StoredSetting[] {
    return this.settingsAfter(0);
  }

  recordRows(): StoredRecord[] {
    return this.recordsPageAfter(0, Number.MAX_SAFE_INTEGER);
  }

  snapshot(): unknown {
    const records = this.recordRows();
    return {
      seq: this.currentSeq(),
      usage: this.getUsage(),
      watermark: this.getWatermark(),
      clients: this.clients(),
      settings: this.rows()
        .map((r) => [settingId(r.key, r.scope, r.family), r] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, r]) => [
          k,
          { ...r, members: r.members ? [...r.members] : undefined },
        ]),
      ...(records.length > 0
        ? {
            records: records
              .map((r) => [`${r.collection}\u0000${r.id}`, r] as const)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, r]) => [
                k,
                {
                  ...r,
                  fields: r.fields ? [...r.fields] : undefined,
                  elements: r.elements ? [...r.elements] : undefined,
                },
              ]),
          }
        : {}),
    };
  }
}
