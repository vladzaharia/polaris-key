// U-09.8: the records absorb suite `cloudSyncRecordsAbsorb` replayed over the SQLite store (the
// Durable Object's), unchanged: the memory store's module is swapped for the SQL one.
import { vi } from "vitest";

vi.mock("../../../src/services/sync/engine/memoryStore.js", async () => ({
  MemoryStore: (await import("../../cloudSyncSqlTestStore.js")).SqlTestStore,
}));

await import("./cloudSyncRecordsAbsorb.test.js");
