// U-37.1: the chunk methods of `SyncStore` (schema v5), proved on both stores: the reference
// `MemoryStore` and the Durable Object's `SqlStore`. Rows only: the rules are `engine/chunks.ts`'s.
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import type { SyncStore } from "../../../src/services/sync/engine/types.js";
import { SqlTestStore } from "../../cloudSyncSqlTestStore.js";
import { chunkRow, chunksUpload, idOf } from "./cloudSyncChunksWorld.js";

const ID = idOf;
const chunk = chunkRow;
const upload = chunksUpload;

const makers: Record<string, () => SyncStore> = {
  memory: () => new MemoryStore(),
  sql: () => new SqlTestStore(),
};

describe.each(Object.entries(makers))("chunk methods: %s store", (_n, make) => {
  it("round-trips a chunk row per collection; the same id in two collections is two rows", () => {
    const s = make();
    s.putChunk(chunk("saves", 1, { refs: 2, ssecKid: "k1", unrefAt: 9 }));
    s.putChunk(chunk("other", 1));
    expect(s.getChunk("saves", ID(1))).toEqual(
      chunk("saves", 1, { refs: 2, ssecKid: "k1", unrefAt: 9 }),
    );
    expect(s.getChunk("other", ID(1))?.refs).toBe(0);
    expect(s.getChunk("saves", ID(2))).toBeUndefined();
    s.putChunk({ ...chunk("saves", 1), refs: 5 });
    expect(s.allChunks().map((c) => [c.collection, c.refs])).toEqual([
      ["other", 0],
      ["saves", 5],
    ]);
    s.deleteChunk("saves", ID(1));
    expect(s.getChunk("saves", ID(1))).toBeUndefined();
    expect(s.getChunk("other", ID(1))).toBeDefined();
  });

  it("lists unreferenced chunks oldest first and honours the limit", () => {
    const s = make();
    s.putChunk(chunk("saves", 1, { refs: 1 }));
    s.putChunk(chunk("saves", 2, { unrefAt: 30 }));
    s.putChunk(chunk("saves", 3, { unrefAt: 10 }));
    s.putChunk(chunk("saves", 4, { unrefAt: 20 }));
    expect(s.collectableChunks(10).map((c) => c.chunkId)).toEqual([
      ID(3),
      ID(4),
      ID(2),
    ]);
    expect(s.collectableChunks(2)).toHaveLength(2);
  });

  it("keeps the chunk ids of a file version apart from its neighbours", () => {
    const s = make();
    s.putFileChunks("saves", "a", 1, [ID(2), ID(1)]);
    s.putFileChunks("saves", "a", 2, [ID(1), ID(3)]);
    s.putFileChunks("saves", "b", 1, [ID(9)]);
    s.putFileChunks("saves", "a", 1, [ID(1)]);
    expect(s.fileChunkIds("saves", "a", 1)).toEqual([ID(1), ID(2)]);
    expect(s.fileChunkIds("saves", "a", 2)).toEqual([ID(1), ID(3)]);
    expect(s.allFileChunks()).toHaveLength(5);
    s.deleteFileChunks("saves", "a", 1);
    expect(s.fileChunkIds("saves", "a", 1)).toEqual([]);
    expect(s.fileChunkIds("saves", "a", 2)).toEqual([ID(1), ID(3)]);
    expect(s.fileChunkIds("saves", "b", 1)).toEqual([ID(9)]);
  });

  it("pins a chunk only inside the collection of the upload that named it, until it lets go", () => {
    const s = make();
    s.putUpload(upload("up_a", "saves"));
    s.putUploadChunk({
      uploadId: "up_a",
      chunkId: ID(1),
      storedBytes: 101,
      have: false,
      reserved: 101,
    });
    expect(s.chunkPinned("saves", ID(1))).toBe(true);
    expect(s.chunkPinned("other", ID(1))).toBe(false);
    expect(s.chunkPinned("saves", ID(2))).toBe(false);
    expect(s.getUploadChunk("up_a", ID(1))?.have).toBe(false);
    s.putUploadChunk({ ...s.getUploadChunk("up_a", ID(1))!, have: true });
    expect(s.uploadChunks("up_a").map((c) => [c.chunkId, c.have])).toEqual([
      [ID(1), true],
    ]);
    s.deleteUploadChunks("up_a");
    expect(s.chunkPinned("saves", ID(1))).toBe(false);
  });

  it("deleting an upload lets go of its chunks", () => {
    const s = make();
    s.putUpload(upload("up_a"));
    s.putUploadChunk({
      uploadId: "up_a",
      chunkId: ID(1),
      storedBytes: 101,
      have: true,
      reserved: 0,
    });
    s.deleteUpload("up_a");
    expect(s.uploadChunks("up_a")).toEqual([]);
    expect(s.chunkPinned("saves", ID(1))).toBe(false);
  });

  it("a rolled-back transaction restores every chunk table", () => {
    const s = make();
    s.putChunk(chunk("saves", 1, { refs: 1 }));
    s.putFileChunks("saves", "a", 1, [ID(1)]);
    expect(() =>
      s.transaction(() => {
        s.putChunk(chunk("saves", 2));
        s.putChunk({ ...chunk("saves", 1), refs: 9 });
        s.deleteFileChunks("saves", "a", 1);
        s.putUploadChunk({
          uploadId: "up_x",
          chunkId: ID(2),
          storedBytes: 1,
          have: false,
          reserved: 1,
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.getChunk("saves", ID(2))).toBeUndefined();
    expect(s.getChunk("saves", ID(1))?.refs).toBe(1);
    expect(s.fileChunkIds("saves", "a", 1)).toEqual([ID(1)]);
    expect(s.uploadChunks("up_x")).toEqual([]);
  });
});
