// U-37.4: the engine's chunk rules (`engine/chunks.ts`, `engine/fileRows.ts`), proved on both
// stores: references and the one-time charge, and a reference never lost while a file names the chunk.
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import {
  planChunks,
  refFileChunks,
  unrefFileChunks,
} from "../../../src/services/sync/engine/chunks.js";
import {
  dropRecordFiles,
  killFile,
  moveFileUsage,
  pruneRevisions,
} from "../../../src/services/sync/engine/fileRows.js";
import type {
  StoredChunk,
  StoredFile,
  SyncStore,
  UploadRow,
} from "../../../src/services/sync/engine/types.js";
import { fileUsage } from "../../../src/services/sync/engine/usage.js";
import { SqlTestStore } from "../../cloudSyncSqlTestStore.js";

const ID = (n: number): string => n.toString(16).padStart(64, "0");

const makers: Record<string, () => SyncStore> = {
  memory: () => new MemoryStore(),
  sql: () => new SqlTestStore(),
};

const chunk = (n: number, storedBytes = 1000): StoredChunk => ({
  collection: "saves",
  chunkId: ID(n),
  objectKey: `u/p/s/c/saves/${ID(n)}`,
  storedBytes,
  refs: 0,
  unrefAt: 0,
});

const file = (
  recordId: string,
  version: number,
  status: StoredFile["status"] = "live",
): StoredFile => ({
  collection: "saves",
  recordId,
  version,
  objectKey: `u/p/s/o/up_${version}`,
  format: "chunks",
  enc: "none",
  size: 100,
  sha256: "ab".repeat(32),
  status,
  createdAt: 1,
  clientId: "c_aaaaaaaaaaaaaaaaaaaaaa",
});

const bytes = (s: SyncStore) => s.getUsage().bytes;
const fileBytes = (s: SyncStore) => fileUsage(s.getUsage()).fileBytes;

/** A store that holds a live file per (record, version), each naming `ids`. */
function seeded(s: SyncStore, files: [string, number, number[]][]) {
  for (const n of [1, 2, 3]) s.putChunk(chunk(n, 1000 * n));
  for (const [rec, v, ids] of files) {
    s.putFile(file(rec, v));
    moveFileUsage(s, { files: 1, fileBytes: 100 });
    refFileChunks(
      s,
      { collection: "saves", recordId: rec, version: v },
      ids.map(ID),
    );
  }
}

describe.each(Object.entries(makers))(
  "chunk references: %s store",
  (_n, make) => {
    it("charges a chunk when its first file references it, never twice", () => {
      const s = make();
      seeded(s, [["a", 1, [1, 2]]]);
      expect(bytes(s)).toBe(100 + 1000 + 2000);
      refFileChunks(s, { collection: "saves", recordId: "b", version: 2 }, [
        ID(2),
        ID(3),
      ]);
      // Chunk 2 was charged already; chunk 3 is new.
      expect(bytes(s)).toBe(100 + 1000 + 2000 + 3000);
      expect(fileBytes(s)).toBe(bytes(s));
      expect(s.getChunk("saves", ID(2))?.refs).toBe(2);
    });

    it("names a chunk once per file however often the list repeats it", () => {
      const s = make();
      seeded(s, []);
      refFileChunks(s, { collection: "saves", recordId: "a", version: 1 }, [
        ID(1),
        ID(1),
        ID(1),
      ]);
      expect(s.getChunk("saves", ID(1))?.refs).toBe(1);
      expect(s.fileChunkIds("saves", "a", 1)).toEqual([ID(1)]);
    });

    it("a reference is never lost while another file names the chunk: killing one file keeps the bytes", () => {
      const s = make();
      seeded(s, [
        ["a", 1, [1, 2]],
        ["b", 2, [2, 3]],
      ]);
      const all = bytes(s);
      killFile(s, s.getFile("saves", "a", 1) as StoredFile);
      // Chunk 1 had only A; chunk 2 is still named by B.
      expect(s.getChunk("saves", ID(1))?.refs).toBe(0);
      expect(s.getChunk("saves", ID(2))?.refs).toBe(1);
      expect(bytes(s)).toBe(all - 1000 - 100);
      expect(s.fileChunkIds("saves", "a", 1)).toEqual([]);
      killFile(s, s.getFile("saves", "b", 2) as StoredFile);
      expect(s.getChunk("saves", ID(2))?.refs).toBe(0);
      expect(s.getChunk("saves", ID(3))?.refs).toBe(0);
      expect(fileBytes(s)).toBe(0);
    });

    it("releasing twice, or releasing a file that named nothing, never takes a count below zero", () => {
      const s = make();
      seeded(s, [["a", 1, [1]]]);
      const f = { collection: "saves", recordId: "a", version: 1 };
      expect(unrefFileChunks(s, f)).toBe(1);
      expect(unrefFileChunks(s, f)).toBe(0);
      expect(unrefFileChunks(s, { ...f, version: 99 })).toBe(0);
      expect(s.getChunk("saves", ID(1))?.refs).toBe(0);
      expect(bytes(s)).toBe(100);
    });

    it("a record delete and a revision prune release the chunks of the files they retire", () => {
      const s = make();
      seeded(s, [["a", 1, [1]]]);
      s.putFile(file("a", 2, "revision"));
      refFileChunks(s, { collection: "saves", recordId: "a", version: 2 }, [
        ID(1),
        ID(2),
      ]);
      expect(s.getChunk("saves", ID(1))?.refs).toBe(2);
      expect(pruneRevisions(s, "saves", "a", 0)).toBe(1);
      expect(s.getChunk("saves", ID(1))?.refs).toBe(1);
      expect(s.getChunk("saves", ID(2))?.refs).toBe(0);
      expect(dropRecordFiles(s, "saves", "a")).toBe(1);
      expect(s.getChunk("saves", ID(1))?.refs).toBe(0);
      expect(bytes(s)).toBe(0);
    });

    it("a chunk that loses its last reference and gets one again is charged again", () => {
      const s = make();
      seeded(s, [["a", 1, [1]]]);
      unrefFileChunks(
        s,
        { collection: "saves", recordId: "a", version: 1 },
        50,
      );
      expect(s.getChunk("saves", ID(1))).toMatchObject({
        refs: 0,
        unrefAt: 50,
      });
      refFileChunks(s, { collection: "saves", recordId: "c", version: 3 }, [
        ID(1),
      ]);
      expect(bytes(s)).toBe(100 + 1000);
      expect(s.getChunk("saves", ID(1))?.unrefAt).toBe(0);
    });
  },
);

const upload = (): UploadRow => ({
  uploadId: "up_a",
  collection: "saves",
  recordId: "slot",
  baseVersion: null,
  mode: "chunks",
  format: "chunks",
  enc: "none",
  size: 200,
  sha256: "ab".repeat(32),
  partBytes: null,
  multipartId: null,
  reservedBytes: 200,
  deviceId: "d_1",
  createdAt: 1_000,
  expiresAt: 5_000,
  state: "open",
  resultJson: null,
});

describe.each(Object.entries(makers))("the plan: %s store", (_n, make) => {
  it("reserves what no file references and pins every named chunk", () => {
    const s = make();
    s.putUpload(upload());
    s.putChunk({ ...chunk(1, 500), refs: 1 });
    s.putChunk(chunk(2, 700));
    const out = planChunks(s, {
      upload: upload(),
      chunks: [
        [ID(1), 500],
        [ID(2), 700],
        [ID(3), 900],
      ],
      maxBytes: 1_000_000,
      limits: { quotaBytes: 1_000_000 },
    });
    expect(out).toEqual({
      ok: true,
      missing: [ID(3)],
      present: [
        [ID(1), 500],
        [ID(2), 700],
      ],
    });
    expect(fileUsage(s.getUsage()).reservedBytes).toBe(700 + 900);
    expect(s.getUpload("up_a")?.reservedBytes).toBe(200 + 700 + 900);
    expect(s.chunkPinned("saves", ID(1))).toBe(true);
    expect(s.chunkPinned("saves", ID(3))).toBe(true);
    // Re-naming moves nothing; a chunk that arrived since is now present, and reserves nothing more.
    s.putChunk(chunk(3, 900));
    const again = planChunks(s, {
      upload: s.getUpload("up_a") as UploadRow,
      chunks: [[ID(3), 900]],
      maxBytes: 1_000_000,
      limits: { quotaBytes: 1_000_000 },
    });
    expect(again).toMatchObject({ ok: true, missing: [] });
    expect(fileUsage(s.getUsage()).reservedBytes).toBe(700 + 900);
  });
});
