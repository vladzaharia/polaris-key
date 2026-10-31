// U-09.R: the review-fix suite `cloudSyncRecordsFixes` replayed over the SQLite store (the Durable
// Object's), unchanged: the memory store's module is swapped for the SQL one.
import { vi } from "vitest";

vi.mock("../../../src/services/sync/engine/memoryStore.js", async () => ({
  MemoryStore: (await import("../../cloudSyncSqlTestStore.js")).SqlTestStore,
}));

await import("./cloudSyncRecordsFixes.test.js");
