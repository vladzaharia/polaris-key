// U-05.6: the engine suite `cloudSyncBudget` replayed over the SQLite store (the Durable Object's),
// unchanged: the memory store's module is swapped for the SQL one, so one set of rules is proved
// against both stores.
import { vi } from "vitest";

vi.mock("../../../src/services/sync/engine/memoryStore.js", async () => ({
  MemoryStore: (await import("../../cloudSyncSqlTestStore.js")).SqlTestStore,
}));

await import("./cloudSyncBudget.test.js");
