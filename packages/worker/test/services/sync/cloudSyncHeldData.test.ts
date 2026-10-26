/**
 * The users ceiling asks whether an object ever held a live setting. An object written before the
 * flag existed has none, so any live row must count.
 */
import { describe, expect, it } from "vitest";
import { SqlStore } from "../../../src/services/sync/do/sqlStore.js";
import { freshSqlStore } from "../../cloudSyncDoMock.js";

const row = (deleted: boolean) => ({
  key: "a.b",
  scope: "user" as const,
  value: 1,
  deleted,
  version: 1,
  stamp: { hlc: "0000000000001:0000", clientId: "c_aaaaaaaaaaaaaaaaaaaaaa" },
});

function make() {
  const { storage } = freshSqlStore();
  const store = new SqlStore(
    storage as unknown as ConstructorParameters<typeof SqlStore>[0],
  );
  store.prepare(true);
  return { store, storage };
}

describe("heldData", () => {
  it("is false for an empty object and for tombstones alone", () => {
    const { store } = make();
    expect(store.heldData()).toBe(false);
    store.putSetting(row(true) as never);
    expect(store.heldData()).toBe(false);
  });

  it("is set by the first live row, and for an object written before the flag", () => {
    const { store, storage } = make();
    store.putSetting(row(false) as never);
    expect(store.heldData()).toBe(true);
    (
      storage as unknown as {
        sql: { db: { prepare(q: string): { run(): void } } };
      }
    ).sql.db
      .prepare("DELETE FROM meta WHERE key = 'held_data'")
      .run();
    expect(store.heldData()).toBe(true);
  });
});
